/* Smoke: lib/beat_scheduler — autonomic rotation brain (Slice 2c). Pure, offline.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_beat_scheduler.js
 */
'use strict';
const s = require('../lib/beat_scheduler');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const beats = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

// --- chooseNext: never-run first, then least-recently-run, tie → registry order ---
ok(s.chooseNext({ beats, state: {} }) === 'a', 'empty state → first registry beat (all never-run, tie → order)');
ok(s.chooseNext({ beats, state: { beats: { a: { lastRun: 100 } } } }) === 'b', 'a run, b/c never-run → b (registry order among never-run)');
ok(s.chooseNext({ beats, state: { beats: { a: { lastRun: 100 }, b: { lastRun: 200 }, c: { lastRun: 50 } } } }) === 'c', 'all run → least-recently-run (c)');
ok(s.chooseNext({ beats, state: { beats: { a: { lastRun: 100 }, b: { lastRun: 50 }, c: { lastRun: 200 } } } }) === 'b', 'least-recently-run picks b');

// --- done beats drop out ---
ok(s.chooseNext({ beats, state: { beats: { a: { status: 'done', lastRun: 1 }, b: { lastRun: 100 }, c: { lastRun: 50 } } } }) === 'c', 'done beat excluded even though oldest');
ok(s.chooseNext({ beats, state: { beats: { a: { status: 'done' }, b: { status: 'done' }, c: { status: 'done' } } } }) === null, 'all done → null');
ok(s.chooseNext({ beats: [], state: {} }) === null, 'no beats → null');

// --- shouldRotate: converge OR slice budget ---
ok(s.shouldRotate({ sliceCovered: 0, done: true }) === true, 'done → rotate');
ok(s.shouldRotate({ sliceCovered: 6, sliceBudget: 6 }) === true, 'hit slice budget → rotate');
ok(s.shouldRotate({ sliceCovered: 5, sliceBudget: 6 }) === false, 'under budget → keep working (depth)');
ok(s.shouldRotate({ sliceCovered: s.DEFAULT_SLICE_BUDGET - 1 }) === false, `default budget ${s.DEFAULT_SLICE_BUDGET}: under budget → keep the deep-dive going`);
ok(s.shouldRotate({ sliceCovered: s.DEFAULT_SLICE_BUDGET }) === true, `default budget ${s.DEFAULT_SLICE_BUDGET}: budget of deep dossiers done → rotate for diversity`);
ok(s.shouldRotate({ sliceCovered: 1, sliceBudget: 0 }) === true, 'budget floored at 1 (never a zero-budget spin)');

// --- allDone ---
ok(s.allDone({ beats, state: { beats: { a: { status: 'done' }, b: { status: 'done' }, c: { status: 'done' } } } }) === true, 'all converged → allDone');
ok(s.allDone({ beats, state: { beats: { a: { status: 'done' } } } }) === false, 'one converged → not allDone');
ok(s.allDone({ beats: [], state: {} }) === false, 'no beats → not allDone (nothing to converge)');

// --- dueForMaintenance: a converged beat goes stale after the interval ---
ok(s.dueForMaintenance({ status: 'done', doneAt: 0, now: s.DEFAULT_MAINTENANCE_MS + 1 }) === true, 'converged longer than the interval → due for re-verify');
ok(s.dueForMaintenance({ status: 'done', doneAt: 100, now: 200, intervalMs: 1000 }) === false, 'converged recently → not yet due');
ok(s.dueForMaintenance({ status: 'active', doneAt: 0, now: 1e15 }) === false, 'an active beat is never "due for maintenance" (only converged ones)');
ok(s.dueForMaintenance({ status: 'done', doneAt: null, now: 1e15 }) === false, 'no doneAt recorded → not due (needs a convergence timestamp)');
ok(s.dueForMaintenance({ status: 'done', doneAt: 100, now: 100, intervalMs: 0 }) === true, 'zero interval → immediately due');

