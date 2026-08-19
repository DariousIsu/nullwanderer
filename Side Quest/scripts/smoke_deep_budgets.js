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
// (2026-08-19) The lane ceilings below were RESTORED to the code defaults (see the ceilings block), so a
// LIVE .env and a no-.env rehearsal sandbox now AGREE — the old sandbox-skip for that divergence is gone.

// --- bold config defaults ---
ok(cfg.deepNumCtx() === 32768, `deepNumCtx default 32768 (was an 8192 window) — got ${cfg.deepNumCtx()}`);
ok(cfg.deepNumPredict() === 3000, `deepNumPredict default 3000 (was 200-1000) — got ${cfg.deepNumPredict()}`);
ok(cfg.sectionNumPredict() === 6000, `sectionNumPredict default 6000 (research sections, was 1800-2000) — got ${cfg.sectionNumPredict()}`);

// --- lane ceilings (RESTORED 2026-08-19) ---
// Lifted to defaults for Slice 1 ("don't throttle the fat deep calls"), REVERSED to a hard 15k/3k/10k on
// 07-31 (cloud quota hit 90.8% — an emergency brake), then RESTORED here. lib/quota was loosened on 08-15
// ("fund the consciousness organs") but these per-lane caps were left at the 07-31 values, binding TIGHTER
// than the pool pacer they were meant to defer to — measured 08-19 at ~53% of sustainable used, half the
// weekly pool stranded. All three idle lanes ALSO pass quota_gate.allow('idle') (monologue.js:1249/1878/
// 2115), so lib/quota — pacing against remaining/time-to-reset, chat reserve intact — is the real backstop,
// exactly as the 07-31 note intended ("lib/quota is the thing that decides"). This is the on-purpose raise
// that note asked for once the quota stopped being the constraint (16.6% used). .env now matches these
// defaults, so live == sandbox.
ok(cfg.graphwalkBudgetTokensPerHour() === 300000, `graphwalk ceiling at the default 300k (pool pacer governs) — got ${cfg.graphwalkBudgetTokensPerHour()}`);
ok(cfg.pullerBudgetTokensPerHour() === 150000, `puller ceiling at the default 150k (pool pacer governs) — got ${cfg.pullerBudgetTokensPerHour()}`);
ok(cfg.subcBudgetTokensPerHour() === 120000, `subconscious ceiling at the default 120k (the consciousness organs) — got ${cfg.subcBudgetTokensPerHour()}`);

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
