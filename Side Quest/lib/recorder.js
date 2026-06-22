/**
 * Recipe recorder — record-by-demonstration. Captures a walk through a site ONCE and
 * emits a recipes/*.json descriptor that flow_runner.js replays with ZERO model calls.
 *
 * Two capture paths feed ONE assembly core:
 *   1. DEMONSTRATION — Lucas drives her browser; in-page listeners (installed via
 *      page.addInitScript + page.exposeFunction, the Playwright-native path — NOT
 *      connectOverCDP+Runtime.enable, which would re-light the CDP bot signal patchright
 *      suppresses) compute a durable descriptor for each clicked/filled element and ship
 *      it back to Node.
 *   2. PASSIVE — she drives herself; web.js calls recordLocator() on each of her own
 *      successful click/type actions, computing the SAME descriptor from the live locator.
 *
 * Descriptor shape mirrors flow_runner exactly: a primary {method:'getByRole',role,name}
 * (or getByPlaceholder/getByLabel/getByTestId) plus a fallback chain
 * (role+name → testid → css → text → xpath). Selectors are PROVISIONAL → recipes are
 * written verified:false until a live replay confirms or the heal ladder repairs them.
 *
 * The pure assembly core (buildDescriptor / eventToStep / dedupeSteps / assembleRecipe)
 * takes no browser, so it's unit-testable with mock elements (scripts/smoke_recorder.js).
 */

const fs = require('fs');
const path = require('path');
const recipeStore = require('./recipe_store');

const MAX_NAME = 80;
const MAX_TEXT = 60;
// A navigation that lands within this window after a click is the RESULT of that click
// (Continue/Publish), not a separate address-bar navigation — fold it into mayNavigate.
const CLICK_NAV_WINDOW_MS = 2500;

/* ────────────────────────────── in-page descriptor ──────────────────────────────
 * SELF-CONTAINED on purpose: this exact function is (a) called directly in tests,
 * (b) serialized via .toString() into addInitScript for demonstration capture, and
 * (c) handed to locator.evaluate() for passive capture. Playwright serializes only the
 * single function body — it cannot reach module-scope helpers — so everything it needs
 * is defined inside. Uses defensive DOM access so a mock element with getAttribute/
 * tagName/textContent satisfies it too.
 */
