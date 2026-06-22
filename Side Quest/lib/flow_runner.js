/**
 * Flow runner — Zoe's PROCEDURAL replay engine. Generalizes the hardcoded
 * play_session.js stepper into a data-driven runner: a recipe is a JSON list of
 * steps, each a LOCATOR DESCRIPTOR + action. The runner rebuilds each locator live
 * against the current DOM (patchright/Playwright locators re-resolve on every use),
 * so authoring AND replay need ZERO model inference — exactly the Stagehand/Skyvern
 * "observe→act, cache the descriptor, replay deterministically" pattern.
 *
 * The 24B only re-enters on a genuinely broken step (after the deterministic heal
 * ladder is exhausted) via an optional ctx.modelHeal hook — never on a clean replay.
 *
 * Recipe shape (see recipes/*.json):
 *   { site, task, fingerprint?, steps: [ {action, locator?, fallbacks?, value?, url?} ] }
 * Step actions: navigate | fill | click | scroll | waitFor | read.
 * Locator descriptor (primary): { method: 'getByRole'|'getByText'|'getByLabel'|
 *   'getByPlaceholder'|'getByTestId', role?, name?, text?, placeholder?, testid? }
 * Fallback descriptor (shape-tagged): { css } | { testid } | { text } | { xpath }.
 * value/url support {{var}} substitution from the `vars` map (e.g. {{title}}).
 *
 * The runner takes a Playwright/patchright `page` directly — it does NOT depend on
 * lib/web.js, so it's unit-testable with a mock page (scripts/smoke_flow_runner.js).
 */

const blockers = require('./blockers');

const NAV_TIMEOUT = 20000;
const RESOLVE_TIMEOUT = 1500;

function withTimeout(promise, ms, fallback) {
  let t;
  const timeout = new Promise((res) => { t = setTimeout(() => res(fallback), ms); });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), timeout]).finally(() => clearTimeout(t));
}

// {{var}} substitution. Unknown vars collapse to '' (a missing optional field).
function subst(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars && k in vars) ? String(vars[k]) : '');
}

/**
 * Build a live locator from a descriptor. Handles BOTH the primary method-based
 * form ({method:'getByRole', role, name}) and the shape-tagged fallback form
 * ({css}|{testid}|{text}|{xpath}). Returns a Playwright locator or null.
 */
function buildLocator(page, desc) {
  if (!desc || !page) return null;
  try {
    switch (desc.method) {
      case 'getByRole':        return page.getByRole(desc.role, desc.name != null ? { name: desc.name } : undefined);
      case 'getByText':        return page.getByText(desc.text, { exact: false });
      case 'getByLabel':       return page.getByLabel(desc.name || desc.label);
      case 'getByPlaceholder': return page.getByPlaceholder(desc.placeholder || desc.name);
      case 'getByTestId':      return page.getByTestId(desc.testid || desc.name);
    }
    // fallback shapes
    if (desc.css)    return page.locator(desc.css);
    if (desc.xpath)  return page.locator(`xpath=${desc.xpath}`);
    if (desc.testid) return page.getByTestId(desc.testid);
    if (desc.text)   return page.getByText(desc.text, { exact: false });
  } catch { /* fall through */ }
  return null;
}

// A descriptor "resolves" if its locator matches ≥1 element right now.
async function resolves(loc) {
  if (!loc) return false;
  const n = await withTimeout(Promise.resolve(loc.count()), RESOLVE_TIMEOUT, 0).catch(() => 0);
  return n > 0;
}

/**
 * Resolve a step's target through the deterministic heal ladder:
 *   1. primary descriptor
 *   2. each fallback in order (role+name → testid → css → text/xpath)
 *   3. re-derive by role+name: if primary was getByRole, retry role-only and take
 *      the first match (the ARIA-snapshot re-derive, simplified — role is the stable
 *      part; the accessible NAME is what drifts).
 *   4. ctx.modelHeal(page, step) — the LAST resort, the only place the 24B re-enters.
 * Returns { loc, desc, healed } or null.
 */
async function resolveTarget(page, step, ctx = {}) {
  const candidates = [step.locator, ...(step.fallbacks || [])].filter(Boolean);
  for (let i = 0; i < candidates.length; i++) {
    const loc = buildLocator(page, candidates[i]);
    if (await resolves(loc)) return { loc, desc: candidates[i], healed: i > 0 };
  }
  // tier 3: role-only re-derive
  if (step.locator && step.locator.method === 'getByRole' && step.locator.role) {
    const loc = buildLocator(page, { method: 'getByRole', role: step.locator.role });
    if (await resolves(loc)) return { loc: loc.first ? loc.first() : loc, desc: { method: 'getByRole', role: step.locator.role }, healed: true };
  }
  // tier 4: model-last (optional)
  if (typeof ctx.modelHeal === 'function') {
    try {
      const desc = await ctx.modelHeal(page, step);
      const loc = buildLocator(page, desc);
      if (await resolves(loc)) return { loc, desc, healed: true, byModel: true };
    } catch { /* give up below */ }
  }
  return null;
}

