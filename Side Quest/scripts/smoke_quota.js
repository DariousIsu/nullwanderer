/* Smoke: lib/quota — ONE budget for a finite pool that refills on a date.
 *
 * Built 2026-07-31 after the Ollama allowance hit 90.8% of the WEEK with two days left and nothing
 * noticed, because the four existing controls were RATE LIMITERS with no notion of a period.
 *
 * ⭐ THE UNIT IS COMPUTE. Tokens were the first attempt and requests the second; the provider bills
 * compute, and the two naive units RANK THE LANES DIFFERENTLY. gemma4:31b has 3x the requests of
 * deepseek-v4-flash and occupies less of the dashboard bar, so counting calls would have sent us
 * optimising the wrong model. Weighting tokens by model size reproduces the observed proportions.
 *
 * The assertions are mostly about the two ways a throttle fails: letting the pool run dry, and
 * silencing her to save it.
 *
 * Pure: no model/file/db/network. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_quota.js
 */
'use strict';
const q = require('../lib/quota');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const H = q.HOUR;
const NOW = 1_800_000_000_000;
// the live situation: 90% gone, ~2 days to reset
const POOL = 10_354_420;   // compute units, derived from the dashboard (see the config note)
const live = q.state({ limit: POOL, markPct: 0.908, markAt: NOW, spentSince: 0, resetAt: NOW + 48 * H, now: NOW });

// --- ⭐ COMPUTE WEIGHTS: the term both earlier units were missing ---------------------------------
ok(q.weightFor('gemma4:31b') === 31 && q.weightFor('gpt-oss:120b') === 120 && q.weightFor('mistral-large-3:675b') === 675,
  '⭐ a model that states its size in its name is weighted by it');
ok(q.weightFor('deepseek-v4-flash') === 100, 'a name with no size falls back to a named weight');
ok(q.weightFor('some-model-nobody-has-seen') === q.DEFAULT_WEIGHT && q.DEFAULT_WEIGHT >= 100,
  '⭐ an UNKNOWN model is weighted HIGH — under-costing a new frontier model is the expensive error');
ok(q.costOf({ model: 'mistral-large-3:675b', tokens: 2000 }) > 20 * q.costOf({ model: 'gemma4:31b', tokens: 2000 }),
  '⭐ a 675b call costs >20x a 31b call of the same length — the spread no unweighted counter can see');
ok(q.costOf({ model: 'gemma4:31b', tokens: 0 }) === 0 && q.costOf({}) === 0, 'no tokens, no cost; empty input never throws');

// --- state: the arithmetic that was missing ----------------------------------------------------
ok(live.known && Math.abs(live.usedPct - 0.908) < 1e-9, 'reads the operator mark as the anchor');
ok(Math.round(live.remaining) === Math.round(POOL * 0.092), '⭐ 9.2% of the compute pool left — the real position');
ok(Math.round(live.pacePerHour) === Math.round(POOL * 0.092 / 48), '⭐ sustainable = remaining / hours left');
ok(/91% used/.test(q.describe(live)) && /sustainable/.test(q.describe(live)), 'describe() states it in one line');

// spend after the mark is tracked as a delta — the provider's counter is not readable from here
const later = q.state({ limit: POOL, markPct: 0.908, markAt: NOW, spentSince: 4_000, resetAt: NOW + 48 * H, now: NOW });
ok(later.remaining === live.remaining - 4_000, '⭐ metered compute accrues ON TOP of the operator mark');
ok(later.pacePerHour < live.pacePerHour, '…and the sustainable rate TIGHTENS as the pool drains');

// --- the failure this is for: burning the pool before the reset --------------------------------
{
  // TWO gates stop this, and at 90% the stronger one fires FIRST. The tier floor puts idle work out
  // of bounds past 85% of the pool, so the measured 41,944 tok/h graph-walk burn never even reaches
  // the pace check. Asserting the pace message here would have been asserting the weaker guarantee.
  const r = q.check({ lane: 'idle', st: live, spentLastHour: 60_000, estimate: 62 });
  ok(!r.allow, '⭐ the measured idle burn is STOPPED at 90.8% used');
  ok(/stops at 85% of the pool/.test(r.reason) && /now 91%/.test(r.reason),
    'and the refusal names the floor it hit, with the number');
  ok(!q.check({ lane: 'idle', st: live, spentLastHour: 0, estimate: 10 }).allow,
    'past its floor, idle is off regardless of how quiet it has been — a floor is not a rate');
}
{
  // EARLIER in the period the floor is not in play, so the PACE gate is what does the work. Same
  // 41,944 tok/h burn, 50% used, 48h left → sustainable 10,416 tok/h, idle share 20% ≈ 2,083.
  const mid = q.state({ limit: POOL, markPct: 0.50, markAt: NOW, spentSince: 0, resetAt: NOW + 48 * H, now: NOW });
  const r = q.check({ lane: 'idle', st: mid, spentLastHour: 60_000, estimate: 62 });
  ok(!r.allow && /over burn-down pace/.test(r.reason), '⭐ mid-period, the same burn is stopped by PACE');
  ok(/48\.0h to reset/.test(r.reason) && /left/.test(r.reason), 'and the refusal shows the arithmetic, not just "denied"');
  ok(q.check({ lane: 'idle', st: mid, spentLastHour: 100, estimate: 62 }).allow,
    'a quiet idle lane still runs — this paces, it does not switch things off');
}