function computeDescriptor(el) {
  if (!el || el.nodeType !== 1) return null;
  var cap = function (s, n) { s = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) : s; };
  var attr = function (a) { try { return (el.getAttribute && el.getAttribute(a)) || ''; } catch (e) { return ''; } };
  var tag = (el.tagName || '').toLowerCase();
  var type = (attr('type') || '').toLowerCase();
  var explicitRole = attr('role');

  function implicitRole() {
    if (tag === 'a' && el.getAttribute && el.getAttribute('href') != null) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (['submit', 'button', 'reset', 'image'].indexOf(type) >= 0) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return '';
  }
  var role = explicitRole || implicitRole() || '';

  function labelText() {
    try {
      var id = attr('id');
      if (id && el.ownerDocument && el.ownerDocument.querySelector) {
        var esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
        var lab = el.ownerDocument.querySelector('label[for="' + esc + '"]');
        if (lab) return lab.textContent;
      }
      if (el.closest) { var wrap = el.closest('label'); if (wrap) return wrap.textContent; }
    } catch (e) {}
    return '';
  }
  var isButtonish = (tag === 'button' || tag === 'a' || role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab' || role === 'option');
  var name = cap(
    attr('aria-label') ||
    labelText() ||
    attr('alt') ||
    ((tag === 'input' && ['submit', 'button', 'reset'].indexOf(type) >= 0) ? attr('value') : '') ||
    (isButtonish ? (el.textContent || '') : '') ||
    attr('title') || '', MAX_NAME);

  var placeholder = cap(attr('placeholder'), MAX_NAME);
  var testid = attr('data-testid') || attr('data-test') || attr('data-cy') || '';
  var id = attr('id');
  var text = cap(el.textContent || '', MAX_TEXT);
  var isPassword = (tag === 'input' && type === 'password');

  function isStableToken(s) { return /^[A-Za-z][\w-]*$/.test(s) && !/^(css|sc|jsx|emotion|MuiBox|chakra)-?[0-9a-f]{4,}$/i.test(s); }
  function cssSel() {
    if (id && isStableToken(id)) return (tag || '*') + '#' + id;
    if (testid) return '[data-testid="' + testid.replace(/"/g, '\\"') + '"]';
    var cls = '';
    try {
      var raw = (typeof el.className === 'string' ? el.className : attr('class')) || '';
      var stable = raw.split(/\s+/).filter(function (c) { return c && isStableToken(c); }).slice(0, 2);
      if (stable.length) cls = '.' + stable.join('.');
    } catch (e) {}
    return (tag || '*') + cls;
  }
  function xpathOf() {
    try {
      if (!el.ownerDocument) return '';
      var parts = [], node = el;
      while (node && node.nodeType === 1 && parts.length < 8) {
        var ix = 1, sib = node.previousSibling;
        while (sib) { if (sib.nodeType === 1 && sib.tagName === node.tagName) ix++; sib = sib.previousSibling; }
        parts.unshift(node.tagName.toLowerCase() + '[' + ix + ']');
        if (node.tagName.toLowerCase() === 'body') break;
        node = node.parentNode;
      }
      return '/' + parts.join('/');
    } catch (e) { return ''; }
  }

  return { tag: tag, type: type, role: role, name: name, placeholder: placeholder, testid: testid, id: id, css: cssSel(), text: text, xpath: xpathOf(), isPassword: isPassword };
}

/* ────────────────────────────── pure assembly core ────────────────────────────── */

// info (from computeDescriptor) → { primary, fallbacks } in flow_runner's descriptor
// vocabulary. Primary prefers the most stable, human-meaningful handle; fallbacks list
// the rest in the runner's heal-ladder order so a drifted primary can self-repair.
function buildDescriptor(info) {
  if (!info) return null;
  const byRoleName = (info.role && info.name) ? { method: 'getByRole', role: info.role, name: info.name } : null;
  const byPlaceholder = info.placeholder ? { method: 'getByPlaceholder', placeholder: info.placeholder } : null;
  const byTestId = info.testid ? { method: 'getByTestId', testid: info.testid } : null;
  const byRole = info.role ? { method: 'getByRole', role: info.role } : null;
  const byCss = info.css ? { css: info.css } : null;
  const byText = (info.text && info.text.length >= 2) ? { text: info.text } : null;
  const byXpath = info.xpath ? { xpath: info.xpath } : null;

  // primary preference: role+name (most durable) > placeholder (inputs) > testid > role-only > css > text
  const primary = byRoleName || byPlaceholder || byTestId || byRole || byCss || byText || byXpath;
  if (!primary) return null;

  // fallbacks: every OTHER candidate, in heal order, minus whatever became primary.
  const ordered = [byRoleName, byPlaceholder, byTestId, byCss, byText, byXpath].filter(Boolean);
  const key = (d) => JSON.stringify(d);
  const seen = new Set([key(primary)]);
  const fallbacks = [];
  for (const d of ordered) { const k = key(d); if (!seen.has(k)) { seen.add(k); fallbacks.push(d); } }
  return { primary, fallbacks };
}

// A captured value that must NOT be baked into a recipe (credentials). Returns true if
// the value should be dropped — recipes never carry passwords; replay asks Lucas to sign in.
function isSecret(info) {
  if (!info) return false;
  if (info.isPassword) return true;
  const hay = `${info.name || ''} ${info.placeholder || ''} ${info.id || ''} ${info.testid || ''}`.toLowerCase();
  return /\b(password|passwd|pwd|otp|2fa|mfa|cvv|card\s*number|secret)\b/.test(hay);
}

// One captured event → one runner step (or null to drop). ev: { kind:'click'|'fill'|
// 'navigate', info?, value?, url? }.
function eventToStep(ev) {
  if (!ev) return null;
  if (ev.kind === 'navigate') {
    if (!ev.url) return null;
    return { action: 'navigate', url: ev.url };
  }
  const built = buildDescriptor(ev.info);
  if (!built) return null;
  const step = { action: ev.kind === 'fill' ? 'fill' : 'click', locator: built.primary };
  if (built.fallbacks.length) step.fallbacks = built.fallbacks;
  if (ev.kind === 'fill') {
    // Never persist a credential; mark the field needsHuman so replay pauses for sign-in.
    // optional+needsHuman: if Lucas is already signed in the field is absent (skipped);
    // if it's present at replay, flow_runner pauses and asks him to sign in.
    if (isSecret(ev.info)) { step.value = ''; step.needsHuman = true; step.optional = true; }
    else step.value = ev.value != null ? String(ev.value) : '';
  }
  return step;
}

// Stable signature for a step's TARGET (ignores value) — used to collapse repeated fills.
function targetSig(step) {
  return step && step.locator ? JSON.stringify(step.locator) : `__${step && step.action}`;
}

/**
 * Tidy a raw step list into a clean recipe body:
 *   - drop a navigate that merely repeats the current URL,
 *   - collapse consecutive fills on the SAME target → keep the last value (final keystroke),
 *   - fold a navigate that immediately follows a click into that click's mayNavigate flag
 *     (a click-induced navigation isn't a user step) — EXCEPT the leading navigate (the open).
 */
function dedupeSteps(rawSteps) {
  const steps = (rawSteps || []).filter(Boolean);
  const out = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    if (step.action === 'navigate') {
      if (prev && prev.action === 'navigate' && prev.url === step.url) continue;          // identical repeat
      if (prev && prev.action === 'click' && out.length > 0 && hasRealNav(out)) {           // click-induced nav
        prev.mayNavigate = true; continue;
      }
      out.push({ ...step });
      continue;
    }
    if (step.action === 'fill' && prev && prev.action === 'fill' && targetSig(prev) === targetSig(step)) {
      prev.value = step.value; prev.needsHuman = step.needsHuman || prev.needsHuman;        // keep latest value
      continue;
    }
    out.push({ ...step });
  }
  return out;
}
// true once at least one navigate step already exists (so we keep the FIRST nav as the open).
function hasRealNav(out) { return out.some(s => s.action === 'navigate'); }

