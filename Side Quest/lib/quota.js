/*
 * lib/quota.js — ONE budget for a FINITE POOL that refills on a date.
 *
 * THE PROBLEM THIS EXISTS FOR. 2026-07-31: the Ollama cloud allowance hit 90% with two days left on
 * the period. Nothing in the app noticed, because nothing in the app knew a period existed.
 *
 * What was there instead was four independent RATE LIMITERS — graphwalk, subc, pullerwalk each with
 * their own rolling token window ("isolated from the shared subc pool", says the comment), plus
 * research.usage which counts CALLS rather than tokens. Three consequences, all of them structural:
 *
 *   1. NO SHARED UNIT. You cannot enforce a ceiling across lanes that measure different things.
 *   2. NO GLOBAL CAP. Four lanes each individually "within budget" drain the pool together.
 *      Measured that hour: graphwalk 41,944 tok, subc 18,557, puller 1,268, research 43 calls.
 *   3. NO NOTION OF A PERIOD. A rate limiter says "at most X per hour, forever". It cannot say
 *      "you have 10% left and two days to make it last", which is the only question that mattered.
 *
 * THE MODEL. A quota is a finite pool with a refill date, so the right control is BURN-DOWN PACING:
 *
 *      sustainable rate = remaining / time until reset
 *
 * recomputed continuously. Spend faster and the allowance tightens automatically; spend slower and it
 * relaxes. No fixed hourly cap can do that, because the correct hourly rate on day one of a period is
 * not the correct rate with 10% left.
 *
 * CALIBRATION, because the provider's counter is not readable from here. The app meters its own tokens
 * (lib/usage_meter) but the authority is the provider's dashboard, and the two will drift. So an
 * operator MARK — "90% used, as of now" — anchors it, and spend is tracked as a delta from that mark.
 * An estimate anchored to a real observation beats a number this process invented.
 *
 * PRIORITY, because running out is not the only failure. A throttle that silences her mid-conversation
 * to protect a background sweep has optimised the wrong thing. Interactive and operator-directed work
 * is never blocked here; the autonomous lanes yield first, and a reserve is held back so his chat
 * still works at 99%.
 *
 * Pure: no db, no network, no model. Callers pass state in and persist what comes back.
 */
'use strict';

const HOUR = 3600 * 1000;

// Lanes, most protective first. Interactive work is never throttled by this module — it is the thing
// the quota is FOR. The autonomous lanes are ordered by how little is lost when they wait.
const TIER = {
  interactive: 0,   // Lucas is typing. Never blocked.
  directed: 1,      // work he explicitly assigned. Blocked only when the pool is genuinely empty.
  research: 2,      // autonomous research passes.
  idle: 3,          // graph-walk / puller / subconscious drift.
};
// Fraction of the pool each tier is allowed to consume. Interactive keeps a reserve nothing else can
// touch: at 99% spent she must still be able to answer.
const TIER_FLOOR = { interactive: 0.00, directed: 0.03, research: 0.10, idle: 0.15 };

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * Where the pool stands.
 *
 * @param {number} s.limit        tokens in the period (0/unknown → unlimited)
 * @param {number} s.markPct      operator's observed usage at the mark, 0..1
 * @param {number} s.markAt       when that mark was taken (epoch ms)
 * @param {number} s.spentSince   tokens this app has metered SINCE the mark
 * @param {number} s.resetAt      when the pool refills (epoch ms)
 * @param {number} now
 */
function state({ limit = 0, markPct = 0, markAt = 0, spentSince = 0, resetAt = 0, now = Date.now() } = {}) {
  const lim = num(limit);
  if (lim <= 0) return { known: false, usedPct: 0, remaining: Infinity, msLeft: Math.max(0, num(resetAt) - now), pacePerHour: Infinity };
  const usedAtMark = clamp01(num(markPct)) * lim;
  const used = Math.min(lim, usedAtMark + Math.max(0, num(spentSince)));
  const remaining = Math.max(0, lim - used);
  const msLeft = Math.max(0, num(resetAt) - now);
  // Sustainable spend from here to the reset. No time left → no pacing constraint (the pool is about
  // to refill anyway, so there is nothing left to protect).
  const pacePerHour = msLeft > 0 ? (remaining / (msLeft / HOUR)) : Infinity;
  return {
    known: true,
    limit: lim,
    used,
    usedPct: clamp01(used / lim),
    remaining,
    msLeft,
    hoursLeft: msLeft / HOUR,
    pacePerHour,
    markAt: num(markAt),
  };
}

/**
 * May this lane spend right now?
 *
 * Two independent gates, and BOTH must pass for an autonomous lane:
 *   FLOOR — the tier's share of the pool is exhausted (a hard stop that protects the tiers below it)
 *   PACE  — spending in the last hour already exceeds the sustainable burn-down rate
 *
 * @param {string} o.lane          one of TIER
 * @param {object} o.st            state() result
 * @param {number} o.spentLastHour tokens across ALL lanes in the trailing hour
 * @param {number} o.estimate      tokens this call is expected to cost
 */
function check({ lane = 'idle', st = null, spentLastHour = 0, estimate = 0 } = {}) {
  const tier = TIER[lane] != null ? lane : 'idle';
  if (tier === 'interactive') return { allow: true, reason: 'interactive — never throttled' };
  if (!st || !st.known) return { allow: true, reason: 'no quota configured' };

  const floor = TIER_FLOOR[tier];
  if (st.usedPct >= 1 - floor) {
    return {
      allow: false,
      reason: `${tier} stops at ${Math.round((1 - floor) * 100)}% of the pool (now ${Math.round(st.usedPct * 100)}%) — the remainder is reserved for higher-priority work`,
      usedPct: st.usedPct,
    };
  }
  // Pace is a rate check, so it needs the trailing hour, not the instant. Each tier gets a slice of
  // the sustainable rate — idle work may use a little, directed work most of it.
  const share = tier === 'directed' ? 0.80 : tier === 'research' ? 0.45 : 0.20;
  const allowedThisHour = st.pacePerHour * share;
  if (num(spentLastHour) + num(estimate) > allowedThisHour) {
    return {
      allow: false,
      reason: `over burn-down pace: ${Math.round(num(spentLastHour)).toLocaleString()} tok in the last hour vs ${Math.round(allowedThisHour).toLocaleString()} sustainable for ${tier} (${Math.round(st.remaining).toLocaleString()} left, ${st.hoursLeft.toFixed(1)}h to reset)`,
      usedPct: st.usedPct,
      pacePerHour: st.pacePerHour,
    };
  }
  return { allow: true, reason: 'within pace', usedPct: st.usedPct, pacePerHour: st.pacePerHour };
}

/** One line for the log / status surface. Honest when nothing is configured. */
function describe(st) {
  if (!st || !st.known) return 'quota: not configured (no ceiling enforced)';
  return `quota: ${Math.round(st.usedPct * 100)}% used · ${Math.round(st.remaining).toLocaleString()} tok left · `
    + `${st.hoursLeft.toFixed(1)}h to reset · sustainable ${Math.round(st.pacePerHour).toLocaleString()} tok/h`;
}

module.exports = { state, check, describe, TIER, TIER_FLOOR, HOUR };
