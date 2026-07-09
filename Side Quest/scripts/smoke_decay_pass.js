/* Smoke: lib/decay_pass — the C4 scheduled DECAY pass (offline, pure).
 * Proof: per-predicate half-life decay applied across facts; below-floor → re-verify
 * work-list worst-first; immutable predicates never decay/re-verify; row→fact mapping;
 * age from last-verified + now.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_decay_pass.js
 */
'use strict';
const DP = require('../lib/decay_pass');
const CD = require('../lib/confidence_decay');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;

// --- ageDaysOf: last-verified → now, clamped ---
const NOW = 1_000_000 * DP.DAY_MS;                     // an arbitrary "now" in ms
ok(near(DP.ageDaysOf(NOW - 550 * DP.DAY_MS, NOW), 550), 'ageDaysOf: 550 days between last-verified and now');
ok(DP.ageDaysOf(NOW + 10 * DP.DAY_MS, NOW) === 0, 'ageDaysOf: a future timestamp clamps to 0 (never negative age)');
ok(DP.ageDaysOf(null, NOW) === 0 && DP.ageDaysOf(NOW, null) === 0, 'ageDaysOf: missing input → 0');

// --- per-predicate decay through the pass (ageDays supplied directly) ---
const facts = [
  { id: 1, predicate: 'WORKS_FOR', confidence: 0.9, ageDays: 550 },   // FAST hl=550 → 0.45 (below 0.5)
  { id: 2, predicate: 'WORKS_FOR', confidence: 0.9, ageDays: 0 },     // fresh → 0.9
  { id: 3, predicate: 'HELD_OFFICE', confidence: 0.94, ageDays: 1100 },// FAST 2 half-lives → 0.235
  { id: 4, predicate: 'MEMBER_OF', confidence: 0.9, ageDays: 1825 },  // MEDIUM hl=1825 → 0.45 (below 0.5)
  { id: 5, predicate: 'BORN_IN', confidence: 0.6, ageDays: 100000 },  // IMMUTABLE → 0.6 (no decay)
];
const r = DP.runDecayPass(facts, { now: NOW, floor: 0.5 });
const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
ok(near(byId[1].decayed, 0.45), 'FAST predicate at 1 half-life → confidence halved (0.9→0.45)');
ok(near(byId[2].decayed, 0.9), 'a fresh fact (age 0) does not decay');
ok(near(byId[3].decayed, 0.235), 'FAST at 2 half-lives → quartered (0.94→0.235)');
ok(near(byId[4].decayed, 0.45), 'MEDIUM predicate at its 5yr half-life → halved');
ok(near(byId[5].decayed, 0.6), 'IMMUTABLE predicate (BORN_IN) never decays, even at 100k days');

// --- re-verify work-list: below-floor, worst-first, immutable excluded ---
ok(r.reverify.length === 3, 're-verify list holds the 3 below-floor facts (ids 1,3,4)');
ok(r.reverify[0].id === 3, 're-verify is worst-first (id 3 @0.235 leads)');
ok(r.reverify.every((f) => f.decayed < 0.5), 'every re-verify fact is below the floor');
ok(!r.reverify.some((f) => f.predicate === 'BORN_IN'), 'a low-confidence IMMUTABLE fact is NOT re-verified (it is stable, not stale)');
ok(r.summary.assessed === 5 && r.summary.reverify === 3 && r.summary.immutable === 1, 'summary counts: assessed/reverify/immutable');

// --- floor is honored ---
ok(DP.runDecayPass(facts, { now: NOW, floor: 0.3 }).reverify.length === 1, 'a lower floor (0.3) shrinks the re-verify list (only id 3 @0.235)');
ok(DP.runDecayPass(facts, { now: NOW, floor: 0.95 }).reverify.length === 4, 'a high floor (0.95) widens it (everything decayable except the fresh 0.9 is caught)');