// --- the OTHER failure: throttling her into silence --------------------------------------------
{
  const broke = q.state({ limit: POOL, markPct: 0.995, markAt: NOW, spentSince: 0, resetAt: NOW + 24 * H, now: NOW });
  ok(q.check({ lane: 'interactive', st: broke, spentLastHour: 99_999 }).allow,
    '⭐ at 99.5% spent, an INTERACTIVE turn is still allowed — she must never go mute to protect a sweep');
  ok(!q.check({ lane: 'idle', st: broke, spentLastHour: 0, estimate: 10 }).allow,
    '…while idle drift is long since stopped');
  ok(!q.check({ lane: 'research', st: broke, spentLastHour: 0, estimate: 10 }).allow,
    '…and so is autonomous research');
}
// tier ordering: idle yields before research, and directed (user work) is floor-gated only
{
  const tight = q.state({ limit: POOL, markPct: 0.88, markAt: NOW, spentSince: 0, resetAt: NOW + 24 * H, now: NOW });
  const spend = 20_000;
  const a = q.check({ lane: 'idle', st: tight, spentLastHour: spend });
  const b = q.check({ lane: 'directed', st: tight, spentLastHour: spend });
  ok(!a.allow && b.allow, '⭐ under pressure IDLE yields first and DIRECTED work continues');
}
// DIRECTED IS NEVER PACE-THROTTLED (2026-08-12) — the restriction belongs on BACKGROUND work, never on
// user-assigned research. A heavy BACKGROUND hour that pauses idle/research must NOT pause his project
// (the measured Applied Digital #3792 bug: deferred tick after tick at 110k/h while background ran).
{
  const mid = q.state({ limit: POOL, markPct: 0.50, markAt: NOW, spentSince: 0, resetAt: NOW + 48 * H, now: NOW });
  const heavyHour = 999_999;   // far over any sustainable pace
  ok(!q.check({ lane: 'idle', st: mid, spentLastHour: heavyHour }).allow, 'a heavy hour pace-throttles IDLE (subconscious yields first)');
  ok(!q.check({ lane: 'research', st: mid, spentLastHour: heavyHour }).allow, 'a heavy hour pace-throttles autonomous RESEARCH');
  ok(q.check({ lane: 'directed', st: mid, spentLastHour: heavyHour }).allow, '⭐ DIRECTED (user work) is NEVER pace-throttled — floor-gated only; background yields to it');
  const nearEmpty = q.state({ limit: POOL, markPct: 0.98, markAt: NOW, spentSince: 0, resetAt: NOW + 48 * H, now: NOW });
  ok(!q.check({ lane: 'directed', st: nearEmpty, spentLastHour: 0 }).allow, 'directed STILL stops at the FLOOR (pool genuinely empty — the interactive reserve is protected)');
}

// --- fail-open, because a missing config must not brick her ------------------------------------
ok(q.check({ lane: 'idle', st: null }).allow, 'no state → allowed (a throttle that fails closed on a config gap is a bug)');
ok(q.check({ lane: 'idle', st: q.state({ limit: 0 }) }).allow, 'no limit configured → unlimited, and describe() says so');
ok(/not configured/.test(q.describe(q.state({ limit: 0 }))), '…and it admits it rather than implying a ceiling exists');
ok(q.check({ lane: 'nonsense', st: live, spentLastHour: 60_000 }).allow === false, 'an unknown lane is treated as idle, not as privileged');

// --- the reset edge ----------------------------------------------------------------------------
{
  const atReset = q.state({ limit: POOL, markPct: 0.99, markAt: NOW, spentSince: 0, resetAt: NOW, now: NOW });
  ok(atReset.pacePerHour === Infinity, 'at the reset boundary pacing stops constraining — the pool is refilling');
  ok(!q.check({ lane: 'idle', st: atReset, spentLastHour: 0 }).allow,
    '…but the tier FLOOR still holds: 99% used is past where idle work is allowed at all');
}

// --- USE-IT-OR-LOSE-IT (2026-08-15): the endgame ramp spends the surplus instead of stranding it ---
{
  // Same relative burn — half the sustainable rate — far from the reset vs inside the final window.
  const far = q.state({ limit: POOL, markPct: 0.5, markAt: NOW, spentSince: 0, resetAt: NOW + 48 * H, now: NOW });
  const burnFar = far.pacePerHour * 0.5;
  ok(!q.check({ lane: 'idle', st: far, spentLastHour: burnFar }).allow,
    'ramp: far from the reset the base idle share (20%) still governs — half-pace burn is over it');
  const near = q.state({ limit: POOL, markPct: 0.5, markAt: NOW, spentSince: 0, resetAt: NOW + 12 * H, now: NOW });
  const burnNear = near.pacePerHour * 0.5;
  ok(q.check({ lane: 'idle', st: near, spentLastHour: burnNear }).allow,
    '⭐ ramp: 12h from the reset the same half-pace burn is ALLOWED — expiring surplus opens the throttle');
  const last = q.state({ limit: POOL, markPct: 0.5, markAt: NOW, spentSince: 0, resetAt: NOW + 1 * H, now: NOW });
  ok(q.check({ lane: 'research', st: last, spentLastHour: last.pacePerHour * 0.9 }).allow,
    'ramp: in the final hour research may burn ~the full sustainable rate (share → ~95%)');
  ok(!q.check({ lane: 'research', st: last, spentLastHour: last.pacePerHour * 0.97 }).allow,
    'ramp: …but never past it — the cap tops out below 100% of sustainable');
  // The FLOOR is untouched by the ramp: a nearly-empty pool still hard-stops background work.
  const empty = q.state({ limit: POOL, markPct: 0.995, markAt: NOW, spentSince: 0, resetAt: NOW + 1 * H, now: NOW });
  ok(!q.check({ lane: 'idle', st: empty, spentLastHour: 0, estimate: 10 }).allow,
    '⭐ ramp never touches the FLOOR — at 99.5% used, idle stays stopped and the chat reserve survives');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