// --- pickLane: topic/concept lane gets fair footing vs the huge elected roster ---
ok(s.pickLane({ sliceIndex: 0, topicEvery: 3 }) === 'topic', 'slice 0 → topic');
ok(s.pickLane({ sliceIndex: 1, topicEvery: 3 }) === 'elected' && s.pickLane({ sliceIndex: 2, topicEvery: 3 }) === 'elected', 'slices 1,2 → elected');
ok(s.pickLane({ sliceIndex: 3, topicEvery: 3 }) === 'topic', 'slice 3 → topic (every 3rd)');
{ // over 30 slices, ~1/3 are topic
  let topic = 0; for (let i = 0; i < 30; i++) if (s.pickLane({ sliceIndex: i, topicEvery: 3 }) === 'topic') topic++;
  ok(topic === 10, `~1/3 of slices are topic (got ${topic}/30)`);
}
ok(s.pickLane({ sliceIndex: 0, hasTopic: false }) === 'elected', 'no topic beats → always elected');
ok(s.pickLane({ sliceIndex: 1, hasElected: false }) === 'topic', 'no elected beats → always topic');
ok(s.pickLane({ sliceIndex: 0, topicEvery: 1 }) === 'topic' && s.pickLane({ sliceIndex: 1, topicEvery: 1 }) === 'elected', 'topicEvery floored at 2 — topics never take EVERY slice');

// --- round-robin end-to-end: 3 beats, budget 2, simulate slices → each runs before any repeats ---
{
  let state = { beats: {} };
  let clock = 1000;
  const order = [];
  for (let slice = 0; slice < 6; slice++) {
    const id = s.chooseNext({ beats, state });
    order.push(id);
    state.beats[id] = { ...(state.beats[id] || {}), lastRun: clock++ };
  }
  // first three slices touch a,b,c (each once) before the second cycle repeats them
  ok(order.slice(0, 3).sort().join('') === 'abc', `first cycle covers all three before repeating (got ${order.slice(0, 3).join(',')})`);
  ok(order.slice(3, 6).sort().join('') === 'abc', `second cycle repeats all three (got ${order.slice(3, 6).join(',')})`);
}

// ─── PRIORITY ALLOCATION (Slice S1) ──────────────────────────────────────────────────────────
// --- stalenessTerm: cadence-normalized age, never-run = max, clamped ---
ok(s.stalenessTerm({ lastRun: null, now: 5 }) === 1, 'staleness: never-run → 1 (max urgency)');
ok(s.stalenessTerm({ lastRun: 100, now: 100, cadenceMs: 1000 }) === 0, 'staleness: just-run → 0');
ok(s.stalenessTerm({ lastRun: 0, now: 500, cadenceMs: 1000 }) === 0.5, 'staleness: half a cadence → 0.5');
ok(s.stalenessTerm({ lastRun: 0, now: 5000, cadenceMs: 1000 }) === 1, 'staleness: past cadence → clamped to 1');

// --- yieldTerm: unknown neutral, ref → 1, clamped ---
ok(s.yieldTerm({}) === 0.5, 'yield: unknown → neutral 0.5 (inert until cached)');
ok(s.yieldTerm({ yieldAvg: s.YIELD_REF_CHARS }) === 1, 'yield: reference chars → 1');
ok(s.yieldTerm({ yieldAvg: 0 }) === 0, 'yield: zero new chars → 0');
ok(s.yieldTerm({ yieldAvg: 1e9 }) === 1, 'yield: huge → clamped to 1');

// --- scoreBeat: news outranks staleness outranks yield; in-flight is a strong penalty ---
const sc = (o) => s.scoreBeat({ now: 5000, ...o });
ok(sc({ beat: { maintenanceMs: 1000 }, beatState: { lastRun: 5000 } }) < sc({ beat: { maintenanceMs: 1000 }, beatState: {} }), 'score: just-run < never-run (staleness drives)');
ok(sc({ beat: { maintenanceMs: 1000 }, beatState: {}, newsScore: 1 }) > sc({ beat: { maintenanceMs: 1000 }, beatState: {} }), 'score: a news spike raises priority');
ok(sc({ beat: { maintenanceMs: 1000 }, beatState: { lastRun: 5000 }, newsScore: 1 }) > sc({ beat: { maintenanceMs: 1000 }, beatState: {} }), 'score: news on a just-run beat outranks a never-run beat (surge)');
ok(sc({ beat: {}, beatState: {}, inFlight: true }) < 0, 'score: in-flight penalty pushes a held beat below zero');

