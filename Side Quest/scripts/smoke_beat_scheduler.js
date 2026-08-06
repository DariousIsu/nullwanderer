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

// --- beatPassGate: beat-origin sweep = IDLE TIER (Lucas 2026-07-29); user-origin untouched ---
{
  const T = 100 * 60 * 1000;   // an arbitrary "now" well past every window
  ok(s.beatPassGate({ origin: 'user', now: T, lastUserTurnTs: T - 1000, autonomyInFlight: true }).ok === true, 'gate: user-origin focus passes regardless of idle/in-flight');
  ok(s.beatPassGate({ origin: 'beat', now: T, lastUserTurnTs: T - 1000 }).reason === 'not-idle', 'gate: beat + recent user turn → not-idle');
  ok(s.beatPassGate({ origin: 'beat', now: T, lastUserTurnTs: 0, autonomyInFlight: true }).reason === 'her-work-in-flight', 'gate: beat + autonomy in flight → her reasoned work outranks the sweep');
  ok(s.beatPassGate({ origin: 'beat', now: T, lastUserTurnTs: 0, lastBeatPassTs: T - 60 * 1000 }).reason === 'idle-cadence', 'gate: beat + recent sweep pass → idle-cadence (5-min default, not 45s)');
  ok(s.beatPassGate({ origin: 'beat', now: T, lastUserTurnTs: 0, lastBeatPassTs: 0 }).ok === true, 'gate: beat + truly idle + cadence clear → passes');
  ok(s.beatPassGate({ origin: 'beat', now: T, lastUserTurnTs: T - 11 * 60 * 1000, lastBeatPassTs: T - 6 * 60 * 1000 }).ok === true, 'gate: 11-min user idle + 6-min since last sweep pass → passes (defaults 10/5)');
  ok(s.beatPassGate({ origin: 'beat', now: T, lastUserTurnTs: T - 9 * 60 * 1000, lastBeatPassTs: 0 }).reason === 'not-idle', 'gate: 9-min user idle under the 10-min default → still not idle');
}

// --- ladderFilter: the STATE LADDER (slice B) — each state walks state-govt → capital → counties → … ---
{
  const mk = (id, st, rung) => ({ id, stateCode: st, ladderRung: rung });
  const pool = [
    { id: 'federal-officials' },                        // unrunged → always eligible
    mk('state-legislature-al', 'AL', 1), mk('capital-cities-al', 'AL', 2), mk('county-commissions-al', 'AL', 3),
    mk('state-legislature-tx', 'TX', 1), mk('county-commissions-tx', 'TX', 3),
  ];
  const ids = (st, held) => s.ladderFilter(pool, st, held).map((b) => b.id);
  ok(ids({ beats: {} }).join(',') === 'federal-officials,state-legislature-al,state-legislature-tx',
    'ladder: fresh states expose ONLY rung 1 (+ the unrunged federal)');
  ok(ids({ beats: { 'state-legislature-al': { status: 'done' } } }).includes('capital-cities-al'),
    'ladder: converging the legislature unlocks the capital/major-cities rung');
  ok(!ids({ beats: { 'state-legislature-al': { status: 'done' } } }).includes('county-commissions-al'),
    'ladder: counties stay locked until the capital rung converges too');
  ok(ids({ beats: { 'state-legislature-al': { status: 'done' }, 'capital-cities-al': { status: 'done' } } }).includes('county-commissions-al'),
    'ladder: rung 3 unlocks once rungs 1+2 converge');
  // IN-FLIGHT blocks: a held (worker-masked-done) beat still gates its state's lower rungs — working
  // rung N does not unlock rung N+1, converging it does. This also spreads workers ACROSS states.
  ok(!ids({ beats: { 'state-legislature-al': { status: 'done' } } }, new Set(['state-legislature-al'])).includes('capital-cities-al'),
    'CRITICAL: a held/in-flight rung still blocks — masked-done never unlocks the next rung');
  // TX has NO capital-cities beat in this pool (data gap) — the min is over what is schedulable, so
  // counties unlock straight after the legislature instead of deadlocking on a missing rung.
  ok(ids({ beats: { 'state-legislature-tx': { status: 'done' } } }).includes('county-commissions-tx'),
    'ladder: a state missing a rung skips it (no deadlock on absent data)');
  ok(s.ladderFilter([], {}).length === 0 && s.ladderFilter(pool).length >= 3, 'ladder: empty pool / omitted state never throw');
}

// ── DIRECTED PREEMPTION wiring (source asserts — Lucas 2026-08-06: "a directed task should take
// over ALL the bandwidth"). His run displaces the worker fleet (swarms exempt — he commanded
// those) and idles the puller's whole contact mission, not just discovery.
{
  const fs = require('fs'), path = require('path');
  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/if \(_userDirectedActive\(\)\) \{ if \(_pauseAllWorkers\(state, 'user-directed research holds the bandwidth'\)\)/.test(m),
    'preempt: the worker-fill displaces the fleet while a user-directed run is active');
  ok(/if \(!_userDirectedActive\(\)\) \{[^]{0,220}?for \(const w of Object\.values\(st\.workers/.test(m),
    'preempt: the driver loop skips normal workers immediately (swarm partitions keep driving)');
  ok(/originOf\(f\) !== 'beat'/.test(m) && /ZOE_DIRECTED_PREEMPT/.test(m),
    'preempt: HIS work only (beat-origin never self-preempts) + kill switch exists');
  const mono = fs.readFileSync(path.join(__dirname, '..', 'lib', 'monologue.js'), 'utf8');
  ok(/wantContact = \(mode === 'both' \|\| mode === 'contact'\) && !_userDirectedActive\(\)/.test(mono),
    'preempt: the puller CONTACT mission idles under a user-directed run (beyond the discovery-only leash)');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