// site/task → file stem matching the existing recipes/ naming (substack.com+publish_post
// → substack_publish_post). Strips scheme/TLD/punctuation.
function slugify(site, task) {
  const s = String(site || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\.[a-z.]+$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const t = String(task || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return [s, t].filter(Boolean).join('_') || 'recipe';
}

// Assemble the final recipe object the store/runner consume.
function assembleRecipe({ site, task, steps, source, firstUrl }) {
  const clean = dedupeSteps(steps);
  let host = '';
  try { host = firstUrl ? new URL(firstUrl).hostname.replace(/^www\./, '') : ''; } catch {}
  const recipe = {
    site: site || host || 'unknown',
    task: task || 'flow',
    verified: false,                 // provisional until a live replay confirms / heals
    source: source || 'recorder',    // 'demonstration' | 'passive'
    steps: clean
  };
  if (host) recipe.fingerprint = { url_pattern: host };
  return recipe;
}

/* ────────────────────────────── persistence ────────────────────────────── */

// Write a recorded recipe. NEVER clobbers a VERIFIED recipe — a confirmed hand-tuned
// recipe outranks a fresh recording; that case writes <stem>.recorded.json instead and
// flags it for review. Returns { ok, file, stem, shadowed?, reason? }.
function save(recipe, { stem, dir } = {}) {
  if (!recipe || !Array.isArray(recipe.steps) || !recipe.steps.length) return { ok: false, reason: 'empty recipe' };
  const fileStem = stem || slugify(recipe.site, recipe.task);
  dir = dir || recipeStore.RECIPES_DIR;
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
  let target = path.join(dir, `${fileStem}.json`);
  let shadowed = false;
  try {
    if (fs.existsSync(target)) {
      const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (existing && existing.verified === true) { target = path.join(dir, `${fileStem}.recorded.json`); shadowed = true; }
    }
  } catch {}
  try {
    fs.writeFileSync(target, JSON.stringify(recipe, null, 2) + '\n', 'utf8');
    return { ok: true, file: target, stem: path.basename(target, '.json'), shadowed };
  } catch (err) { return { ok: false, reason: err.message }; }
}

/* ────────────────────────────── live: shared session ──────────────────────────────
 * A recording SESSION is just an ordered event buffer + metadata. Both capture paths
 * push events into it; finalize() turns it into a recipe via the pure core.
 */
function newSession({ site, task, source } = {}) {
  return { site: site || '', task: task || '', source: source || 'recorder', events: [], firstUrl: '', lastClickTs: 0, lastNavTs: 0, active: true };
}

function pushNavigate(session, url, ts) {
  if (!session || !session.active || !url) return;
  if (!/^https?:\/\//i.test(url)) return;
  if (!session.firstUrl) session.firstUrl = url;
  const last = session.events[session.events.length - 1];
  if (last && last.kind === 'navigate' && last.url === url) return;
  session.events.push({ kind: 'navigate', url, ts: ts || 0 });
  session.lastNavTs = ts || 0;
}

function pushElement(session, info, kind, value, ts) {
  if (!session || !session.active || !info) return;
  if (kind === 'click') session.lastClickTs = ts || 0;
  session.events.push({ kind, info, value, ts: ts || 0 });
}

function finalize(session) {
  if (!session) return null;
  session.active = false;
  const steps = session.events.map(eventToStep);
  return assembleRecipe({ site: session.site, task: session.task, steps, source: session.source, firstUrl: session.firstUrl });
}

// How many real action steps a session would yield (gates passive auto-save — single
// clicks are noise, not a procedure worth keeping).
function actionStepCount(session) {
  if (!session) return 0;
  return dedupeSteps(session.events.map(eventToStep)).filter(s => s.action === 'click' || s.action === 'fill').length;
}

/* ────────────────────────────── live: demonstration (in-page) ──────────────────────────────
 * Installs DOM listeners in HER patchright page that compute the descriptor IN-PAGE and
 * ship it to Node through an exposed function. addInitScript re-installs on every
 * navigation; we also inject once into the current document so recording starts immediately.
 */
const BINDING = '__sqRecordStep';

function buildInitScript() {
  // The listener computes the descriptor in-page (computeDescriptor inlined) and forwards
  // {kind,info,value} to Node. Guarded so it installs once per document.
  return `(() => {
    if (window.__sqRecInstalled) return; window.__sqRecInstalled = true;
    const computeDescriptor = ${computeDescriptor.toString()};
    const send = (kind, el, value) => {
      try { const info = computeDescriptor(el); if (info && window.${BINDING}) window.${BINDING}({ kind, info, value }); } catch (e) {}
    };
    const actionable = (el) => {
      if (!el || el.nodeType !== 1) return null;
      return el.closest('a,button,input,textarea,select,[role],[onclick],[tabindex],[contenteditable]') || el;
    };
    document.addEventListener('click', (e) => { const el = actionable(e.target); if (el) send('click', el); }, true);
    const onCommit = (e) => {
      const el = e.target; if (!el) return;
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || el.isContentEditable) {
        const v = el.isContentEditable ? (el.innerText || el.textContent || '') : (el.value || '');
        send('fill', el, v);
      }
    };
    document.addEventListener('change', onCommit, true);
    document.addEventListener('blur', onCommit, true);
  })();`;
}

// Start a demonstration recording on a live page. Returns the session. The caller
// (web.js) keeps it; stop() finalizes + saves.
async function startDemonstration(page, { site, task } = {}) {
  const session = newSession({ site, task, source: 'demonstration' });
  try {
    // exposeFunction is idempotent-unsafe (throws if already bound) — guard it.
    if (!page.__sqBound) {
      await page.exposeFunction(BINDING, (payload) => {
        try {
          if (!session.active || !payload) return;
          const ts = Date.now();
          if (payload.kind === 'fill') pushElement(session, payload.info, 'fill', payload.value, ts);
          else pushElement(session, payload.info, 'click', undefined, ts);
        } catch {}
      });
      page.__sqBound = true;
    }
    await page.addInitScript({ content: buildInitScript() });
    // current document already loaded → inject now so recording is live immediately.
    try { await page.evaluate(buildInitScript()); } catch {}
    try { pushNavigate(session, page.url(), Date.now()); } catch {}
    // capture click-induced + manual navigations.
    page.on('framenavigated', (frame) => {
      try { if (frame === page.mainFrame()) pushNavigate(session, frame.url(), Date.now()); } catch {}
    });
  } catch (err) {
    session.startError = err.message;
  }
  return session;
}

/* ────────────────────────────── live: passive (locator) ──────────────────────────────
 * web.js calls this on each of HER OWN successful click/type actions. Computes the same
 * descriptor from the resolved Playwright locator (one element, one cheap evaluate).
 */
async function recordLocator(session, loc, kind, value) {
  if (!session || !session.active || !loc) return;
  try {
    const info = await loc.evaluate(computeDescriptor);
    if (info) pushElement(session, info, kind, value, Date.now());
  } catch {}
}

// Compute a descriptor from a live locator WITHOUT pushing — for capture-before-act
// (a click can detach its own element, so we snapshot the descriptor first, then push
// only if the action succeeds). Returns info or null.
async function captureLocator(loc) {
  if (!loc) return null;
  try { return await loc.evaluate(computeDescriptor); } catch { return null; }
}

module.exports = {
  // pure core
  computeDescriptor, buildDescriptor, eventToStep, dedupeSteps, assembleRecipe, isSecret, slugify, save,
  // session
  newSession, pushNavigate, pushElement, finalize, actionStepCount,
  // live
  startDemonstration, recordLocator, captureLocator, buildInitScript, BINDING
};