// --- PIN (the his-world term, 2026-07-23): amplifies STALENESS, never overrides it ---
ok(sc({ beat: { maintenanceMs: 1000 }, beatState: {}, pinScore: 1 }) > sc({ beat: { maintenanceMs: 1000 }, beatState: {} }), 'score: a pinned due beat outranks an unpinned due beat');
ok(sc({ beat: { maintenanceMs: 1000 }, beatState: { lastRun: 5000 }, pinScore: 1 }) < sc({ beat: { maintenanceMs: 1000 }, beatState: {} }), 'score: a JUST-RUN pinned beat sinks below a due bulk beat (pin amplifies staleness — starvation-free by construction)');
ok('pin' in s.DEFAULT_ALLOC_WEIGHTS, 'pin weight ships in the defaults (runtime-tunable like the rest)');
// PINNED STALENESS FLOOR: a just-run his-world beat re-enters rotation (score > 0), but a FULLY
// stale bulk beat still outranks the floor — direction is a thumb on the scale, not a monopoly
ok(sc({ beat: { maintenanceMs: 1000 }, beatState: { lastRun: 5000 }, pinScore: 1 }) > 0.5, 'floor: a just-run pinned beat keeps a real score (re-enters rotation quickly)');
ok(sc({ beat: { maintenanceMs: 1000 }, beatState: {} }) > sc({ beat: { maintenanceMs: 1000 }, beatState: { lastRun: 5000 }, pinScore: 1 }), 'floor: a fully-stale bulk beat still outranks a just-run pinned one (no starvation, no monopoly)');
ok(s.chooseNextByPriority({
  beats: [{ id: 'county-sweep-tn', maintenanceMs: 1000 }, { id: 'florida-counties', maintenanceMs: 1000 }],
  state: {}, now: 5000,
  signals: (b) => (b.id === 'florida-counties' ? { pinScore: 1 } : {}),
}) === 'florida-counties', 'priority: his-world pin beats registry order when both are due (the alphabetical-sweep fix)');

// --- chooseNextByPriority: parity + signal behavior ---
const bp = [{ id: 'a', maintenanceMs: 1000 }, { id: 'b', maintenanceMs: 1000 }, { id: 'c', maintenanceMs: 1000 }];
ok(s.chooseNextByPriority({ beats: bp, state: {}, now: 5000 }) === 'a', 'priority: all never-run → first registry beat (tie → order)');
ok(s.chooseNextByPriority({ beats: bp, state: { beats: { a: { lastRun: 5000 } } }, now: 5000 }) === 'b', 'priority: a just-run → next never-run (b)');
ok(s.chooseNextByPriority({ beats: bp, state: { beats: { a: { lastRun: 5000 } } }, now: 5000, signals: (b) => b.id === 'a' ? { newsScore: 1 } : {} }) === 'a', 'priority: news spike on a jumps it back ahead of never-run b');
ok(s.chooseNextByPriority({ beats: bp, state: {}, now: 5000, signals: (b) => b.id === 'a' ? { inFlight: true } : {} }) === 'b', 'priority: a held by a worker → skip to b');
ok(s.chooseNextByPriority({ beats: bp, state: { beats: { a: { status: 'done' } } }, now: 5000 }) === 'b', 'priority: done beat excluded');
ok(s.chooseNextByPriority({ beats: bp, state: { beats: { a: { status: 'done' }, b: { status: 'done' }, c: { status: 'done' } } }, now: 5000 }) === null, 'priority: all done → null');
ok(s.chooseNextByPriority({ beats: [], state: {}, now: 5000 }) === null, 'priority: no beats → null');

// --- STARVATION-FREE: a maxed-yield just-run beat never starves an ignored one (staleness weight ≥ yield) ---
ok(s.chooseNextByPriority({ beats: bp, state: { beats: { a: { lastRun: 5000, yieldAvg: 1e9 } } }, now: 5000 }) === 'b', 'starvation-free: ignored never-run b outranks a just-run max-yield a');
// weights are tunable: zero out staleness and the high-yield just-run beat CAN win (proves weights bite)
ok(s.chooseNextByPriority({ beats: bp, state: { beats: { a: { lastRun: 5000, yieldAvg: 1e9 } } }, now: 5000, weights: { stale: 0 } }) === 'a', 'weights: stale=0 lets max-yield a win (weights are live-tunable)');

// --- priority rotation end-to-end: each beat runs before any repeats (diversity preserved) ---
{
  let state = { beats: {} }, clock = 1000; const order = [];
  for (let slice = 0; slice < 6; slice++) {
    const id = s.chooseNextByPriority({ beats: bp, state, now: clock });
    order.push(id);
    state.beats[id] = { ...(state.beats[id] || {}), lastRun: clock };
    clock += 400;   // advance < cadence so staleness differentiates the three
  }
  ok(order.slice(0, 3).sort().join('') === 'abc', `priority: first cycle covers all three before repeating (got ${order.slice(0, 3).join(',')})`);
  ok(order.slice(3, 6).sort().join('') === 'abc', `priority: second cycle repeats all three (got ${order.slice(3, 6).join(',')})`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
