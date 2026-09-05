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
  // BEHIND schedule the floor is not in play, so the PACE gate is what does the work. (Was 50%
  // used / 48h left — that shape is AHEAD of the weekly schedule and now legitimately BURSTS per
  // the 08-29 rule, so this pin's state moved to 80% used, genuinely behind, where pacing governs.)
  const mid = q.state({ limit: POOL, markPct: 0.80, markAt: NOW, spentSince: 0, resetAt: NOW + 48 * H, now: NOW });
  const r = q.check({ lane: 'idle', st: mid, spentLastHour: 60_000, estimate: 62 });
  ok(!r.allow && /over burn-down pace/.test(r.reason), '⭐ behind schedule, the same burn is stopped by PACE');
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
  // (0.50/48h was AHEAD of the weekly schedule and now bursts by the 08-29 rule — these states
  // moved to 0.80/48h, genuinely behind, where the pace gate is still the law.)
  const mid = q.state({ limit: POOL, markPct: 0.80, markAt: NOW, spentSince: 0, resetAt: NOW + 48 * H, now: NOW });
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
  // (These states are BEHIND schedule by design — an ahead pool bursts per the 08-29 rule, which
  // supersedes the ramp exactly when the surplus would expire anyway.)
  const far = q.state({ limit: POOL, markPct: 0.80, markAt: NOW, spentSince: 0, resetAt: NOW + 48 * H, now: NOW });
  const burnFar = far.pacePerHour * 0.5;
  ok(!q.check({ lane: 'idle', st: far, spentLastHour: burnFar }).allow,
    'ramp: far from the reset the base idle share still governs — half-pace burn is over it');
  const near = q.state({ limit: POOL, markPct: 0.5, markAt: NOW, spentSince: 0, resetAt: NOW + 12 * H, now: NOW });
  const burnNear = near.pacePerHour * 0.5;
  ok(q.check({ lane: 'idle', st: near, spentLastHour: burnNear }).allow,
    '⭐ ramp: 12h from the reset the same half-pace burn is ALLOWED — expiring surplus opens the throttle');
  // usage law (09-03): the burst margin is 0.02, so a final-hour pool at 89.5% is AHEAD (99% of the window
  // elapsed) and BURSTS — the surplus expires anyway; the ramp yields to the burst rule there.
  const last = q.state({ limit: POOL, markPct: 0.895, markAt: NOW, spentSince: 0, resetAt: NOW + 1 * H, now: NOW });
  ok(q.check({ lane: 'research', st: last, spentLastHour: last.pacePerHour * 0.9 }).allow,
    'ramp: in the final hour research may burn ~the full sustainable rate (an ahead pool bursts; the surplus expires)');
  // …and where the pool is NOT ahead (82% used, 30h out = 82.1% elapsed), the ramp has begun (share ≈ 0.66) and
  // caps BELOW the whole rate: behind schedule, the cap tops out under 100% of sustainable.
  const mid30 = q.state({ limit: POOL, markPct: 0.82, markAt: NOW, spentSince: 0, resetAt: NOW + 30 * H, now: NOW });
  ok(q.check({ lane: 'research', st: mid30, spentLastHour: mid30.pacePerHour * 0.5 }).allow && !q.check({ lane: 'research', st: mid30, spentLastHour: mid30.pacePerHour * 0.97 }).allow,
    'ramp: …but never past it — behind schedule the cap tops out below 100% of sustainable');
  // The FLOOR is untouched by the ramp: a nearly-empty pool still hard-stops background work.
  const empty = q.state({ limit: POOL, markPct: 0.995, markAt: NOW, spentSince: 0, resetAt: NOW + 1 * H, now: NOW });
  ok(!q.check({ lane: 'idle', st: empty, spentLastHour: 0, estimate: 10 }).allow,
    '⭐ ramp never touches the FLOOR — at 99.5% used, idle stays stopped and the chat reserve survives');
}

