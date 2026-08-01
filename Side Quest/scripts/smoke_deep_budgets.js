/* Smoke: DEEP CALL BUDGETS (cloud-leverage Slice 1). The config knobs carry bold defaults, the lane
 * ceilings were lifted so the fatter calls aren't throttled, and the fatten is actually APPLIED at a call
 * site (decomp_lane feeds the injected completeFn the deep num_ctx, not 8192).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_deep_budgets.js
 */
'use strict';
const cfg = require('../lib/config');
const decompLane = require('../lib/decomp_lane');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- bold config defaults ---
ok(cfg.deepNumCtx() === 32768, `deepNumCtx default 32768 (was an 8192 window) — got ${cfg.deepNumCtx()}`);
ok(cfg.deepNumPredict() === 3000, `deepNumPredict default 3000 (was 200-1000) — got ${cfg.deepNumPredict()}`);
ok(cfg.sectionNumPredict() === 6000, `sectionNumPredict default 6000 (research sections, was 1800-2000) — got ${cfg.sectionNumPredict()}`);

// --- lane ceilings ---
// ⚠ REVERSED 2026-07-31, deliberately. These were lifted (60k→300k, 40k→150k) so the fatter deep
// calls would not throttle to a trickle — correct when the ALLOWANCE was not the binding constraint.
// It is now: the weekly cloud quota hit 90.8% with two days left, and the ceilings were so far above
// actual burn (~42k/h graphwalk against a 300k cap) that they could never bind. A cap 7x above what a
// lane spends is not a cap. The .env values below are just under the measured rate so they bite, and
// lib/quota is the thing that decides from here — it paces against remaining/time-to-reset, which is
// a question no fixed hourly number can answer.
// If the quota stops being the constraint, raise these again ON PURPOSE rather than by drift.
ok(cfg.graphwalkBudgetTokensPerHour() === 15000, `graphwalk ceiling BOUND to 15k — measured burn was ~42k/h against a 300k cap — got ${cfg.graphwalkBudgetTokensPerHour()}`);
ok(cfg.pullerBudgetTokensPerHour() === 3000, `puller ceiling BOUND to 3k — measured burn was ~1.3k/h against a 150k cap — got ${cfg.pullerBudgetTokensPerHour()}`);

// --- Slice 4: denser subconscious (concurrent lanes + graph-walk burst) ---
ok(cfg.subcMovesPerTick() === 3, `subcMovesPerTick default 3 (graph-walk burst) — got ${cfg.subcMovesPerTick()}`);
ok(cfg.subcConcurrentLanes() === true, `subcConcurrentLanes default ON (lanes fire in parallel) — got ${cfg.subcConcurrentLanes()}`);

// --- Slice 5: the research PLAN (whole-project blueprint) authored on the deep reasoner, not the fast 31B ---
ok(/gpt-oss|:120b|qwen|reason/i.test(cfg.deepReasonerModel()) && cfg.deepReasonerModel().length > 0, `deepReasonerModel is a big reasoner — got ${cfg.deepReasonerModel()}`);

// --- the fatten is ACTUALLY APPLIED at a call site: decomp_lane feeds the deep num_ctx, not 8192 ---
(async () => {
  let seenCtx = null, seenPredict = null;
  const captureFn = async ({ options } = {}) => { seenCtx = options && options.num_ctx; seenPredict = options && options.num_predict; return '{"entities":[],"relations":[]}'; };
  const extract = decompLane.makeCloudExtractor({ completeFn: captureFn, model: 'x', numPredict: cfg.deepNumPredict() });
  await extract('some document text', { title: 'Doc' });
  ok(seenCtx === 32768, `decomp_lane extractor feeds num_ctx=deepNumCtx (32768), not the old 8192 — got ${seenCtx}`);
  ok(seenPredict === 3000, `decomp_lane extractor carries the deep num_predict (3000) — got ${seenPredict}`);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
