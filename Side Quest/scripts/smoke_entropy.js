'use strict';
// smoke_entropy.js — Wave 2 governed entropy (lib/entropy.js). Proves the properties hard testing
// depends on: same seed → identical sequence (reproducibility), a draw in one lane never shifts
// another lane's sequence (per-lane sub-streams), deterministic mode collapses the semantic helpers
// to a seed-independent canonical branch and zeroes temperature, and every draw names a lane.
// Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_entropy.js
const e = require('../lib/entropy');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const eqArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

function floatSeq({ seed, mode = 'seeded', lane = 'L', n = 6 }) {
  e.configure({ seed, mode });
  const out = [];
  for (let i = 0; i < n; i++) out.push(e.float(lane));
  return out;
}

// ── reproducibility: same seed → byte-identical sequence (the whole point) ──
{
  const a = floatSeq({ seed: 123 });
  const b = floatSeq({ seed: 123 });
  ok(eqArr(a, b), 'same seed → identical float sequence (reproducible)');
  const c = floatSeq({ seed: 456 });
  ok(!eqArr(a, c), 'different seed → different sequence (the test can detect non-reproducibility)');
  e.configure({ mode: 'seeded' }); const d1 = e.float('d');
  e.configure({ mode: 'seeded' }); const d2 = e.float('d');
  ok(d1 === d2, 'seeded mode with no explicit seed is reproducible out of the box (fixed default)');
}

// ── per-lane sub-streams: a draw in lane B must NOT perturb lane A ──
{
  e.configure({ seed: 7, mode: 'seeded' });
  const a1 = [e.float('A'), e.float('A'), e.float('A')];
  e.configure({ seed: 7, mode: 'seeded' });
  e.float('B');                                   // interpose a draw in a DIFFERENT lane
  const a2 = [e.float('A'), e.float('A'), e.float('A')];
  ok(eqArr(a1, a2), 'a draw in lane B leaves lane A\'s sequence unchanged (independent sub-streams)');
  ok(e.float('A') !== e.float('B'), 'distinct lanes yield distinct streams');
}

// ── range + distribution (deterministic given the seed, so this is not a flake) ──
{
  e.configure({ seed: 2026, mode: 'seeded' });
  let sum = 0, min = 1, max = 0; const N = 4000;
  for (let i = 0; i < N; i++) { const v = e.float('dist'); sum += v; if (v < min) min = v; if (v > max) max = v; }
  ok(min >= 0 && max < 1, 'every float is in [0,1)');
  const mean = sum / N;
  ok(mean > 0.47 && mean < 0.53, `mean ≈ 0.5 over ${N} draws (${mean.toFixed(4)}) — a real uniform stream`);
}

// ── required lane ──
{
  let t1 = false, t2 = false;
  try { e.float(); } catch { t1 = true; }
  try { e.pick('', [1, 2]); } catch { t2 = true; }
  ok(t1, 'float() with no lane throws (every draw must name a lane)');
  ok(t2, 'an empty-string lane throws');
}

// ── pick ──
{
  e.configure({ seed: 5, mode: 'seeded' });
  const arr = ['a', 'b', 'c', 'd'];
  const p1 = [e.pick('P', arr), e.pick('P', arr), e.pick('P', arr)];
  ok(p1.every((x) => arr.includes(x)), 'pick returns an element of the array');
  e.configure({ seed: 5, mode: 'seeded' });
  const p2 = [e.pick('P', arr), e.pick('P', arr), e.pick('P', arr)];
  ok(eqArr(p1, p2), 'pick is reproducible under a fixed seed');
  e.configure({ mode: 'deterministic' });
  ok(e.pick('P', arr) === 'a' && e.pick('P', arr) === 'a', 'deterministic pick → the first element (canonical)');
  ok(e.pick('P', []) === undefined, 'pick on an empty array is undefined (fail-soft)');
}

// ── bernoulli ──
{
  e.configure({ seed: 11, mode: 'seeded' });
  ok([0, 0, 0, 0, 0].every(() => e.bernoulli('B', 0) === false), 'bernoulli(p=0) is always false');
  ok([0, 0, 0, 0, 0].every(() => e.bernoulli('B', 1) === true), 'bernoulli(p=1) is always true');
  e.configure({ seed: 11, mode: 'seeded' });
  const b1 = Array.from({ length: 10 }, () => e.bernoulli('B', 0.5));
  e.configure({ seed: 11, mode: 'seeded' });
  const b2 = Array.from({ length: 10 }, () => e.bernoulli('B', 0.5));
  ok(eqArr(b1, b2), 'bernoulli is reproducible under a fixed seed');
  e.configure({ mode: 'deterministic' });
  ok(e.bernoulli('B', 0.7) === true && e.bernoulli('B', 0.3) === false, 'deterministic bernoulli → the modal outcome (p≥0.5)');
}

// ── jitter ──
{
  e.configure({ seed: 1, mode: 'seeded' });
  let inBounds = true;
  for (let i = 0; i < 200; i++) { const v = e.jitter('J', 1000, 100); if (v < 900 || v > 1100) inBounds = false; }
  ok(inBounds, 'jitter stays within base ± spread');
  e.configure({ mode: 'deterministic' });
  ok(e.jitter('J', 1000, 100) === 1000, 'deterministic jitter → exactly base (no deviation)');
}

