/**
 * Capability self-test (Tier 1) — Zoe smoke-tests her OWN pathways so her self-knowledge
 * is grounded in proof, not vibes. This is the antidote to her single worst failure mode:
 * denying a capability she actually has ("I can't open a browser / I don't have file
 * access"). After a green self-check, her awareness block can state plainly "I verified my
 * pathways — all green," and the voice guard / capability-doubt layers have ground truth.
 *
 * It is MODEL-FREE and cheap: every check is a deterministic, synchronous probe, so it can
 * run inline on an idle tick without burning a 24B turn. Three families:
 *   1. ACTION PATHWAYS — for each active recipe card entry, run its live-parser check on
 *      its own canonical tag (recipes.activeRecipes()[].check(emit)). A red here means the
 *      grammar drifted from what the dispatcher accepts — the recipe card would be lying.
 *   2. RECIPE FILES — every recipes/*.json loads and is flow_runner-shaped.
 *   3. CORE MODULES — the tool modules that AREN'T on the recipe card (recorder,
 *      flow_runner, recipe_store) load and expose their key surface.
 *
 * Outputs: a ledger in meta (capability_self_check), an awareness one-liner, and — only on
 * RED — a surfaced reading + a deduped <gap> so a real breakage becomes a return-proposal.
 * Greens stay SILENT (surfacing discipline: don't talk just to report all-clear).
 */

const db = require('./db');
const recipesLib = require('./recipes');
const recipeStore = require('./recipe_store');
const gapsLib = require('./gaps');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // at most once per ~6h of uptime
const VALID_ACTIONS = new Set(['navigate', 'fill', 'click', 'scroll', 'waitFor', 'read']);
const LEDGER_KEY = 'capability_self_check';
const LAST_TS_KEY = 'last_self_check_ts';

// 1. Each advertised need→tag still parses through the REAL dispatcher parser.
function checkActionPathways() {
  let recipes;
  try { recipes = recipesLib.activeRecipes(); }
  catch (e) { return [{ name: 'action recipe card', status: 'red', detail: `activeRecipes threw: ${e.message}` }]; }
  return recipes.map(r => {
    let ok = false;
    try { ok = !!r.check(r.emit); } catch { ok = false; }
    return {
      name: `pathway: ${String(r.need || '').slice(0, 44)}`,
      status: ok ? 'green' : 'red',
      detail: ok ? '' : `parser no longer recognizes "${r.emit}"`
    };
  });
}

// 2. Every replayable recipe file is structurally valid for flow_runner.
function checkRecipeFiles() {
  let all;
  try { all = recipeStore.all(); }
  catch (e) { return { name: 'recipe files', status: 'red', detail: `recipe_store.all threw: ${e.message}` }; }
  const bad = [];
  for (const r of all) {
    const id = `${r.site || '?'}/${r.task || '?'}`;
    if (!Array.isArray(r.steps) || !r.steps.length) { bad.push(`${id}: no steps`); continue; }
    for (const s of r.steps) {
      if (!VALID_ACTIONS.has(s.action)) bad.push(`${id}: bad action "${s.action}"`);
      else if (s.action === 'navigate' && !s.url) bad.push(`${id}: navigate w/o url`);
      else if (['fill', 'click', 'waitFor'].includes(s.action) && !s.locator) bad.push(`${id}: ${s.action} w/o locator`);
    }
  }
  return {
    name: `recipe files (${all.length})`,
    status: bad.length ? 'red' : 'green',
    detail: bad.slice(0, 5).join('; ')
  };
}