// --- ⭐ THE BURST RULE (08-29, Lucas: "we have zero quota constraints" at 48% used / 24h left):
// an ahead-of-schedule pool is surplus that EXPIRES at reset — pacing it is waste ----------------
{
  const ahead = q.state({ limit: POOL, markPct: 0.482, markAt: NOW, spentSince: 0, resetAt: NOW + 24 * H, now: NOW });
  const r = q.check({ lane: 'research', st: ahead, spentLastHour: 500_000, estimate: 1000 });
  ok(r.allow && r.burst === true && /ahead of schedule/.test(r.reason), '⭐ 48% used with 24h left → research BURSTS past the hourly pace (the live 08-29 bind, replayed)');
  ok(q.check({ lane: 'idle', st: ahead, spentLastHour: 500_000, estimate: 10 }).allow, 'idle bursts too — the surplus expires either way');
  // usage law (09-03): the margin is 0.02 — ahead of schedule at all is no pacing; only INSIDE 2% does pacing govern
  const barelyAhead = q.state({ limit: POOL, markPct: 0.70, markAt: NOW, spentSince: 0, resetAt: NOW + 48 * H, now: NOW });
  ok(!q.check({ lane: 'idle', st: barelyAhead, spentLastHour: 60_000, estimate: 62 }).allow,
    'inside the margin (70% vs 71% elapsed) → no burst, pacing governs — the rule never flaps');
  const fiveAhead = q.state({ limit: POOL, markPct: 0.66, markAt: NOW, spentSince: 0, resetAt: NOW + 48 * H, now: NOW });
  ok(q.check({ lane: 'idle', st: fiveAhead, spentLastHour: 60_000, estimate: 62 }).burst === true,
    '5% ahead (66% vs 71% elapsed) BURSTS under the 0.02 margin — the old 0.10 margin paced a pool that was ahead (his law: "we are still on the very conservative side")');
  const floorCase = q.state({ limit: POOL, markPct: 0.86, markAt: NOW, spentSince: 0, resetAt: NOW + 1 * H, now: NOW });
  ok(!q.check({ lane: 'idle', st: floorCase, spentLastHour: 0, estimate: 10 }).allow,
    '⭐ the FLOOR precedes the burst — 86% used never bursts idle past its 85% stop; the chat reserve survives every burst');
  ok(q.WINDOW_H === 168 && q.BURST_AHEAD_MARGIN === 0.02, 'the window and margin are named constants, exported for audit');
}

// ── ⭐ #115 (Lucas-approved): BACKGROUND paces against BACKGROUND spend — the symmetric of the
// directed exemption. Measured live: 40k+ all-lane compute in one build hour closed research at
// 19% of a barely-touched pool.
{
  // a mid-window pool (50% used, 84h left) so neither floor nor burst interferes with the pace test
  const st = q.state({ limit: 1000000, markPct: 0.5, markAt: Date.now() - 1000, spentSince: 0, resetAt: Date.now() + 84 * 3600e3 });
  const hot = st.pacePerHour * 2;   // an all-lane hour far past any share
  const r1 = q.check({ lane: 'research', st, spentLastHour: hot, spentLastHourBg: 0, estimate: 10 });
  ok(r1.allow === true, '⭐ a hot DIRECTED/interactive hour no longer closes research when background is quiet');
  const r2 = q.check({ lane: 'research', st, spentLastHour: hot, spentLastHourBg: hot, estimate: 10 });
  ok(r2.allow === false && /BACKGROUND/.test(r2.reason), 'a hot BACKGROUND hour still throttles background — the split is honest, not a bypass');
  const r3 = q.check({ lane: 'research', st, spentLastHour: hot, estimate: 10 });
  ok(r3.allow === false, 'without the split (old callers) the all-lane hour still governs — backward compatible');
  const st86 = q.state({ limit: 1000000, markPct: 0.86, markAt: Date.now() - 1000, spentSince: 0, resetAt: Date.now() + 84 * 3600e3 });
  ok(q.check({ lane: 'idle', st: st86, spentLastHour: 0, spentLastHourBg: 0 }).allow === false, 'the FLOOR still stops idle at 85% regardless of the split — the chat reserve is untouched');
  // hysteresis (the 09-01 flap): just-under pace passes an OPEN lane but not a REOPENING one
  const nearShare = st.pacePerHour * 0.60 * 0.95;
  ok(q.check({ lane: 'research', st, spentLastHour: nearShare, spentLastHourBg: nearShare }).allow === true, 'an open lane at 95% of share stays open');
  ok(q.check({ lane: 'research', st, spentLastHour: nearShare, spentLastHourBg: nearShare, reopening: true }).allow === false, '⭐ a CLOSED lane at 95% of share stays closed — reopen needs 85% headroom (no 1-minute strobing)');
  ok(q.check({ lane: 'research', st, spentLastHour: nearShare * 0.5, spentLastHourBg: nearShare * 0.5, reopening: true }).allow === true, 'comfortably under → the closed lane reopens');
}

