'use strict';
/**
 * lib/puller_corrections.js — F4 correction loop: run the contextual identity-dedup SWEEP (lib/identity_dedup)
 * over the LIVE Puller target population and act on the result. This is the retrospective arm of the Tracy
 * fix — F1 guards the front door at mint time; this walks the back catalog for fragments already minted.
 *
 * DEGREE for a Puller target = its observation count (a fragment with a couple of stray observations is safe
 * to fold into its canonical; an attractor carrying dozens of observations that span multiple real people is
 * NOT — that gets flagged for an operator split, never blind-merged). TITLE comes from the person's role
 * belief so a descriptor ("the finance lady") can bind by role, not just first name.
 *
 * Policy (the ADDITIVE-gate pivot): a high-confidence, low-degree, role-narrowed merge AUTO-APPLIES (the
 * machine is better than the human at this scale) and is logged reversibly; everything softer is SURFACED as
 * a proposal/flag for the operator window. Nothing here is destructive — mergeTarget tombstones (reversible),
 * and the operator can unmerge any correction. Human = watcher + label-supplier, not a blocking gate.
 */

const pdb = require('./puller_db');
const dedup = require('./identity_dedup');

// Auto-apply only a role-narrowed match at/above this confidence AND at/below this observation degree.
const AUTO_CONFIDENCE = 0.8;
const AUTO_MAX_DEGREE = 3;

// Build the dedup population from live targets: id, name, person/org type, role→title, degree=obs count.
// The degree (obs count) and role belief come from ONE bulk query each (observationCounts / beliefValuesByType)
// instead of a per-target getBelief + listObservations — the old shape was ~2 queries × 67k targets = ~135k
// synchronous queries that each loaded whole rows, pegging the main thread for seconds every sweep (the F4
// freeze, alongside the O(n²) in the sweep itself). Falls back to per-target reads when the store doesn't
// expose the bulk helpers (e.g. a mock db in a unit test), so callers/tests keep working unchanged.
function buildPopulation(db = pdb, { limit = 100000 } = {}) {
  const targets = db.listTargets({ limit });
  const degrees = typeof db.observationCounts === 'function' ? db.observationCounts() : null;
  const roles = typeof db.beliefValuesByType === 'function' ? db.beliefValuesByType('role') : null;
  return targets.map((t) => {
    const roleVal = roles ? roles.get(t.id) : ((db.getBelief(t.id, 'role') || {}).value);
    const degree = degrees ? (degrees.get(t.id) || 0) : db.listObservations(t.id).length;
    return { id: t.id, name: t.name, type: t.kind === 'org' ? 'organization' : 'person',
             title: roleVal != null && roleVal !== '' ? roleVal : (t.function || t.notes || null), degree };
  });
}

/**
 * runSweep(opts) → { proposals, autoApplied, attractorFlags, scanned, candidates }
 *   opts.apply (default false): actually auto-apply the confident low-degree merges. When false, EVERYTHING
 *     comes back as a proposal (dry run — the safe default for a first look / the observability window).
 *   opts.autoConfidence / opts.autoMaxDegree: tune the auto-apply gate.
 */
function runSweep(opts = {}) {
  const db = opts.db || pdb;
  const population = buildPopulation(db, opts);
  const found = dedup.sweep(population, opts);
  return _applyMerges(db, found, opts);
}

// The write half: the safe tier auto-folds, everything else is surfaced. Shared by the inline sweep and the
// worker sweep — the worker only ever READS; every merge is applied here, on the main thread, reversibly.
function _applyMerges(db, { merges = [], attractorFlags = [], scanned = 0, candidates = 0 } = {}, opts = {}) {
  const apply = !!opts.apply;
  const autoConfidence = opts.autoConfidence == null ? AUTO_CONFIDENCE : opts.autoConfidence;
  const autoMaxDegree = opts.autoMaxDegree == null ? AUTO_MAX_DEGREE : opts.autoMaxDegree;
  const proposals = [], autoApplied = [];
  for (const m of merges) {
    const eligible = apply && m.via === 'first-name+role' && m.confidence >= autoConfidence && m.degree <= autoMaxDegree;
    if (eligible) {
      try {
        const res = db.mergeTarget(m.fromId, m.intoId, { actor: 'auto-sweep', confidence: m.confidence,
          reason: m.reason });
        autoApplied.push({ ...m, correctionId: res.correctionId, movedObs: res.movedObs });
      } catch (e) { proposals.push({ ...m, error: e.message }); }
    } else {
      proposals.push(m);   // surfaced for operator review (the Puller window)
    }
  }
  return { proposals, autoApplied, attractorFlags, scanned, candidates };
}

