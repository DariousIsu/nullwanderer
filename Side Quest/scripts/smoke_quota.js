/* Smoke: lib/quota — ONE budget for a finite pool that refills on a date.
 *
 * Built 2026-07-31 after the Ollama allowance hit 90% with two days left and nothing noticed, because
 * the four existing controls were RATE LIMITERS with no notion of a period. The assertions below are
 * mostly about the two ways a throttle fails: letting the pool run dry, and silencing her to save it.
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
const live = q.state({ limit: 1_000_000, markPct: 0.90, markAt: NOW, spentSince: 0, resetAt: NOW + 48 * H, now: NOW });

// --- state: the arithmetic that was missing ----------------------------------------------------
ok(live.known && live.usedPct === 0.9, 'reads the operator mark as the anchor');
ok(live.remaining === 100_000, '100k of 1M left');
ok(Math.round(live.pacePerHour) === 2083, '⭐ sustainable rate = remaining / hours left (100k / 48h ≈ 2,083 tok/h)');
ok(/90% used/.test(q.describe(live)) && /2,083 tok\/h/.test(q.describe(live)), 'describe() states it in one line');

// spend after the mark is tracked as a delta — the provider's counter is not readable from here
const later = q.state({ limit: 1_000_000, markPct: 0.90, markAt: NOW, spentSince: 40_000, resetAt: NOW + 48 * H, now: NOW });
ok(later.usedPct === 0.94 && later.remaining === 60_000, '⭐ metered spend accrues ON TOP of the operator mark');
ok(later.pacePerHour < live.pacePerHour, '…and the sustainable rate TIGHTENS as the pool drains');

// --- the failure this is for: burning the pool before the reset --------------------------------
{
  // TWO gates stop this, and at 90% the stronger one fires FIRST. The tier floor puts idle work out
  // of bounds past 85% of the pool, so the measured 41,944 tok/h graph-walk burn never even reaches
  // the pace check. Asserting the pace message here would have been asserting the weaker guarantee.
  const r = q.check({ lane: 'idle', st: live, spentLastHour: 41_944, estimate: 1_200 });
  ok(!r.allow, '⭐ the measured 41,944 tok/h idle burn is STOPPED at 90% used');
  ok(/stops at 85% of the pool/.test(r.reason) && /now 90%/.test(r.reason),
    'and the refusal names the floor it hit, with the number');
  ok(!q.check({ lane: 'idle', st: live, spentLastHour: 0, estimate: 10 }).allow,
    'past its floor, idle is off regardless of how quiet it has been — a floor is not a rate');
}
{
  // EARLIER in the period the floor is not in play, so the PACE gate is what does the work. Same
  // 41,944 tok/h burn, 50% used, 48h left → sustainable 10,416 tok/h, idle share 20% ≈ 2,083.
  const mid = q.state({ limit: 1_000_000, markPct: 0.50, markAt: NOW, spentSince: 0, resetAt: NOW + 48 * H, now: NOW });
  const r = q.check({ lane: 'idle', st: mid, spentLastHour: 41_944, estimate: 1_200 });
  ok(!r.allow && /over burn-down pace/.test(r.reason), '⭐ mid-period, the same burn is stopped by PACE');
  ok(/48\.0h to reset/.test(r.reason) && /left/.test(r.reason), 'and the refusal shows the arithmetic, not just "denied"');
  ok(q.check({ lane: 'idle', st: mid, spentLastHour: 100, estimate: 200 }).allow,
    'a quiet idle lane still runs — this paces, it does not switch things off');
}

// --- the OTHER failure: throttling her into silence --------------------------------------------
{
  const broke = q.state({ limit: 1_000_000, markPct: 0.995, markAt: NOW, spentSince: 0, resetAt: NOW + 24 * H, now: NOW });
  ok(q.check({ lane: 'interactive', st: broke, spentLastHour: 999_999 }).allow,
    '⭐ at 99.5% spent, an INTERACTIVE turn is still allowed — she must never go mute to protect a sweep');
  ok(!q.check({ lane: 'idle', st: broke, spentLastHour: 0, estimate: 10 }).allow,
    '…while idle drift is long since stopped');
  ok(!q.check({ lane: 'research', st: broke, spentLastHour: 0, estimate: 10 }).allow,
    '…and so is autonomous research');
}
// tier ordering: idle yields before research, research before directed
{
  const tight = q.state({ limit: 1_000_000, markPct: 0.88, markAt: NOW, spentSince: 0, resetAt: NOW + 24 * H, now: NOW });
  const spend = 3_000;
  const a = q.check({ lane: 'idle', st: tight, spentLastHour: spend });
  const b = q.check({ lane: 'directed', st: tight, spentLastHour: spend });
  ok(!a.allow && b.allow, '⭐ under pressure IDLE yields first and DIRECTED work continues');
}

// --- fail-open, because a missing config must not brick her ------------------------------------
ok(q.check({ lane: 'idle', st: null }).allow, 'no state → allowed (a throttle that fails closed on a config gap is a bug)');
ok(q.check({ lane: 'idle', st: q.state({ limit: 0 }) }).allow, 'no limit configured → unlimited, and describe() says so');
ok(/not configured/.test(q.describe(q.state({ limit: 0 }))), '…and it admits it rather than implying a ceiling exists');
ok(q.check({ lane: 'nonsense', st: live, spentLastHour: 41_944 }).allow === false, 'an unknown lane is treated as idle, not as privileged');

// --- the reset edge ----------------------------------------------------------------------------
{
  const atReset = q.state({ limit: 1_000_000, markPct: 0.99, markAt: NOW, spentSince: 0, resetAt: NOW, now: NOW });
  ok(atReset.pacePerHour === Infinity, 'at the reset boundary pacing stops constraining — the pool is refilling');
  ok(!q.check({ lane: 'idle', st: atReset, spentLastHour: 0 }).allow,
    '…but the tier FLOOR still holds: 99% used is past where idle work is allowed at all');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