// Run blocker detection after a navigation; returns the blocker (or null). `resp`
// may be null. Injectable via ctx.detect for testing.
async function checkBlocker(page, resp, step, ctx) {
  const detect = ctx.detect || blockers.detect;
  try { return await detect(page, resp, { expectedLogin: !!step.expectLogin }); }
  catch { return null; }
}

/**
 * Execute ONE step. Returns { ok, action, healed?, byModel?, blocker?, reason?, text? }.
 * A needsHuman blocker short-circuits with ok:false + blocker set (caller pauses).
 */
async function runStep(page, step, vars = {}, ctx = {}) {
  const action = step.action;

  if (action === 'navigate') {
    const url = subst(step.url, vars);
    let resp = null;
    try { resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); }
    catch (err) { return { ok: false, action, reason: `navigate failed: ${err.message}` }; }
    const blocker = await checkBlocker(page, resp, step, ctx);
    if (blocker && blocker.needsHuman) return { ok: false, action, blocker, reason: `blocked: ${blocker.type}` };
    return { ok: true, action, url: (() => { try { return page.url(); } catch { return url; } })() };
  }

  if (action === 'scroll') {
    try {
      await withTimeout(Promise.resolve(page.evaluate((d) => window.scrollBy(0, d * Math.round(window.innerHeight * 0.9)), /up|top/i.test(step.dir || '') ? -1 : 1)), 2500, null);
      return { ok: true, action };
    } catch (err) { return { ok: false, action, reason: err.message }; }
  }

  if (action === 'read') {
    try {
      const text = await withTimeout(Promise.resolve(page.innerText('body')), 5000, '');
      return { ok: true, action, text: (text || '').slice(0, step.cap || 4000) };
    } catch (err) { return { ok: false, action, reason: err.message }; }
  }

  // fill / click / waitFor all need a resolved target
  const target = await resolveTarget(page, step, ctx);
  if (!target) {
    // An OPTIONAL step that can't be located is skipped, not failed — e.g. a "mute mic"
    // toggle that's already off / not present. Required steps still fail the recipe.
    if (step.optional) return { ok: true, action, skipped: true };
    return { ok: false, action, reason: `could not locate target for ${action} (${describe(step.locator)})` };
  }
  const { healed, byModel } = target;
  // A step acts on ONE element. Narrow to the first match so a broad selector that
  // resolves to several elements (common on heavy SPAs like Meet) clicks/fills the
  // first instead of throwing a Playwright strict-mode violation.
  const loc = target.loc && target.loc.first ? target.loc.first() : target.loc;

  try {
    if (action === 'waitFor') {
      const ok = await resolves(loc);
      return { ok, action, healed, byModel, reason: ok ? undefined : 'not present' };
    }
    if (action === 'fill') {
      await (loc.scrollIntoViewIfNeeded ? loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {}) : Promise.resolve());
      await loc.fill(subst(step.value, vars), { timeout: 5000 });
      return { ok: true, action, healed, byModel };
    }
    if (action === 'click') {
      await (loc.scrollIntoViewIfNeeded ? loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {}) : Promise.resolve());
      await loc.click({ timeout: 5000 });
      // a click can navigate (e.g. Publish) — check for a blocker that appeared
      if (step.mayNavigate) {
        const blocker = await checkBlocker(page, null, step, ctx);
        if (blocker && blocker.needsHuman) return { ok: false, action, blocker, reason: `blocked: ${blocker.type}` };
      }
      return { ok: true, action, healed, byModel };
    }
  } catch (err) { return { ok: false, action, healed, byModel, reason: `${action} failed: ${err.message}` }; }

  return { ok: false, action, reason: `unknown action ${action}` };
}

function describe(desc) {
  if (!desc) return 'no descriptor';
  if (desc.method === 'getByRole') return `${desc.role}"${desc.name || ''}"`;
  return desc.css || desc.testid || desc.text || desc.xpath || desc.method || '?';
}

/**
 * Run a whole recipe. Returns:
 *   { ok, ran, healed, results, blocker?, atStep?, reason? }
 * On a needsHuman blocker it STOPS at that step and returns blocker+atStep so the
 * caller can pause the flow, persist state, and ping Lucas (then resume later).
 * ctx: { detect?, modelHeal?, onStep?(info) }
 */
async function runRecipe(page, recipe, vars = {}, ctx = {}) {
  if (!recipe || !Array.isArray(recipe.steps)) return { ok: false, reason: 'invalid recipe' };
  const results = [];
  let healed = 0;
  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i];
    const r = await runStep(page, step, vars, ctx);
    results.push(r);
    if (r.healed) healed++;
    if (typeof ctx.onStep === 'function') { try { ctx.onStep({ index: i, step, result: r }); } catch {} }
    if (r.blocker && r.blocker.needsHuman) {
      return { ok: false, ran: i, healed, results, blocker: r.blocker, atStep: i, reason: `blocked at step ${i}: ${r.blocker.type}` };
    }
    if (!r.ok) {
      return { ok: false, ran: i, healed, results, atStep: i, reason: r.reason || `step ${i} failed` };
    }
  }
  return { ok: true, ran: recipe.steps.length, healed, results };
}

module.exports = { runRecipe, runStep, buildLocator, resolveTarget, subst, describe };