// 3. Tool modules not covered by the recipe card load + expose their key surface.
const CORE_MODULES = [
  ['recorder', () => { const m = require('./recorder'); return typeof m.buildInitScript === 'function' && (m.buildInitScript() || '').length > 0 && typeof m.save === 'function'; }],
  ['flow_runner', () => { const m = require('./flow_runner'); return typeof m.runRecipe === 'function' && typeof m.buildLocator === 'function'; }],
  ['recipe_store', () => { const m = require('./recipe_store'); return typeof m.find === 'function' && typeof m.all === 'function'; }],
  ['own browser', () => { const m = require('./web'); return typeof m.open === 'function' && typeof m.runRecipe === 'function' && typeof m.startRecording === 'function'; }]
];
function checkCoreModules() {
  return CORE_MODULES.map(([name, probe]) => {
    let ok = false; let detail = '';
    try { ok = !!probe(); } catch (e) { ok = false; detail = e.message; }
    return { name: `module: ${name}`, status: ok ? 'green' : 'red', detail: ok ? '' : (detail || 'missing/altered export') };
  });
}

// Run the full Tier-1 sweep. Writes the ledger; on RED records a reading + gap (deduped).
// Returns { ts, total, green, red:[{name,detail}], allGreen }.
function run({ surface = true } = {}) {
  const results = [];
  try { results.push(...checkActionPathways()); } catch (e) { results.push({ name: 'action pathways', status: 'red', detail: e.message }); }
  try { results.push(checkRecipeFiles()); } catch (e) { results.push({ name: 'recipe files', status: 'red', detail: e.message }); }
  try { results.push(...checkCoreModules()); } catch (e) { results.push({ name: 'core modules', status: 'red', detail: e.message }); }

  const red = results.filter(r => r.status === 'red').map(r => ({ name: r.name, detail: r.detail }));
  const ledger = { ts: Date.now(), total: results.length, green: results.length - red.length, red, allGreen: red.length === 0 };

  try { db.setMeta(LEDGER_KEY, JSON.stringify(ledger)); db.setMeta(LAST_TS_KEY, String(ledger.ts)); } catch {}

  if (surface && red.length) {
    const summary = red.map(r => `${r.name}${r.detail ? ` (${r.detail})` : ''}`).join('; ');
    // a broken pathway is genuinely important — surface it as a reading + a deduped gap.
    try { db.insertMonologue({ content: `Self-check found a broken pathway: ${summary}`, model: 'self-check', type: 'reading', importance: 9 }); } catch {}
    try { gapsLib.recordOne(`A capability self-check found ${red.length} broken pathway(s): ${summary}`.slice(0, 240), 'investigate the parser/recipe that drifted and repair it', 'self-check'); } catch {}
    console.log(`[self-check] RED — ${red.length}/${results.length}: ${summary}`);
  } else {
    console.log(`[self-check] all green — ${ledger.green}/${ledger.total} pathways verified`);
  }
  return ledger;
}

// Throttle: due at boot (no prior ts) and then at most once per CHECK_INTERVAL_MS.
function due(now = Date.now()) {
  let last = 0;
  try { last = parseInt(db.getMeta(LAST_TS_KEY) || '0', 10) || 0; } catch {}
  return (now - last) >= CHECK_INTERVAL_MS;
}

function lastLedger() {
  try { return JSON.parse(db.getMeta(LEDGER_KEY) || 'null'); } catch { return null; }
}

// One-liner for the awareness block — grounds her self-knowledge. Only emitted for a
// while after the check (12h) so it doesn't go stale, and worded so a green result
// directly counters capability-denial.
function awarenessLine() {
  const l = lastLedger();
  if (!l || !l.ts) return null;
  const ageMs = Date.now() - l.ts;
  if (ageMs > 12 * 60 * 60 * 1000) return null;
  const hrs = Math.max(0, Math.round(ageMs / 3600000));
  const ago = hrs === 0 ? 'just now' : `${hrs}h ago`;
  if (l.allGreen) {
    return `Self-check (${ago}): all ${l.total} of your action pathways verified working — your browser, file, recipe, recorder and other tools are confirmed live. If you ever doubt you can do something, you just proved you can.`;
  }
  return `Self-check (${ago}): ${l.green}/${l.total} pathways green, ${l.red.length} need attention — ${l.red.map(r => r.name).join(', ')}.`;
}

module.exports = {
  run, due, lastLedger, awarenessLine,
  checkActionPathways, checkRecipeFiles, checkCoreModules,
  CHECK_INTERVAL_MS, LEDGER_KEY, LAST_TS_KEY
};