// ── ⭐ THE USAGE LAW (Lucas 2026-09-03): four tiers; only EXPANSION is paced, and only when work is QUEUED
// above it; the cost-friendly fleet never trips the pace gate; development is its own unpaced tier. ──
console.log('\nthe usage law (four tiers, queued-above, the cheap fleet, burst 0.02):');
{
  // half the pool used with half the window left: exactly on schedule, so the burst rule stays out of the way
  const st = q.state({ limit: 1_000_000, markPct: 0.50, markAt: NOW, spentSince: 0, resetAt: NOW + 84 * H, now: NOW });
  const hot = st.pacePerHour * 0.9;   // a hot background hour: over research's 0.60 share, under the whole rate
  ok(q.TIER.development != null && q.TIER_FLOOR.development > 0 && q.TIER_FLOOR.development < q.TIER_FLOOR.research, 'a DEVELOPMENT tier exists, floored between directed and research');
  ok(q.check({ lane: 'development', st, spentLastHour: hot, spentLastHourBg: hot, queuedAbove: true }).allow === true, '⭐ development is never paced (floor-gated only) — the program building itself is not expansion');
  ok(q.check({ lane: 'research', st, spentLastHour: hot, spentLastHourBg: hot, queuedAbove: true }).allow === false, 'expansion IS paced while work is queued above it (his threads, his focus, the pen)');
  const free = q.check({ lane: 'research', st, spentLastHour: hot, spentLastHourBg: hot, queuedAbove: false });
  ok(free.allow === true && free.unpaced === true && /nothing queued above/.test(free.reason), '⭐ with NOTHING queued above, expansion may use the whole sustainable rate (use-it-or-lose-it)');
  ok(q.check({ lane: 'idle', st, spentLastHour: hot, spentLastHourBg: hot, queuedAbove: false }).allow === true, '…idle too (both expansion lanes)');
  ok(q.check({ lane: 'research', st, spentLastHour: st.pacePerHour * 1.2, spentLastHourBg: st.pacePerHour * 1.2, queuedAbove: false }).allow === false, '…but never MORE than the sustainable rate — the burn-down is the ceiling');
  ok(q.check({ lane: 'research', st, spentLastHour: hot, spentLastHourBg: hot }).allow === false, 'an old caller (queuedAbove unknown) keeps the conservative shares');
  const cheap = q.check({ lane: 'idle', st, spentLastHour: hot, spentLastHourBg: hot, queuedAbove: true, model: 'gemma4:31b-cloud' });
  ok(cheap.allow === true && cheap.cheap === true && /cheap model/.test(cheap.reason), '⭐ a cheap-model call (weight ≤ 35: gemma4:31b, the swarm) never trips the pace gate');
  ok(q.check({ lane: 'idle', st, spentLastHour: hot, spentLastHourBg: hot, queuedAbove: true, model: 'deepseek-v4-flash' }).allow === false, 'a heavy model on the same hot hour is paced');
  ok(q.CHEAP_WEIGHT === 35 && q.weightFor('gemma4:31b-cloud') <= q.CHEAP_WEIGHT && q.weightFor('gpt-oss:120b') > q.CHEAP_WEIGHT, 'the cheap line sits at 35B: gemma4:31b is under it, gpt-oss:120b is not');
  const st86 = q.state({ limit: 1_000_000, markPct: 0.86, markAt: NOW, spentSince: 0, resetAt: NOW + 84 * H, now: NOW });
  ok(q.check({ lane: 'idle', st: st86, spentLastHour: 0, spentLastHourBg: 0, queuedAbove: false, model: 'deepseek-v4-flash' }).allow === false, 'the FLOOR still stops idle at 85% for the paid fleet — queued or not (his chat reserve survives everything)');
  ok(q.check({ lane: 'idle', st: st86, spentLastHour: 0, spentLastHourBg: 0, queuedAbove: false, model: 'gemma4:31b-cloud' }).allow === true, 'the cheap fleet passes the 85% floor (Lucas 09-05: the autonomic lanes were dead a day and a half into the week); it stops at 97%');
  const st96 = q.state({ limit: 1_000_000, markPct: 0.96, markAt: NOW, spentSince: 0, resetAt: NOW + 84 * H, now: NOW });
  ok(q.check({ lane: 'development', st: st96, spentLastHour: 0 }).allow === false && q.check({ lane: 'directed', st: st96, spentLastHour: 0 }).allow === true, 'development stops at its 95% floor; directed still runs to 97% (the pool genuinely empty is the only stop)');
  ok(q.BURST_AHEAD_MARGIN <= 0.02, 'the burst margin is 0.02: ahead of schedule at all = no pacing');
  const ahead = q.state({ limit: 1_000_000, markPct: 0.45, markAt: NOW, spentSince: 0, resetAt: NOW + 84 * H, now: NOW });   // 45% used at 50% elapsed: 5% ahead
  ok(q.check({ lane: 'idle', st: ahead, spentLastHour: ahead.pacePerHour * 3, spentLastHourBg: ahead.pacePerHour * 3, queuedAbove: true }).burst === true, 'a pool 5% ahead of schedule bursts (the old 10% margin would have paced it)');
}