// ── OFF THE MAIN THREAD (freeze cut 9, 2026-09-03) ─────────────────────────────────────────────────
// p261 blocked 4.7s on this sweep: beliefValuesByType('role') 2.3s cold, listTargets(100000) + the
// observation GROUP BY, then the first-name-blocked scan over 100k rows — all synchronous, twice an hour
// at most, and its 'dedup-sweep' label was clobbered by another lane's idle mark. The population build
// and the scan are READS + pure JS over plain rows: a worker_thread re-runs this module with workerData
// set, opens its OWN read-only handle to the store (lib/puller_db populationReader — the same SQL the live
// functions run), sweeps, and posts back the merges/flags. Only the WRITES (the reversible merges) happen
// here, on the main thread, through _applyMerges — exactly as inline. Any worker failure, or an in-memory
// store a worker cannot share, falls back to the inline sweep: correct, just on the main thread.
function runSweepInWorker(opts = {}) {
  const db = opts.db || pdb;
  const dbPath = opts.dbPath || (typeof db.dbPath === 'function' ? db.dbPath() : null);
  const inline = () => runSweep(opts);
  if (!dbPath || dbPath === ':memory:') return Promise.resolve(inline());
  return new Promise((resolve) => {
    let settled = false;
    const done = (fn) => { if (!settled) { settled = true; try { resolve(fn()); } catch (e) { resolve({ proposals: [], autoApplied: [], attractorFlags: [], scanned: 0, candidates: 0, error: e.message }); } } };
    try {
      const { Worker } = require('worker_threads');
      const w = new Worker(__filename, { workerData: { __dedupSweep: true, dbPath, limit: opts.limit || 100000,
        sweepOpts: { maxMergeDegree: opts.maxMergeDegree, minCanonicalDegree: opts.minCanonicalDegree } } });
      const t = setTimeout(() => { try { w.terminate(); } catch {} done(inline); }, opts.timeoutMs || 120000);
      if (t.unref) t.unref();
      w.once('message', (found) => {
        clearTimeout(t); try { w.terminate(); } catch {}
        if (!found || found.error) { try { console.error('[dedup] worker sweep failed — inline fallback:', found && found.error); } catch {} return done(inline); }
        done(() => Object.assign(_applyMerges(db, found, opts), { via: 'worker' }));
      });
      w.once('error', (e) => { clearTimeout(t); try { console.error('[dedup] worker error — inline fallback:', e && e.message); } catch {} done(inline); });
    } catch (e) { done(inline); }
  });
}

module.exports = { runSweep, runSweepInWorker, buildPopulation, AUTO_CONFIDENCE, AUTO_MAX_DEGREE };

// Worker entry — runSweepInWorker() re-runs THIS module in a worker_thread with workerData set: the reads
// and the scan execute here, off the main thread, over a read-only handle; one message posts the result.
try {
  const wt = require('worker_threads');
  if (!wt.isMainThread && wt.workerData && wt.workerData.__dedupSweep) {
    const { dbPath, limit, sweepOpts } = wt.workerData;
    let out;
    try {
      const Database = require('better-sqlite3');
      const conn = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const reader = pdb.populationReader(conn);
        const population = buildPopulation(reader, { limit });
        const r = dedup.sweep(population, sweepOpts || {});
        out = { merges: r.merges, attractorFlags: r.attractorFlags, scanned: r.scanned, candidates: r.candidates };
      } finally { try { conn.close(); } catch {} }
    } catch (e) { out = { error: (e && e.message) || String(e) }; }
    wt.parentPort.postMessage(out);
  }
} catch { /* not a worker context */ }
