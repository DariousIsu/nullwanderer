/**
 * lib/subconscious.js — tiered between-turn cognition: LOCAL volume + CLOUD depth, SOURCE-GROUNDED,
 * cost-bounded. (Front/Cortex: the cloud reasoner THINKS on merit; the local model carries the
 * volume so her stream never goes quiet.)
 *
 * Why: routing EVERY idle tick to the cloud reasoner (gpt-oss:120b, num_predict≥700) costs ~400k
 * tok/active-hour. Most idle mentation is shallow; a 120B pass is worth it only sometimes. This:
 *   1. TRIAGE — score each tick on signals the tick already has (active focus, a <wonder>, novelty,
 *      importance, thread-review) and send only the ones that earn it to the cloud; the rest stay
 *      local (free, same cadence).
 *   2. SOURCE SUPPORT — ground every CLOUD pass in retrieved snippets from her own memory/knowledge,
 *      and instruct it to lean on + mark them (the most-capable layer is also the most prone to
 *      confident confabulation — anchor it). Synthesis is grounded the same way.
 *   3. SYNTHESIS — periodically one cloud call steps back across the recent local stream to find the
 *      thread worth pursuing (cross-thought depth per-tick deepening misses); may seed a focus.
 *   4. BUDGET — a rolling tokens/hour ceiling; over budget → fail-safe to LOCAL until the window rolls.
 *
 * Pure + deps-injected: every external (now / getMeta / setMeta / search / complete) is passed in,
 * so the whole brain is offline-testable with no model, network, or db. Live wiring lives in
 * monologue.js (the tick) — this module only DECIDES and BUILDS PROMPTS; it never calls a model.
 */
'use strict';

const DEFAULT_THRESHOLD = 3;
const DEFAULT_SYNTH_MIN = 20;
const DEFAULT_BUDGET_TOKPH = 120000;
const BUDGET_KEY = 'subc.budget.window';   // JSON [[ts,tokens],...], rolling 1h
const SYNTH_AT_KEY = 'subc.synth.lastAt';

// --- 1. MERIT ---------------------------------------------------------------
// novelty/importance are 0..1 (novelty = 1 - cosineToRecentThoughts; importance = scored salience).
function meritScore({ mode, activeFocus, wonder, novelty = 0, importance = 0 } = {}) {
  let s = 0; const why = [];
  if (activeFocus) { s += 3; why.push('focus'); }            // directed thinking deserves the reasoner
  if (wonder) { s += 3; why.push('wonder'); }                // her own "want my larger self on this" flag
  if (mode === 'thread-review') { s += 2; why.push('thread-review'); }
  if (novelty >= 0.6) { s += 2; why.push('novel'); } else if (novelty >= 0.4) { s += 1; why.push('newish'); }
  if (importance >= 0.7) { s += 2; why.push('important'); } else if (importance >= 0.5) { s += 1; why.push('salient'); }
  return { score: s, reasons: why };
}

// --- 2. TIER DECISION -------------------------------------------------------
// mode: hybrid|triage (merit-gated) · local|off (never cloud) · all (always cloud, still budget-gated)
function decideTier(signals = {}, { threshold = DEFAULT_THRESHOLD, budgetOk = true, mode = 'hybrid' } = {}) {
  if (mode === 'local' || mode === 'off') return { tier: 'local', reason: 'mode=local' };
  if (mode === 'all') return { tier: budgetOk ? 'cloud' : 'local', reason: budgetOk ? 'mode=all' : 'budget-exhausted' };
  const m = meritScore(signals);                              // hybrid / triage
  if (!budgetOk) return { tier: 'local', reason: 'budget-exhausted', merit: m };
  if (m.score >= threshold) return { tier: 'cloud', reason: 'merit:' + (m.reasons.join('+') || 'none'), merit: m };
  return { tier: 'local', reason: 'below-threshold', merit: m };
}

