/* Smoke: lib/ingest_lane — F2 gate-less grounded auto-promote lane + chunked drainer (offline, pure).
 * Proof: the 3-band routing (promote/research/park), the GROUNDING gate on the promote band (an
 * ungrounded high-confidence proposal is routed to research, never auto-promoted), and the chunked
 * drain-until-empty controller (drains, stops on no-progress / remaining=0 / max-iters / error).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_ingest_lane.js
 */
'use strict';
const L = require('../lib/ingest_lane');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// helpers: a proposal at an EXACT confidence, grounded or not. We put only a `url` in metadata (grounding)
// and NOT grade/source_set — otherwise effectiveConfidence recomputes from the grade and ignores `conf`.
const grounded = (conf, name = 'Jane Roe') => ({ name, confidence: conf, metadata: { url: 'https://src/a' } });
const ungrounded = (conf, name = 'Jane Roe') => ({ name, confidence: conf, metadata: {} });   // no source

// --- isGrounded ------------------------------------------------------------------------------------
console.log('== isGrounded ==');
ok(L.isGrounded({ metadata: { source_set: ['https://x'] } }) === true, 'a source_set with a real URL → grounded');
ok(L.isGrounded({ url: 'https://x/y' }) === true, 'a bare url → grounded');
ok(L.isGrounded({ metadata: {} }) === false, 'no source anywhere → NOT grounded');
ok(L.isGrounded({ metadata: { source_set: [''] } }) === false, 'an empty source string → NOT grounded');

// --- threeBand -------------------------------------------------------------------------------------
console.log('== threeBand ==');
ok(L.threeBand(grounded(0.96)) === 'promote', 'high confidence + grounded → PROMOTE');
ok(L.threeBand(ungrounded(0.96)) === 'research', 'high confidence but UNGROUNDED → RESEARCH (never auto-promote on no source — grounding anchor)');
// INVERSION (decision #1): a GROUNDED (real-source = substantiated) proposal promotes at ANY confidence —
// the 0.90 floor no longer parks a single-source fact; its confidence is now just an explore-priority score.
ok(L.threeBand(grounded(0.80)) === 'promote', 'inversion: grounded mid-band (0.80) now PROMOTES (single source substantiates — no corroboration floor)');
ok(L.threeBand(grounded(0.50)) === 'promote', 'inversion: grounded low-confidence (0.50) still PROMOTES (grade = priority, not gate)');
ok(L.threeBand({ name: 'X', metadata: {} }) === 'park', 'no source AND no confidence → PARK');

// --- planBands (partition) -------------------------------------------------------------------------
console.log('== planBands ==');
const queue = [grounded(0.97, 'A'), grounded(0.95, 'B'), ungrounded(0.95, 'C'), grounded(0.80, 'D'), grounded(0.40, 'E')];
const plan = L.planBands(queue);
// post-inversion: all 4 GROUNDED items promote (substantiated, any confidence); the 1 ungrounded-but-confident
// item routes to research (grounding gate). Nothing parks here — a thin+unsourced item would.
ok(plan.counts.promote === 4 && plan.counts.research === 1 && plan.counts.park === 0, 'planBands partitions the queue: 4 promote (grounded) / 1 research (ungrounded) / 0 park');
ok(plan.promote.every((p) => L.isGrounded(p)) , 'planBands: every promote-band item is grounded (the invariant holds)');
ok(plan.promote.length === 4 && plan.promote[0].name === 'A', 'planBands: the promote bucket carries the actual proposals');

// --- drainUntilEmpty (chunked drain-until-empty) ---------------------------------------------------
(async () => {
  console.log('== drainUntilEmpty ==');
  // a queue of 250 promotable, chunk of 100 → drains in 3 chunks (100, 100, 50 → remaining 0)
  let left = 250;
  const chunk100 = async () => { const took = Math.min(100, left); left -= took; return { promoted: took, remaining: left }; };
  const dr = await L.drainUntilEmpty(chunk100);
  ok(dr.stopped === 'drained' && dr.totalPromoted === 250 && dr.iters === 3, 'drains 250 in chunks of 100 → 3 iters, drained, 250 promoted');

  // stops when a chunk makes NO progress (only the park-remainder is left — don't spin)
  let calls = 0;
  const stall = async () => { calls++; return { promoted: 0, remaining: 42 }; };
  const drStall = await L.drainUntilEmpty(stall);
  ok(drStall.stopped === 'no-progress' && calls === 1, 'no-progress (0 promoted but items remain) → stops after one chunk (never spins on the park remainder)');

  // the runaway backstop: remaining never reaches 0 but each chunk claims progress → capped at maxIters
  const forever = async () => ({ promoted: 1, remaining: 999 });
  const drCap = await L.drainUntilEmpty(forever, { maxIters: 5 });
  ok(drCap.stopped === 'max-iters' && drCap.iters === 5, 'a chunk that never drains is capped at maxIters (runaway backstop)');

  // fail-soft: a throwing chunk stops the loop, never propagates
  const boom = async () => { throw new Error('echo down'); };
  const drErr = await L.drainUntilEmpty(boom);
  ok(drErr.stopped === 'error' && drErr.totalPromoted === 0, 'a chunk that throws → stops (error), never propagates');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
