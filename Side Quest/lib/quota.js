/*
 * lib/quota.js — ONE budget for a FINITE POOL that refills on a date.
 *
 * ⭐ THE UNIT IS COMPUTE. Not tokens, not requests — both of which this file tried first and both of
 * which are wrong in ways that point at the wrong fix.
 *
 * The dashboard settles it. Requests this week against the share of the bar each model occupies:
 *
 *     gemma4:31b        69,659 requests  — a MODEST slice
 *     deepseek-v4-flash 22,619 requests  — the LARGEST slice
 *     gpt-oss:120b      10,535 requests
 *     minimax-m3         1,071 · kimi-k2.7-code 430 · deepseek-v4-pro 475 · kimi-k2.6 158
 *     mistral-large-3:675b 2 · qwen3.5:397b 1
 *
 * A third of the calls, more than the compute. So counting REQUESTS says "gemma is 66% of the
 * problem" and counting TOKENS says something else again, while the truth is that one deepseek call
 * costs several gemma calls. Both earlier units would have sent us optimising the wrong lane.
 *
 * COMPUTE ≈ PARAMETERS × TOKENS, the standard first-order approximation (inference FLOPs scale with
 * model size and with how much text passes through it). So cost is weighted by model, and the weight
 * is read from the model's own name where it states its size — gemma4:31b is 31, gpt-oss:120b is 120,
 * mistral-large-3:675b is 675. That is a 20x spread across the fleet, which no unweighted counter can
 * see.
 *
 * WHAT THAT MAKES THE LEVER: model ROUTING. One 120B call costs roughly four 31B calls of the same
 * length; a 675B call costs twenty. Batching helps, going local helps more, and demoting a lane from
 * a big model to a small one helps most of all — that is the control the earlier drafts could not
 * even express.
 *
 * TWO WINDOWS, because the provider enforces two: a SESSION allowance that resets hourly and a WEEKLY
 * one. They are independent — pass whichever is being checked; the caller holds both.
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

// COMPUTE WEIGHT per model, in billions of parameters — the size term of params x tokens.
//
// Read from the model's OWN NAME wherever it states its size ("gemma4:31b" -> 31, "gpt-oss:120b" ->
// 120, "mistral-large-3:675b" -> 675). Parsing the name rather than keeping a table means a model we
// have never seen still gets a real weight the first time it is used, instead of silently costing
// whatever the default happens to be — and this fleet changes often.
//
// Names that do not state a size get NAMED_WEIGHTS, and anything still unknown gets DEFAULT_WEIGHT.
// The default is deliberately NOT small: an unrecognised model is more likely to be a new frontier
// model than a tiny one, and under-weighting it is the expensive direction of the error.
const NAMED_WEIGHTS = {
  // stated sizes are absent from these names; figures are order-of-magnitude, for pacing only
  'deepseek-v4-flash': 100,   // "flash" is the small tier, but it out-consumes 3x its count in
                              // gemma4:31b calls on the dashboard, so it is NOT a 31b-class cost
  'deepseek-v4-pro': 400,
  'minimax-m3': 200,
  'kimi-k2.6': 300,
  'kimi-k2.7-code': 300,
};
const DEFAULT_WEIGHT = 100;

/** Compute weight for a model, in billions of parameters. Pure; never throws. */
function weightFor(model) {
  const m = String(model || '').toLowerCase().trim();
  if (!m) return DEFAULT_WEIGHT;
  for (const [k, w] of Object.entries(NAMED_WEIGHTS)) if (m.includes(k)) return w;
  // "…:31b", "…-675b", "…120b" — the size the model states about itself.
  const hit = m.match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (hit) { const n = Number(hit[1]); if (Number.isFinite(n) && n > 0) return n; }
  return DEFAULT_WEIGHT;
}

/**
 * Compute cost of one call, in weight-tokens (billions-of-params x thousands-of-tokens).
 * Scaled by 1e-3 on tokens so the numbers stay human-sized in logs.
 */
function costOf({ model = '', tokens = 0 } = {}) {
  return weightFor(model) * (Math.max(0, num(tokens)) / 1000);
}

/**
 * Where the pool stands.
 *
 * @param {number} s.limit        COMPUTE UNITS in the period (0/unknown → unlimited)
 * @param {number} s.markPct      operator's observed usage at the mark, 0..1
 * @param {number} s.markAt       when that mark was taken (epoch ms)
 * @param {number} s.spentSince   compute units this app has metered SINCE the mark
 * @param {number} s.resetAt      when the pool refills (epoch ms)
 * @param {number} now
 */