// --- 4. BUDGET (rolling 1h window) -----------------------------------------
function _window(getMeta, now) {
  let arr = [];
  try { arr = JSON.parse((getMeta && getMeta(BUDGET_KEY)) || '[]'); } catch {}
  const cutoff = now - 3600 * 1000;
  return (Array.isArray(arr) ? arr : []).filter(e => Array.isArray(e) && e[0] >= cutoff);
}
function spentLastHour(getMeta, now) { return _window(getMeta, now).reduce((a, e) => a + (e[1] || 0), 0); }
function budgetOk(getMeta, now, capPerHour = DEFAULT_BUDGET_TOKPH) {
  if (!capPerHour || capPerHour <= 0) return true;           // 0/unset → uncapped
  return spentLastHour(getMeta, now) < capPerHour;
}
function recordSpend({ getMeta, setMeta, now, tokens }) {
  const arr = _window(getMeta, now);
  arr.push([now, Math.max(0, tokens | 0)]);
  try { setMeta(BUDGET_KEY, JSON.stringify(arr)); } catch {}
  return arr.reduce((a, e) => a + (e[1] || 0), 0);
}
// Rough token estimate when the model didn't report usage (chars/4).
function estimateTokens(messages, outText) {
  const inChars = (messages || []).reduce((a, m) => a + String((m && m.content) || '').length, 0);
  return Math.round((inChars + String(outText || '').length) / 4);
}

// --- 2b. SOURCE SUPPORT -----------------------------------------------------
// search(query, k) → rows from her memory/knowledge (injected). Returns compact, ref-tagged sources.
async function retrieveSources(seedText, { search, k = 4 } = {}) {
  if (!seedText || typeof search !== 'function') return [];
  let rows = [];
  try { rows = (await search(String(seedText).slice(0, 400), k)) || []; } catch { return []; }
  return (Array.isArray(rows) ? rows : []).slice(0, k).map((r, i) => ({
    ref: 'S' + (i + 1),
    content: String((r && (r.content || r.text)) || r || '').replace(/\s+/g, ' ').slice(0, 300),
    source: (r && (r.source || r.kind)) || 'memory'
  })).filter(s => s.content.length > 4);
}
function buildGroundingBlock(sources) {
  if (!sources || !sources.length) return '';
  const lines = sources.map(s => `[${s.ref}] (${s.source}) ${s.content}`).join('\n');
  return 'GROUND YOUR THINKING IN THESE SOURCES FROM YOUR OWN MEMORY. Build on them; when a claim '
    + 'leans on one, mark it like [' + sources[0].ref + ']. Do NOT invent specifics beyond them — if '
    + 'they do not cover something, reason openly but do not assert facts you cannot support.\n' + lines;
}

// --- 3. SYNTHESIS -----------------------------------------------------------
function shouldSynthesize({ getMeta, now, intervalMin = DEFAULT_SYNTH_MIN } = {}) {
  let last = 0;
  try { last = parseInt((getMeta && getMeta(SYNTH_AT_KEY)) || '0', 10) || 0; } catch {}
  return (now - last) >= intervalMin * 60 * 1000;
}
function markSynthesized({ setMeta, now }) { try { setMeta && setMeta(SYNTH_AT_KEY, String(now)); } catch {} }

function buildSynthesisPrompt({ recentThoughts = [], threads = [], focus = null, sources = [] } = {}) {
  const t = recentThoughts.slice(-12)
    .map((x, i) => `${i + 1}. ${String((x && x.content) || x || '').replace(/\s+/g, ' ').slice(0, 200)}`)
    .filter(s => s.length > 4).join('\n');
  const th = threads.slice(0, 5).map(x => '• ' + String((x && x.content) || x || '').replace(/\s+/g, ' ').slice(0, 120)).join('\n');
  const grounding = buildGroundingBlock(sources);
  return 'These are your recent between-turn thoughts:\n' + (t || '(none)')
    + (th ? '\n\nOpen threads:\n' + th : '')
    + (focus ? '\n\nActive focus: ' + String((focus && focus.content) || focus).slice(0, 160) : '')
    + (grounding ? '\n\n' + grounding : '')
    + '\n\nStep back. Across these, what is the ONE real thread, tension, or question worth pursuing? '
    + 'Think it through in depth (do not just summarize), grounded in your sources. End with a single '
    + '<wonder>...</wonder> if a genuine question pulls at you, or one concrete next step.';
}

module.exports = {
  meritScore, decideTier,
  spentLastHour, budgetOk, recordSpend, estimateTokens,
  retrieveSources, buildGroundingBlock,
  shouldSynthesize, markSynthesized, buildSynthesisPrompt,
  DEFAULT_THRESHOLD, DEFAULT_SYNTH_MIN, DEFAULT_BUDGET_TOKPH, BUDGET_KEY, SYNTH_AT_KEY
};