// ── the gate's queue read (impure: a hermetic sq.db) — what "queued above expansion" means live ──
console.log('\nquota_gate.queuedAbove (a hermetic store):');
{
  const os = require('os'), path = require('path'), fs = require('fs');
  process.env.SQ_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quota-smoke-')), 'sq.db');
  const db = require('../lib/db'); db.init();
  const gate = require('../lib/quota_gate');
  const focus = require('../lib/focus');
  gate._resetQueueCache();
  ok(gate.queuedAbove() === false && gate.queuedAboveWhy() === 'nothing above', 'an empty store: nothing queued above → expansion unpaced');
  const his = db.insertOpenThread({ content: 'research the grid interconnection queue in ERCOT for the summit' });
  gate._resetQueueCache();
  ok(gate.queuedAbove() === true && /1 of his threads/.test(gate.queuedAboveWhy()), '⭐ one pending thread of his → queued above → expansion paced');
  db.setMeta(`thread.${his.id}.spawned_from`, 'subc');                      // her own subconscious-born thread is NOT above expansion
  gate._resetQueueCache();
  ok(gate.queuedAbove() === false, 'a subconscious-born thread does not count — hers is expansion, not his');
  db.setMeta(`thread.${his.id}.spawned_from`, '');
  db.setMeta(`focus.${his.id}.beat`, 'county-commissions-tx');              // a beat's thread is the sweep's, not his
  gate._resetQueueCache();
  ok(gate.queuedAbove() === false, 'a beat-tagged thread does not count either');
  db.setMeta(`focus.${his.id}.beat`, '');
  db.markOpenThreadStatus(his.id, 'resolved', { reason: 'done' });
  gate._resetQueueCache();
  ok(gate.queuedAbove() === false, 'his thread resolved → nothing above again');
  (async () => {
    await focus.setFromDirective('study every right-of-center think tank overnight');
    gate._resetQueueCache();
    ok(gate.queuedAbove() === true && /his directed focus/.test(gate.queuedAboveWhy()), '⭐ his directed focus holding the slot → queued above → expansion paced');
    focus.clear('smoke');
    gate._resetQueueCache();
    ok(gate.queuedAbove() === false, 'the slot released → unpaced');
    const t0 = Date.now(); gate.queuedAbove(t0); db.insertOpenThread({ content: 'find the county clerk contacts for every Louisiana parish' });
    ok(gate.queuedAbove(t0 + 1000) === false && gate.queuedAbove(t0 + 31 * 1000) === true, 'the answer is cached 30 s (the gate is asked on every cloud call), then re-read');
    // the impure allow() carries the verdict through: with his thread pending, a hot research hour is paced
    gate._resetQueueCache();
    ok(gate.peek('research').queuedAbove === true && /of his threads/.test(gate.peek('research').queuedAboveWhy), 'peek() (the read door Echo asks) reports the queue state and why');
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
    // ── THE PRESENCE TIER (Lucas 09-05 16:20: "yes build all three, presence tier first") ──────────────────
    ok(q.tierOf('consciousness') === 'presence' && q.tierOf('autonomy') === 'presence' && q.tierOf('presence') === 'presence' && q.tierOf('whatever') === 'idle' && q.tierOf('') === 'idle', 'the slow loop and the autonomy tick are the presence tier under their own lane names; an unknown lane is still idle');
    const deep = q.state({ limit: POOL, markPct: 0.91, markAt: NOW, spentSince: 0, resetAt: NOW + 29 * H, now: NOW });   // the pool as measured 09-05 15:30
    ok(!q.check({ lane: 'idle', st: deep, spentLastHour: 0, estimate: 10, model: 'gpt-oss:120b-cloud' }).allow, 'at 91% idle is still stopped (the 85% floor)');
    const p1 = q.check({ lane: 'consciousness', st: deep, spentLastHour: 500_000, estimate: q.costOf({ model: 'glm-5.2:cloud', tokens: 1200 }), model: 'glm-5.2:cloud' });
    ok(p1.allow && /presence/.test(p1.reason), `the arrival's words pass at 91% with a hot hour: ${p1.reason}`);
    const p2 = q.check({ lane: 'autonomy', st: deep, spentLastHour: 500_000, estimate: q.costOf({ model: 'gpt-oss:120b-cloud', tokens: 9600 }), model: 'gpt-oss:120b-cloud' });
    ok(p2.allow && q.PRESENCE_MAX_TOKENS === 12288, 'the autonomy tick as it is (~9.5k tokens, measured on p315) passes on the presence tier, never paced');
    const p3 = q.check({ lane: 'presence', st: deep, spentLastHour: 0, estimate: q.costOf({ model: 'glm-5.2:cloud', tokens: 20_000 }), model: 'glm-5.2:cloud' });
    ok(!p3.allow && p3.capped && /over its cap/.test(p3.reason), `a 20k-token presence prompt is refused by the cap, whatever the pool: ${p3.reason.slice(0, 60)}`);
    const gone = q.state({ limit: POOL, markPct: 0.995, markAt: NOW, spentSince: 0, resetAt: NOW + 2 * H, now: NOW });
    ok(!q.check({ lane: 'presence', st: gone, spentLastHour: 0, estimate: 10, model: 'glm-5.2:cloud' }).allow, 'at 99.5% presence stops too (its 1% floor) — the last percent is his chat');
    // ── THE CHEAP FLEET THROUGH THE FLOORS ──────────────────────────────────────────────────────────────
    const c1 = q.check({ lane: 'idle', st: deep, spentLastHour: 500_000, estimate: q.costOf({ model: 'gemma4:31b-cloud', tokens: 5000 }), model: 'gemma4:31b-cloud' });
    ok(c1.allow && c1.cheap, 'at 91% an idle call on gemma4:31b passes: the cheap fleet stops at 97%, not 85%');
    const c2 = q.check({ lane: 'research', st: deep, spentLastHour: 500_000, estimate: 100, model: 'gemma4:31b-cloud' });
    ok(c2.allow && c2.cheap, 'the news lane on the cheap fleet is alive at 91% too');
    const at98 = q.state({ limit: POOL, markPct: 0.98, markAt: NOW, spentSince: 0, resetAt: NOW + 6 * H, now: NOW });
    ok(!q.check({ lane: 'idle', st: at98, spentLastHour: 0, estimate: 10, model: 'gemma4:31b-cloud' }).allow, 'at 98% even the cheap fleet stops for idle (97%)');
    ok(!q.check({ lane: 'idle', st: deep, spentLastHour: 0, estimate: 10, model: 'deepseek-v4-flash' }).allow, 'a non-cheap idle call at 91% is still stopped — the floors are unchanged for the paid fleet');
    ok(q.check({ lane: 'directed', st: deep, spentLastHour: 900_000, estimate: 1000, model: 'deepseek-v4-pro' }).allow, 'directed is untouched: floor-gated only (97%), never paced');
    // the callers ride the tier
    const fs = require('fs'), path = require('path');
    ok(/lane: 'consciousness'/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'slow_loop.js'), 'utf8')) && /lane: 'autonomy'/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'autonomy.js'), 'utf8')), 'the slow loop and the autonomy tick name their lanes');
    ok(/lanes: \['research', 'idle', 'presence', 'consciousness', 'autonomy', '\?'\]/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'quota_gate.js'), 'utf8')), 'presence spend counts as background in the pace of research and idle');
    process.exit(fail === 0 ? 0 : 1);
  })().catch((e) => { console.error('smoke_quota crashed:', e && e.stack || e); process.exit(1); });
}
