'use strict';
/* Smoke: lib/lane spend-tier resolution (2026-08-12 review H2/M5).
 * The bug family: (H2) runCloudOperator's autonomous default keyed 'directed' on GLOBAL focus
 * state, so background passes running alongside Lucas's standing focus self-labeled 'directed' and
 * escaped the pace governor; (M5) condenseComplete's ~20 sites passed no lane and billed
 * 'interactive', bypassing the choke-point gate entirely. Cure: pure resolution (explicit →
 * ambient → autonomous 'research' → undefined) + ambient spendTier carried by lane.run.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_lane_tier.js
 */
const lane = require('../lib/lane');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── resolveSpendTier: the pure order ──
ok(lane.resolveSpendTier({ explicit: 'research', ambient: 'directed', autonomous: true }) === 'research',
  'explicit wins over ambient (a call site that knows best is never overridden)');
ok(lane.resolveSpendTier({ explicit: undefined, ambient: 'directed', autonomous: true }) === 'directed',
  'no explicit → ambient (the orchestrator declared the run tier once)');
ok(lane.resolveSpendTier({ explicit: undefined, ambient: undefined, autonomous: true }) === 'research',
  "autonomous with no declaration → 'research' — an unattended run NEVER defaults to an ungated tier (the H2 hole)");
ok(lane.resolveSpendTier({ explicit: undefined, ambient: undefined, autonomous: false }) === undefined,
  'interactive (non-autonomous, no declaration) → undefined — the reply path is never gated');
ok(lane.resolveSpendTier({}) === undefined, 'empty input → undefined (fail-safe: legacy behavior)');
ok(lane.resolveSpendTier({ explicit: 'interactive', ambient: 'research', autonomous: true }) === 'interactive',
  "an explicit 'interactive' still wins (mute-safety: a caller that opted OUT stays out)");

// ── ambient carriage: lane.run({spendTier}) → ambientSpendTier() inside the chain ──
(async () => {
  const seen = await lane.run({ autonomous: true, spendTier: 'directed' }, async () => {
    await new Promise((r) => setTimeout(r, 5));   // survive an await boundary
    return lane.ambientSpendTier();
  });
  ok(seen === 'directed', 'ambient spendTier survives await boundaries inside run()');

  const outer = await lane.run({ autonomous: true, spendTier: 'research' }, async () =>
    lane.run({ autonomous: true, spendTier: 'directed' }, async () => lane.ambientSpendTier()));
  ok(outer === 'directed', 'a nested run OVERRIDES the outer tier (the directed pass inside a background wrapper wins)');

  ok(lane.ambientSpendTier() === undefined, 'outside any run → undefined (bare legacy calls stay interactive at the choke)');

  // ⭐ audit S7/S20: a BARE-AUTONOMOUS run (autonomous:true, no spendTier) must resolve 'research'
  // at the READ point, not fall through to ollama's ungated 'interactive' — the subconscious
  // thought and hourly news-compression cloud calls were invisible to the burn-down pace.
  const bareAuto = await lane.run({ autonomous: true }, async () => { await new Promise((r) => setTimeout(r, 3)); return lane.ambientSpendTier(); });
  ok(bareAuto === 'research', '⭐ bare-autonomous run resolves research at ambientSpendTier (paced + gated), never interactive');
  const bareFg = await lane.run({}, async () => lane.ambientSpendTier());
  ok(bareFg === undefined, 'a bare NON-autonomous run stays undefined (foreground chat is not force-paced)');

  // ── the choke-point contract (mirrors lib/ollama's fallback line) ──
  const chokeLane = (explicit) => explicit != null ? explicit : (lane.ambientSpendTier() || 'interactive');
  ok(chokeLane(undefined) === 'interactive', 'choke: bare call outside a run → interactive (legacy untouched)');
  const inRun = await lane.run({ spendTier: 'research' }, async () => chokeLane(undefined));
  ok(inRun === 'research', 'choke: a bare call INSIDE a research run inherits research (the M5 cure — condenseComplete now billed honestly)');
  const explicitWins = await lane.run({ spendTier: 'research' }, async () => chokeLane('idle'));
  ok(explicitWins === 'idle', 'choke: an explicit lane beats the ambient run tier');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('SMOKE CRASH:', e); process.exit(1); });
