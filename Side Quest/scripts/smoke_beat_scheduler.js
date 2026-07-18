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
ok(s.shouldRotate({ sliceCovered: 3 }) === false, `default budget ${s.DEFAULT_SLICE_BUDGET}: 3 covered → keep working`);
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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
