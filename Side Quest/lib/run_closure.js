/**
 * lib/run_closure.js — HOW A RESEARCH RUN ENDS (Lucas 2026-07-30: "I obviously do not want this
 * to spin forever, but I also want to see the program using the LLMs to reason while it gathers,
 * find new concepts in the research not from the original prompt … but with the ability to add
 * to the document without never-ending loops").
 *
 * The rule: RUNS ARE MORTAL, THE DOCUMENT IS ETERNAL. A run ends at diminishing UNDERSTANDING —
 * not a wall clock, not a hard pass count alone:
 *   • QUESTION LEDGER — every OPEN question a synthesis raises is recorded (normalized). When
 *     syntheses stop raising NOVEL questions, the frontier is closing: the research has asked
 *     everything it knows how to ask.
 *   • FRONTIER CLOSED — no novel questions across consecutive syntheses AND discovery coming up
 *     dry → conclude. The run isn't failing; it is DONE UNDERSTANDING at this depth.
 *   • PASS BUDGET — a soft ceiling scaled to his deadline (rush → assemble fast), counting only
 *     passes that progressed (no-ops are refunded — a bound may defer work, never spin on it).
 *   • DISCOVERED CONCEPTS SPAWN, NEVER EXTEND — the final unanswered questions become NEW pending
 *     research-shaped threads the driver orders like any other work (recency-biased). Depth cap 1:
 *     a spawned run never spawns again, so growth is linear, never exponential.
 * "Adding to the document" happens only via a NEW bounded run reopening the living doc (base_doc).
 *
 * Pure decision functions — persistence keys live with the caller (main.js focus meta).
 */
'use strict';

const _STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are',
  'what', 'which', 'how', 'why', 'does', 'do', 'did', 'will', 'would', 'could', 'can', 'their',
  'its', 'this', 'that', 'these', 'those', 'with', 'from', 'about', 'has', 'have', 'been', 'be']);

// A question's identity is its content words, stemmed and sorted — "How does PJM manage queue
// backlogs?" and "how PJM's queue backlog is managed" collapse to the same key. The stem is
// deliberately crude (strip -ing/-ed, then -es/-e/-s): linguistic correctness doesn't matter,
// only that BOTH sides of a comparison collapse identically.
const _stem = (w) => (w.length > 4 ? w.replace(/(ing|ed)$/, '').replace(/(es|e|s)$/, '') : w);
function normalizeQuestion(q) {
  return [...new Set(String(q || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !_STOP.has(w)).map(_stem))].sort();
}

// Fuzzy already-asked: Jaccard overlap ≥ 0.6 with any ledger entry means it is the SAME question
// wearing different words. (0.6 measured against the live #3617 ledger shapes: rephrasings land
// 0.6-0.9; genuinely new directions land < 0.4.)
function isNovelQuestion(q, ledger) {
  const toks = normalizeQuestion(q);
  if (toks.length < 2) return false;                 // a stub is not a research direction
  const set = new Set(toks);
  for (const entry of (Array.isArray(ledger) ? ledger : [])) {
    const eSet = new Set(Array.isArray(entry) ? entry : []);
    if (!eSet.size) continue;
    let inter = 0;
    for (const t of set) if (eSet.has(t)) inter++;
    const jac = inter / (set.size + eSet.size - inter);
    if (jac >= 0.6) return false;
  }
  return true;
}

// Split a synthesis's OPEN questions into novel vs already-asked, and return the grown ledger.
// Every question is RECORDED (novel or not) — the ledger is what was ASKED, not what was new.
function filterNovel(questions, ledger) {
  const led = (Array.isArray(ledger) ? ledger : []).slice();
  const novel = [];
  for (const q of (Array.isArray(questions) ? questions : [])) {
    if (isNovelQuestion(q, led)) novel.push(q);
    const toks = normalizeQuestion(q);
    if (toks.length >= 2) led.push(toks);
  }
  return { novel, ledger: led.slice(-60) };
}

// The soft pass ceiling, scaled to how he framed the deadline at thread BIRTH (user_work.parseDeadline
// semantics): rush → assemble, don't wander; a day's window → real depth; open-ended → the full arc.
function passBudgetFor({ content = '', createdTs = 0 } = {}) {
  try {
    const dl = require('./user_work').parseDeadline(content, createdTs);
    if (dl && dl.kind === 'rush') return 12;
    if (dl && dl.kind === 'today') return 24;
  } catch { /* no deadline parse → open budget */ }
  return 40;
}

// The closure decision. Inputs are the run's honest counters; the answer names its door.
function shouldConclude({ passesUsed = 0, budget = 40, dryStreak = 0, noNovelStreak = 0 } = {}) {
  if (passesUsed >= budget) return { conclude: true, reason: `pass budget spent (${passesUsed}/${budget})` };
  if (dryStreak >= 3) return { conclude: true, reason: `discovery dry (${dryStreak} target-less ticks)` };
  if (noNovelStreak >= 2 && dryStreak >= 1) return { conclude: true, reason: `frontier closed (${noNovelStreak} syntheses with zero novel questions, discovery dry)` };
  return { conclude: false, reason: null };
}

// Discovered concepts → NEW pending threads (the driver orders them; this run ends regardless).
// Depth cap 1 lives here: a run that was itself spawned returns [] — linear growth, never a chain
// reaction. Wording passes user_work.isResearchShaped so the driver actually picks them up.
function buildSpawns({ questions = [], spawnedFrom = null, cap = 3 } = {}) {
  if (spawnedFrom) return [];
  const out = [];
  for (const q of (Array.isArray(questions) ? questions : []).slice(0, cap)) {
    const text = String(q || '').trim().replace(/\s+/g, ' ');
    if (text.length < 12) continue;
    out.push(`Investigate: ${text}`);
  }
  return out;
}

module.exports = { normalizeQuestion, isNovelQuestion, filterNovel, passBudgetFor, shouldConclude, buildSpawns };