function state({ limit = 0, markPct = 0, markAt = 0, spentSince = 0, resetAt = 0, now = Date.now() } = {}) {
  const lim = num(limit);
  if (lim <= 0) return { known: false, usedPct: 0, remaining: Infinity, msLeft: Math.max(0, num(resetAt) - now), pacePerHour: Infinity };
  // A mark taken BEFORE the pool's last reset is STALE: the pool has since refilled, so the operator's
  // pre-reset "90% used" no longer describes it. Honor the stated reset — once resetAt has passed, VOID the
  // mark (usedAtMark = 0) and measure usage purely from metered spend since. Without this the gate suppresses
  // every autonomous lane FOREVER on a stale mark (observed live: idle deferred at 91% days after the pool
  // reset, because the FLOOR check reads the frozen mark). A fresh mark (markAt after the reset) re-anchors it.
  const resetPassed = num(resetAt) > 0 && now > num(resetAt);
  const usedAtMark = resetPassed ? 0 : clamp01(num(markPct)) * lim;
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
    resetPassed,
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
 * @param {number} o.spentLastHour compute units across ALL lanes in the trailing hour
 * @param {number} o.estimate      compute units this call is expected to cost (see costOf)
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
  // PACE throttles BACKGROUND work ONLY. Directed (work Lucas explicitly assigned) is NEVER rate-limited
  // — the burn-down restriction belongs on background tasks, never on user-directed work (Lucas 2026-08-12).
  // This also finally honors this module's own stated intent (the TIER comment: directed is "blocked only
  // when the pool is genuinely empty"), which the old `directed:0.80` pace share silently violated: a heavy
  // BACKGROUND hour pushed spentLastHour past directed's share and paused HIS research (measured: the
  // Applied Digital project #3792 deferred tick after tick at 110k/h while idle/research kept the pool hot).
  // Directed is gated by the FLOOR reserve alone (above); when his work spends heavily the total rises and
  // research/idle yield here — which is the correct direction: background makes room for the user, not the
  // reverse. See [[db-is-foundation-no-recall-only]]'s sibling principle on priority. Interactive already
  // returned at the top; directed exits here; only research/idle reach the rate check.
  if (tier === 'directed') return { allow: true, reason: 'directed — user work, floor-gated only (never pace-throttled)', usedPct: st.usedPct, pacePerHour: st.pacePerHour };
  // Pace is a rate check, so it needs the trailing hour, not the instant. The background tiers get a slice
  // of the sustainable rate — autonomous research a little, idle/subconscious drift the least (throttled
  // first + hardest, so subconscious yields before anything else Lucas cares about).
  const share = tier === 'research' ? 0.45 : 0.20;
  const allowedThisHour = st.pacePerHour * share;
  if (num(spentLastHour) + num(estimate) > allowedThisHour) {
    return {
      allow: false,
      reason: `over burn-down pace: ${Math.round(num(spentLastHour)).toLocaleString()} compute in the last hour vs ${Math.round(allowedThisHour).toLocaleString()} sustainable for ${tier} (${Math.round(st.remaining).toLocaleString()} left, ${st.hoursLeft.toFixed(1)}h to reset)`,
      usedPct: st.usedPct,
      pacePerHour: st.pacePerHour,
    };
  }
  return { allow: true, reason: 'within pace', usedPct: st.usedPct, pacePerHour: st.pacePerHour };
}

/** One line for the log / status surface. Honest when nothing is configured. */
function describe(st) {
  if (!st || !st.known) return 'quota: not configured (no ceiling enforced)';
  if (st.resetPassed) return `quota: reset passed — pool treated as refilled (${Math.round(st.usedPct * 100)}% metered since); re-mark to re-anchor`;
  return `quota: ${Math.round(st.usedPct * 100)}% used · ${Math.round(st.remaining).toLocaleString()} compute left · `
    + `${st.hoursLeft.toFixed(1)}h to reset · sustainable ${Math.round(st.pacePerHour).toLocaleString()}/h`;
}

module.exports = { state, check, describe, weightFor, costOf, TIER, TIER_FLOOR, HOUR, NAMED_WEIGHTS, DEFAULT_WEIGHT };
