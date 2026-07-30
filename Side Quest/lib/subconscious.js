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
// The `key` param lets an isolated lane keep its OWN spend window (the idle graph-walk uses
// GRAPHWALK_BUDGET_KEY so the noisy news/curation/forecast lanes can't starve it out of the shared
// pool). Defaults to BUDGET_KEY → every existing caller is unchanged.
function _window(getMeta, now, key = BUDGET_KEY) {
  let arr = [];
  try { arr = JSON.parse((getMeta && getMeta(key)) || '[]'); } catch {}
  const cutoff = now - 3600 * 1000;
  return (Array.isArray(arr) ? arr : []).filter(e => Array.isArray(e) && e[0] >= cutoff);
}
function spentLastHour(getMeta, now, key = BUDGET_KEY) { return _window(getMeta, now, key).reduce((a, e) => a + (e[1] || 0), 0); }
function budgetOk(getMeta, now, capPerHour = DEFAULT_BUDGET_TOKPH, key = BUDGET_KEY) {
  if (!capPerHour || capPerHour <= 0) return true;           // 0/unset → uncapped
  return spentLastHour(getMeta, now, key) < capPerHour;
}
function recordSpend({ getMeta, setMeta, now, tokens, key = BUDGET_KEY }) {
  const arr = _window(getMeta, now, key);
  arr.push([now, Math.max(0, tokens | 0)]);
  try { setMeta(key, JSON.stringify(arr)); } catch {}
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

// SLICE A (Lucas 2026-07-30: "get her subc more dynamic and focused… she struggles with stitching
// things together into real self-directed learning research and testing"). The essay is gone: the
// synthesis answers in a TYPED SHAPE (tension / why / action) so the stitch becomes WORK through
// existing doors instead of evaporating into the thought rail, and the tensions already explored
// ride the prompt so a pass spends on NEW stitching, never re-deriving the same convergence.
function buildSynthesisPrompt({ recentThoughts = [], threads = [], focus = null, sources = [], explored = [] } = {}) {
  const t = recentThoughts.slice(-12)
    .map((x, i) => `${i + 1}. ${String((x && x.content) || x || '').replace(/\s+/g, ' ').slice(0, 200)}`)
    .filter(s => s.length > 4).join('\n');
  const th = threads.slice(0, 5).map(x => '• ' + String((x && x.content) || x || '').replace(/\s+/g, ' ').slice(0, 120)).join('\n');
  const grounding = buildGroundingBlock(sources);
  const ex = (Array.isArray(explored) ? explored : []).slice(-6).map((x) => '• ' + String(x).replace(/\s+/g, ' ').slice(0, 140)).join('\n');
  return 'These are your recent between-turn thoughts:\n' + (t || '(none)')
    + (th ? '\n\nOpen threads:\n' + th : '')
    + (focus ? '\n\nActive focus: ' + String((focus && focus.content) || focus).slice(0, 160) : '')
    + (grounding ? '\n\n' + grounding : '')
    + (ex ? '\n\nTENSIONS YOU ALREADY EXPLORED (do NOT re-derive these — find a genuinely DIFFERENT one, or say the field is quiet):\n' + ex : '')
    + '\n\nStep back. Across these, find the ONE tension or question worth pursuing. Answer in EXACTLY this shape and nothing else:\n'
    + 'TENSION: <one sentence naming it>\n'
    + 'WHY: <two or three sentences — what depends on it>\n'
    + 'ACTION: <none | inquiry | research | experiment> — <one concrete sentence: research = the question to investigate; experiment = what a one-off read-only analysis script over your own data would test; inquiry = what to check in your own stores; none = nothing genuinely new>\n'
    + 'No essay, no numbered plans, no headers. If every real tension is already explored, ACTION: none is the honest answer.';
}

// The typed stitch, parsed defensively — null when the shape is absent (the caller keeps the raw
// text so a misformatted thought is never lost, just unrouted).
function parseSynthesis(text) {
  const s = String(text || '');
  const t = /^\s*(?:\*\*)?TENSION(?:\*\*)?:\s*(.{8,300}?)\s*$/im.exec(s);
  if (!t) return null;
  const w = /^\s*(?:\*\*)?WHY(?:\*\*)?:\s*([\s\S]{8,700}?)(?=^\s*(?:\*\*)?ACTION(?:\*\*)?:|$)/im.exec(s);
  const a = /^\s*(?:\*\*)?ACTION(?:\*\*)?:\s*(none|inquiry|research|experiment)\b[\s—:–-]*(.*)$/im.exec(s);
  return {
    tension: t[1].trim(),
    why: w ? w[1].trim().replace(/\s+/g, ' ').slice(0, 500) : '',
    action: { kind: a ? a[1].toLowerCase() : 'none', text: a ? a[2].trim().slice(0, 300) : '' },
  };
}

module.exports = {
  meritScore, decideTier,
  spentLastHour, budgetOk, recordSpend, estimateTokens,
  retrieveSources, buildGroundingBlock,
  shouldSynthesize, markSynthesized, buildSynthesisPrompt, parseSynthesis,
  DEFAULT_THRESHOLD, DEFAULT_SYNTH_MIN, DEFAULT_BUDGET_TOKPH, BUDGET_KEY, SYNTH_AT_KEY
};