// --- factFromRow: civic_graph row (created_at seconds) → fact with computed ageDays ---
const createdSec = Math.floor((NOW - 730 * DP.DAY_MS) / 1000);   // ~2 years ago
const f = DP.factFromRow({ id: 7, relation_type: 'WORKS_FOR', confidence: 0.88, source_id: 10, target_id: 20, source_name: 'X', target_name: 'Y', created_at: createdSec }, { now: NOW });
ok(f.predicate === 'WORKS_FOR' && near(f.ageDays, 730), 'factFromRow: relation_type→predicate + created_at(sec)→ageDays');
ok(f.source_name === 'X' && f.target_name === 'Y', 'factFromRow: carries endpoints so the work-list is actionable');
ok(DP.factFromRow({ relation_type: 'A', confidence: 0.5, last_verified_ms: NOW - 100 * DP.DAY_MS }, { now: NOW }).ageDays === 100, 'factFromRow: prefers last_verified_ms (source date) when present');

// --- lastVerifiedMs path inside the pass + edge cases ---
const r2 = DP.runDecayPass([{ predicate: 'WORKS_FOR', confidence: 0.9, lastVerifiedMs: NOW - 550 * DP.DAY_MS }], { now: NOW });
ok(near(r2.rows[0].decayed, 0.45), 'pass computes ageDays from lastVerifiedMs+now when ageDays absent');
ok(DP.runDecayPass([], { now: NOW }).summary.assessed === 0 && DP.runDecayPass(null).reverify.length === 0, 'empty/null → empty result');
ok(DP.runDecayPass([{ predicate: 'WORKS_FOR', confidence: 0, ageDays: 9999 }], { now: NOW }).reverify.length === 0, 'a zero-confidence fact is not re-verified (nothing to decay)');

// consistency with the underlying model
ok(near(byId[1].decayed, CD.decayedConfidence(0.9, 'WORKS_FOR', 550)), 'pass decayed value matches confidence_decay.decayedConfidence exactly');

(async () => {
  // --- runDecaySweep: reads FAST-predicate edges via dispatch → below-floor re-verify work-list (read-only) ---
  const oldSec = Math.floor((NOW - 900 * DP.DAY_MS) / 1000);   // ~2.5yr old → a FAST edge decays well below 0.5
  const freshSec = Math.floor((NOW - 10 * DP.DAY_MS) / 1000);  // ~fresh → above floor
  let served = false;   // serve 2 rows for the first FAST predicate queried, empty for the rest
  const dispatch = async ({ args }) => {
    if (served) return { ok: true, text: JSON.stringify({ rows: [] }) };
    served = true;
    const pred = (args.sql.match(/relation_type = '([A-Z_]+)'/) || [])[1] || 'HELD_OFFICE';
    return { ok: true, text: JSON.stringify({ rows: [
      { id: 1, source_id: 10, target_id: 20, relation_type: pred, confidence: 0.9, created_at: oldSec, source_name: 'Sen A', target_name: 'Old Office' },
      { id: 2, source_id: 11, target_id: 21, relation_type: pred, confidence: 0.9, created_at: freshSec, source_name: 'Sen B', target_name: 'Fresh Office' },
    ] }) };
  };
  const sweep = await DP.runDecaySweep({ dispatch, now: NOW, floor: 0.5, limitPerPredicate: 500 });
  ok(sweep.summary.assessed === 2, 'runDecaySweep: assesses the edges the dispatch returns');
  ok(sweep.summary.reverify === 1 && sweep.reverify[0].id === 1, 'runDecaySweep: only the stale (old) FAST edge lands on the re-verify list');
  ok(sweep.reverify[0].source_name === 'Sen A' && sweep.reverify[0].target_name === 'Old Office', 'runDecaySweep: work-list carries endpoints (actionable for the operator / puller consumer)');
  ok(sweep.summary.predicates > 0, 'runDecaySweep: defaults to the FAST-decay predicate set (indexed, cheap)');
  ok((await DP.runDecaySweep({})).summary.reverify === 0, 'runDecaySweep: no dispatch → empty (fail-soft)');
  const swErr = await DP.runDecaySweep({ dispatch: async () => { throw new Error('db down'); }, now: NOW });
  ok(swErr.reverify.length === 0, 'runDecaySweep: a db_query failure is per-predicate fail-soft (never throws)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
