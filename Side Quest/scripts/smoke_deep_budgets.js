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

// --- lane ceilings lifted so the fatter deep calls don't throttle to a trickle ---
ok(cfg.graphwalkBudgetTokensPerHour() === 300000, `graphwalk ceiling lifted to 300k (was 60k) — got ${cfg.graphwalkBudgetTokensPerHour()}`);
ok(cfg.pullerBudgetTokensPerHour() === 150000, `puller ceiling lifted to 150k (was 40k) — got ${cfg.pullerBudgetTokensPerHour()}`);

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
