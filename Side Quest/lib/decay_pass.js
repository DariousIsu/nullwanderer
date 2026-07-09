'use strict';
/**
 * lib/decay_pass.js — C4 integration: the scheduled DECAY pass.
 *
 * confidence_decay.js gives the per-predicate half-life math; this is the PASS that
 * applies it across a set of facts as of `now` and emits the re-verify WORK-LIST —
 * the facts whose confidence has decayed below a floor, worst-first, for the feed /
 * operator to chase a fresh citation (a role/office edge goes stale in ~1.5yr; a
 * birthplace never does).
 *
 * READ-ONLY + PURE. It never writes, deletes, or supersedes: Zoe cannot touch the
 * read-only civic_graph foundation, and superseding stale facts is Milestone D
 * (contradiction-gated, operator-gated). The output here is a work-list, not a
 * mutation — the loop re-verifies (re-fetches a fresh source), and a genuinely
 * changed fact then flows through the normal propose → operator-promote path.
 *
 * Clock is passed in (`now`) so the pass stays offline-smoke-testable + Workflow-safe.
 */

const { decayedConfidence, halfLifeDays, PREDICATE_HALFLIFE, FAST } = require('./confidence_decay');

const DAY_MS = 86400000;

// Age in days from a fact's last-verified instant to `now` (never negative).
function ageDaysOf(lastVerifiedMs, now) {
  const t = Number(lastVerifiedMs), n = Number(now);
  if (!(t > 0) || !(n > 0)) return 0;
  return Math.max(0, (n - t) / DAY_MS);
}

// A civic-graph / proposal relation row → the fact shape the pass consumes. `created_at`
// is unix SECONDS in civic_graph; a fact's last-verified time is the most recent source
// date if known, else created_at. Keeps source_set + endpoints so the work-list is actionable.
function factFromRow(row = {}, { now = null } = {}) {
  const createdMs = row.last_verified_ms != null ? Number(row.last_verified_ms)
    : (row.created_at != null ? Number(row.created_at) * 1000 : null);
  return {
    id: row.id != null ? row.id : null,
    predicate: row.predicate || row.relation_type || row.relation || null,
    confidence: Number(row.confidence),
    source_id: row.source_id != null ? row.source_id : null,
    target_id: row.target_id != null ? row.target_id : null,
    source_name: row.source_name || null,
    target_name: row.target_name || null,
    ageDays: ageDaysOf(createdMs, now),
  };
}

/**
 * Run the decay pass over a set of facts as of `now`.
 *   facts: [{ predicate|relation_type, confidence, ageDays? | lastVerifiedMs?, ... }]
 *   opts:  { now?, floor=0.5 }
 * Returns { rows, reverify, summary } — `rows` = every fact annotated with its decayed
 * confidence; `reverify` = the below-floor subset, worst-first; `summary` = counts.
 * An immutable predicate (BORN_IN, FOUNDED, …) never decays, so it never re-verifies.
 */
function runDecayPass(facts, { now = null, floor = 0.5 } = {}) {
  const flr = Number(floor);
  const rows = (Array.isArray(facts) ? facts : []).map((f) => {
    const predicate = f.predicate || f.relation_type || f.relation || null;
    const confidence = Number(f.confidence);
    const ageDays = f.ageDays != null ? Math.max(0, Number(f.ageDays) || 0)
      : ageDaysOf(f.lastVerifiedMs, now);
    const decayed = decayedConfidence(confidence, predicate, ageDays);
    return { ...f, predicate, confidence, ageDays, decayed };
  });
  const reverify = rows
    .filter((r) => r.confidence > 0 && r.decayed < flr && isFinite(halfLifeDays(r.predicate)))
    .sort((a, b) => a.decayed - b.decayed);
  const summary = {
    assessed: rows.length,
    reverify: reverify.length,
    immutable: rows.filter((r) => !isFinite(halfLifeDays(r.predicate))).length,
    floor: flr,
  };
  return { rows, reverify, summary };
}

/**
 * The periodic DECAY SWEEP (read-only PRODUCER). The graph-walk already decays the edges it visits
 * each tick (continuous); this is the nightly CATCH for stale edges the walk never lands on. To stay
 * cheap it sweeps the FAST-decay predicates only (roles / office — they go stale fastest AND are
 * relation_type-INDEXED, so each read is index-backed), bounded per predicate. Facts whose confidence
 * has decayed below `floor` come back as a worst-first re-verify WORK-LIST.
 *
 * Reads via the injected `dispatch` (db_query) — no writes here; the caller lands the worklist in the
 * short-term buffer (curation_store, status 'reverify'). The CONSUMER (a fresh-citation re-fetch) is
 * the Puller lane — reserved for its own design session, deliberately not wired here.
 *
 * NOTE: selection within a predicate is bounded-but-unordered (no created_at index yet), so a single
 * night samples rather than exhausts; nights accrete coverage. An ordered/exhaustive sweep is a
 * substrate follow-up (a created_at / last_verified index).
 */
async function runDecaySweep({ dispatch, predicates = null, now = Date.now(), floor = 0.5, limitPerPredicate = 2000 } = {}) {
  if (typeof dispatch !== 'function') return { reverify: [], summary: { assessed: 0, reverify: 0, predicates: 0 } };
  const preds = (Array.isArray(predicates) && predicates.length)
    ? predicates
    : Object.keys(PREDICATE_HALFLIFE).filter((p) => PREDICATE_HALFLIFE[p] === FAST);
  const lim = Math.max(1, limitPerPredicate | 0);
  let assessed = 0;
  const reverify = [];
  for (const pred of preds) {
    const safe = String(pred).replace(/[^A-Z_]/g, '');
    if (!safe) continue;
    const sql = 'SELECT r.id, r.source_id, r.target_id, r.relation_type, r.confidence, r.created_at,'
      + ' es.name source_name, et.name target_name'
      + ' FROM relations r JOIN entities es ON es.id = r.source_id JOIN entities et ON et.id = r.target_id'
      + ` WHERE r.relation_type = '${safe}' AND r.tx_to IS NULL AND r.deleted = 0 LIMIT ${lim}`;
    let rows = [];
    try { const res = await dispatch({ kind: 'do', name: 'db_query', args: { sql } }); const j = JSON.parse(res.text); rows = (j && j.rows) || []; }
    catch { continue; }                          // per-predicate fail-soft
    const facts = rows.map((row) => factFromRow(row, { now }));
    const pass = runDecayPass(facts, { now, floor });
    assessed += pass.summary.assessed;
    for (const rv of pass.reverify) reverify.push(rv);
  }
  reverify.sort((a, b) => a.decayed - b.decayed);
  return { reverify, summary: { assessed, reverify: reverify.length, predicates: preds.length } };
}

module.exports = { DAY_MS, ageDaysOf, factFromRow, runDecayPass, runDecaySweep };
