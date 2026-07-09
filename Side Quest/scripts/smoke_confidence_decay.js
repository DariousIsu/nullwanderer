/* Smoke: lib/confidence_decay — C4 per-predicate confidence decay + re-verify queue (offline).
 * Proof: predicate-specific decay curves (role fast, birthplace never); decayed-below-floor → re-verify.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_confidence_decay.js
 */
'use strict';
const D = require('../lib/confidence_decay');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- half-life lookup ---
ok(D.halfLifeDays('WORKS_FOR') === D.FAST && D.halfLifeDays('works_for') === D.FAST, 'halfLife: WORKS_FOR = fast (case-insensitive)');
ok(D.halfLifeDays('MEMBER_OF') === D.MEDIUM, 'halfLife: MEMBER_OF = medium');
ok(!isFinite(D.halfLifeDays('BORN_IN')), 'halfLife: BORN_IN = immutable (∞)');
ok(D.halfLifeDays('SOME_UNKNOWN_REL') === D.DEFAULT_HALFLIFE, 'halfLife: unknown predicate → default (medium)');

// --- decay curve: at one half-life a fast predicate halves; immutable never moves ---
ok(Math.abs(D.decayedConfidence(0.9, 'WORKS_FOR', D.FAST) - 0.45) < 1e-9, 'decay: WORKS_FOR at 1 half-life → 0.45 (halved)');
ok(Math.abs(D.decayedConfidence(0.9, 'WORKS_FOR', 2 * D.FAST) - 0.225) < 1e-9, 'decay: WORKS_FOR at 2 half-lives → 0.225');
ok(D.decayedConfidence(0.9, 'BORN_IN', 100000) === 0.9, 'decay: BORN_IN never decays (immutable)');
ok(D.decayedConfidence(0.9, 'WORKS_FOR', 0) === 0.9, 'decay: age 0 → unchanged');

// --- predicate ordering: over the SAME age, fast decays more than medium than immutable ---
const age = 1000;
const dFast = D.decayedConfidence(0.9, 'WORKS_FOR', age);
const dMed = D.decayedConfidence(0.9, 'MEMBER_OF', age);
const dImm = D.decayedConfidence(0.9, 'BORN_IN', age);
ok(dFast < dMed && dMed < dImm, `predicate ordering: role(${dFast.toFixed(3)}) < membership(${dMed.toFixed(3)}) < birthplace(${dImm.toFixed(3)})`);

// --- monotone non-increasing in age ---
const seq = [0, 200, 500, 1000, 2000].map((a) => D.decayedConfidence(0.9, 'WORKS_FOR', a));
ok(seq.every((v, i) => i === 0 || v < seq[i - 1]), 'decay is strictly decreasing in age for a volatile predicate');

// --- re-verify: a stale role drops below floor; a birthplace never does ---
ok(D.needsReverify(0.9, 'WORKS_FOR', 3 * 365, 0.5) === true, 're-verify: a 3-year-old employment fact falls below floor');
ok(D.needsReverify(0.9, 'BORN_IN', 100 * 365, 0.5) === false, 're-verify: a 100-year-old birthplace stays above floor (never decays)');
ok(D.needsReverify(0.9, 'WORKS_FOR', 30, 0.5) === false, 're-verify: a fresh role is NOT queued');

// --- reverifyQueue: only below-floor facts, worst-first ---
const facts = [
  { id: 1, predicate: 'WORKS_FOR', confidence: 0.9, ageDays: 3 * 365 },   // stale role → queue
  { id: 2, predicate: 'BORN_IN', confidence: 0.9, ageDays: 100 * 365 },   // immutable → keep
  { id: 3, predicate: 'HAS_CEO', confidence: 0.95, ageDays: 5 * 365 },    // very stale → queue (worst)
  { id: 4, predicate: 'MEMBER_OF', confidence: 0.9, ageDays: 60 },        // fresh → keep
];
const q = D.reverifyQueue(facts, { floor: 0.5 });
ok(q.length === 2 && q.every((f) => f.decayed < 0.5), 're-verify queue: exactly the 2 below-floor facts');
ok(q[0].id === 3 && q[1].id === 1, 're-verify queue: worst (most-decayed) first');
ok(!q.some((f) => f.predicate === 'BORN_IN' || f.id === 4), 're-verify queue: immutable + fresh facts excluded');
ok(q.every((f) => typeof f.decayed === 'number'), 're-verify queue: each entry annotated with its decayed confidence');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