// ── epsilonGreedy / softmax ──
{
  const items = [{ s: 1 }, { s: 5 }, { s: 3 }];
  e.configure({ seed: 9, mode: 'seeded' });
  ok(e.epsilonGreedy('E', items, { epsilon: 0, score: (x) => x.s }) === items[1], 'epsilonGreedy(ε=0) → the argmax');
  e.configure({ mode: 'deterministic' });
  ok(e.epsilonGreedy('E', items, { epsilon: 1, score: (x) => x.s }) === items[1], 'deterministic epsilonGreedy → argmax even at ε=1');

  e.configure({ mode: 'deterministic' });
  ok(e.softmax('S', [{ w: 1 }, { w: 9 }, { w: 2 }], { score: (x) => x.w }).w === 9, 'deterministic softmax → argmax (the τ→0 limit)');
  e.configure({ seed: 3, mode: 'seeded' });
  const s1 = e.softmax('S', [{ w: 1 }, { w: 2 }, { w: 3 }], { score: (x) => x.w, tau: 1 });
  e.configure({ seed: 3, mode: 'seeded' });
  const s2 = e.softmax('S', [{ w: 1 }, { w: 2 }, { w: 3 }], { score: (x) => x.w, tau: 1 });
  ok(s1.w === s2.w, 'softmax is reproducible under a fixed seed');
}

// ── temperature: the LLM-determinism lever ──
{
  e.configure({ seed: 1, mode: 'seeded' });
  ok(e.temperature('mood', 0.85) === 0.85, 'temperature passes the real value through in seeded/prod mode');
  e.configure({ mode: 'deterministic' });
  ok(e.temperature('mood', 0.85) === 0, 'temperature → 0 (greedy) in deterministic mode');
}

// ── stream() is the drop-in for an injectable rng and matches float() ──
{
  e.configure({ seed: 42, mode: 'seeded' });
  const s = e.stream('X'); const viaStream = [s(), s(), s()];
  e.configure({ seed: 42, mode: 'seeded' });
  const viaFloat = [e.float('X'), e.float('X'), e.float('X')];
  ok(eqArr(viaStream, viaFloat), 'stream(lane)() draws the same sequence as float(lane)');
  ok(typeof e.stream('Y') === 'function', 'stream returns a () => [0,1) function');
}

// ── deterministic mode is SEED-INDEPENDENT for the semantic helpers ──
{
  e.configure({ mode: 'deterministic', seed: 1 });
  const d1 = { pick: e.pick('L', [10, 20, 30]), bern: e.bernoulli('L', 0.7), jit: e.jitter('L', 100, 50) };
  e.configure({ mode: 'deterministic', seed: 999 });
  const d2 = { pick: e.pick('L', [10, 20, 30]), bern: e.bernoulli('L', 0.7), jit: e.jitter('L', 100, 50) };
  ok(d1.pick === d2.pick && d1.bern === d2.bern && d1.jit === d2.jit, 'deterministic helpers are identical across different seeds (canonical, seed-independent)');
}

// ── journal + onSample ──
{
  const seen = [];
  e.configure({ seed: 1, mode: 'seeded', onSample: (ev) => seen.push(ev) });
  e.float('J'); e.pick('J', [1, 2]); e.bernoulli('J', 0.5);
  const j = e.journal();
  ok(j.length === 3 && j[0].dist === 'float' && j[1].dist === 'pick' && j[2].dist === 'bernoulli', 'journal records each decision in order with its distribution');
  ok(j[0].seq === 1 && j[2].seq === 3, 'journal entries carry a monotonic sequence number');
  ok(seen.length === 3 && seen[2].lane === 'J', 'the onSample hook fires per decision');
  e.configure({ seed: 1, mode: 'seeded' });
  for (let i = 0; i < 600; i++) e.float('cap');
  const jc = e.journal();
  ok(jc.length === 512 && jc[jc.length - 1].seq === 600, 'journal is a capped ring (512) but seq keeps counting');
  e.configure({ onSample: null });   // detach the hook so it can't leak into later suites
}

// ── getSeed / getMode reflect configure ──
{
  e.configure({ seed: 0x1234, mode: 'seeded' });
  ok(e.getSeed() === 0x1234n && e.getMode() === 'seeded', 'getSeed/getMode reflect an explicit configure');
  e.configure({ mode: 'deterministic' });
  ok(e.getMode() === 'deterministic' && e.getSeed() === e.DETERMINISTIC_SEED, 'deterministic mode with no seed uses the pinned constant');
}

// ── low-level primitives (the seeding math the whole module rests on) ──
{
  ok(e._fnv1a64('interests.topic') === e._fnv1a64('interests.topic'), 'fnv1a64 is deterministic');
  ok(e._fnv1a64('a') !== e._fnv1a64('b'), 'fnv1a64 separates distinct lane names');
  const r = e._splitmix64(0n);
  ok(typeof r.value === 'bigint' && r.state !== 0n && r.value !== 0n, 'splitmix64 advances the state and emits a nonzero output');
  const r2 = e._splitmix64(r.state);
  ok(r2.state !== r.state && r2.value !== r.value, 'splitmix64 keeps advancing');
  ok(e._normalizeSeed('0x10') === 16n && e._normalizeSeed('255') === 255n, 'normalizeSeed parses hex and decimal strings');
  ok(e._normalizeSeed(42) === 42n && e._normalizeSeed(7n) === 7n, 'normalizeSeed accepts numbers and bigints');
  ok(typeof e._normalizeSeed('hello') === 'bigint' && e._normalizeSeed('hello') > 0n, 'normalizeSeed hashes a non-numeric string to a seed');
  ok(e._normalizeSeed('') === null && e._normalizeSeed(null) === null, 'normalizeSeed treats empty/absent as no-seed');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
if (fail) process.exit(1);
