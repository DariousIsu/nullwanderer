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
// ⭐ THE USAGE LAW (Lucas 2026-09-03, verbatim-close: "The ONLY lane that should be slowed is BASIC
// DATABASE EXPANSION, and only when there are research directives in the queue, user commands in the
// queue, and program development to do. We are still on the very conservative side. The swarms
// shouldn't really be included, since we use such a cost-friendly model."). Four tiers:
//   user        = interactive (his turn) + directed (his word, and his swarms' partitions): NEVER slowed
//   development = the program building itself (pen cures, rehearsal, pursuit, the self-build operators):
//                 its own tier — named and measurable, floor-gated only, never paced
//   expansion   = research + idle (the sweep, decomposition, news, enrichment, promotion, the subconscious):
//                 the ONLY paced tier, and paced ONLY when work is QUEUED above it; otherwise it may use
//                 the whole sustainable rate (use-it-or-lose-it — the pool does not roll over)
// Cheap-model calls (weight ≤ CHEAP_WEIGHT: gemma4:31b) never trip the pace gate at all; the FLOORS below
// stay armed for every tier, so his chat reserve survives everything.
const TIER = {
  interactive: 0,   // Lucas is typing. Never blocked.
  directed: 1,      // work he explicitly assigned. Blocked only when the pool is genuinely empty.
  presence: 2,      // HER BEING HERE (09-05 16:20): the consciousness loop's words to him, the wondering, the
                    // autonomy decider. Small by construction (PRESENCE_MAX_TOKENS), floor-gated only, never paced.
  development: 3,   // the program's own build. Floor-gated only.
  research: 4,      // autonomous research passes (EXPANSION).
  idle: 5,          // graph-walk / puller / subconscious drift (EXPANSION).
};
const EXPANSION_TIERS = new Set(['research', 'idle']);
// Lanes that are a tier under another name: the slow loop meters as 'consciousness' (its history keeps
// that label) and the autonomy tick as 'autonomy'; both are the presence tier. An unknown lane is idle.
const LANE_TIER = { consciousness: 'presence', autonomy: 'presence' };
function tierOf(lane) { const l = String(lane || ''); return TIER[l] != null ? l : (LANE_TIER[l] || 'idle'); }
// THE PRESENCE CAP: a presence call is refused above this many tokens — the tier is cheap because its prompts
// are bounded, never because the gate trusts the caller. Measured on boot_p315 (16:25): the autonomy tick's WHOLE
// prompt (manifest + history + the decision contract) estimates at ~9.5k tokens, so the first cap of 8,192 refused
// the decider it was built to admit ("presence prompt over its cap (~9,503 tokens > 8192)"). 12,288 admits the
// tick as it is; a leaner tick is its own cut. The loop's words are ~1k. The tier's day stays under 2% of the pool.
const PRESENCE_MAX_TOKENS = 12288;
// Fraction of the pool each tier is allowed to consume. Interactive keeps a reserve nothing else can
// touch: at 99% spent she must still be able to answer.
const TIER_FLOOR = { interactive: 0.00, directed: 0.03, presence: 0.01, development: 0.05, research: 0.10, idle: 0.15 };
// THE CHEAP FLEET THROUGH THE FLOORS (Lucas 09-05 16:20, "yes build all three"): a research/idle call on the
// cost-friendly fleet (weight ≤ CHEAP_WEIGHT) stops at this floor instead of its tier's — the news lane, the
// swarm and the wondering stay alive all week at ~1.5% of the pool a day. Measured the day this was built:
// the pool hit 85% a day and a half into the week and every autonomic lane was dead until the reset.
const CHEAP_FLOOR = 0.03;
// Models at or under this weight (billions of parameters) are the cost-friendly fleet — the swarm's
// gemma4:31b — and never trip the PACE check (his law: "the swarms shouldn't really be included").
const CHEAP_WEIGHT = 35;
// THE BURST RULE (2026-08-29, Lucas: "we have zero quota constraints" — dashboard 48.3% used with
// ~24h to reset while the pace gate deferred every autonomous lane; the pool does not roll over, so
// pacing a pool that is AHEAD of schedule defends quota that will simply expire). The window is the
// provider's weekly cycle; ahead = usage % lagging elapsed % by a clear margin (no flapping).
// Margin 0.10 → 0.02 (usage law 09-03): ahead of schedule at all is no pacing; the hysteresis on a
// reopening lane below is what keeps the threshold from strobing.
const WINDOW_H = 168;
const BURST_AHEAD_MARGIN = 0.02;

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
  'glm-5.2': 300,             // 756B MoE — kimi-class pacing (replier trial, Lucas 08-21)
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
// #115 (Lucas-approved 09-01): `spentLastHourBg` — background-lane spend only (research+idle+
// untagged). When provided, the PACE check charges background against BACKGROUND spend, the exact
// symmetric of the directed exemption below: his and the engineer's directed hours must not starve
// her research (measured: 40k+ all-lane compute in one build hour closed the research lane at 19%
// of a barely-touched weekly pool). Floors and burst logic are untouched — the reserve still
// protects his chat, and a hot BACKGROUND hour still throttles background.
// `reopening` (09-01 flap fix: seven 1-minute open/close cycles as the hour drained): a lane that
// is currently CLOSED reopens only when comfortably under pace (85% of its share) — hysteresis, so
// the threshold crossing doesn't strobe the log and the closure ledger every minute.
// `model` (usage law 09-03): the cheap-model exemption needs the model — a call on the cost-friendly
// fleet never trips the pace check. `queuedAbove` (usage law): is work QUEUED above expansion — his
// outstanding threads, his directed focus, the pen's queue? false = nothing above → expansion may
// spend the whole sustainable rate; true or unknown (an old caller) = the conservative shares.
function check({ lane = 'idle', st = null, spentLastHour = 0, spentLastHourBg = null, estimate = 0, reopening = false, model = '', queuedAbove = null } = {}) {
  const tier = tierOf(lane);
  if (tier === 'interactive') return { allow: true, reason: 'interactive — never throttled' };
  if (!st || !st.known) return { allow: true, reason: 'no quota configured' };

  const cheap = !!(model && weightFor(model) <= CHEAP_WEIGHT);
  const floor = (cheap && EXPANSION_TIERS.has(tier)) ? Math.min(TIER_FLOOR[tier], CHEAP_FLOOR) : TIER_FLOOR[tier];
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
  // THE PRESENCE TIER: floor-gated only, never paced — and capped. The estimate is compute (weight × ktokens);
  // the tokens behind it are what the cap is on, so an unbounded prompt on a small model is refused too.
  if (tier === 'presence') {
    const w = weightFor(model) || DEFAULT_WEIGHT;
    const tokens = num(estimate) > 0 ? (num(estimate) / w) * 1000 : 0;
    if (tokens > PRESENCE_MAX_TOKENS) {
      return { allow: false, reason: `presence prompt over its cap (~${Math.round(tokens).toLocaleString()} tokens > ${PRESENCE_MAX_TOKENS}) — bound it; the tier is cheap because its prompts are`, usedPct: st.usedPct, pacePerHour: st.pacePerHour, capped: true };
    }
    return { allow: true, reason: 'presence — her being here; floor-gated only, never pace-throttled', usedPct: st.usedPct, pacePerHour: st.pacePerHour };
  }
  // DEVELOPMENT (usage law 09-03): the program building itself — pen cures, rehearsal, pursuit, the
  // self-build operators — is its own tier: named, measured in the meter, floor-gated only, never paced.
  if (tier === 'development') return { allow: true, reason: 'development — the program\'s own build, floor-gated only (never pace-throttled)', usedPct: st.usedPct, pacePerHour: st.pacePerHour };
  // THE CHEAP-MODEL EXEMPTION (usage law 09-03): a call on the cost-friendly fleet (gemma4:31b, the
  // swarm's model) never trips the pace gate — the floors above already held. Weight from the name.
  if (cheap) {
    return { allow: true, cheap: true, reason: `cheap model (${model}, weight ${weightFor(model)} ≤ ${CHEAP_WEIGHT}) — the pace gate never trips; floors still armed`, usedPct: st.usedPct, pacePerHour: st.pacePerHour };
  }
  // Pace is a rate check, so it needs the trailing hour, not the instant. The background tiers get a slice
  // of the sustainable rate — autonomous research a little, idle/subconscious drift the least (throttled
  // first + hardest, so subconscious yields before anything else Lucas cares about).
  //
  // USE-IT-OR-LOSE-IT (2026-08-15, Lucas's dashboard: 53.1% weekly used with ONE DAY to reset): the
  // pool does not roll over — headroom the base shares hold back for interactive/directed work that
  // never comes (overnight, weekends) simply EXPIRES at the reset. Measured: total burn capped near
  // ~45% of sustainable all night, guaranteeing ~half the remaining pool is forfeited. Inside the
  // final ENDGAME_H hours the background shares RAMP linearly toward ~95% of the sustainable rate,
  // so the surplus is spent instead of stranded. The FLOOR reserves above are UNTOUCHED — at 85/90%
  // of the pool the background tiers still hard-stop, so his chat reserve survives the ramp.
  // BASE SHARES RAISED (2026-08-15, Lucas: "we only used half of our weekly quota this week —
  // the governor we put on last week was too strict, dedicate allocation to the new simulated
  // consciousness organs"). Research 0.45→0.60. Idle 0.20→0.40 — and the idle raise IS the
  // consciousness dedication: the wondering organs (interest foci, focus-wonder self-dialogue,
  // self-exploration) all spend on the idle lane, and 0.20 throttled them first and hardest.
  // The measured week: pool ended half unused; the FLOOR reserves below still protect his chat.
  // THE BURST RULE: when the pool is clearly AHEAD of the window's schedule, the pace gate passes —
  // spentLastHour counts ALL lanes, so a hot interactive hour was locking research/idle out of
  // surplus that expires at reset. The FLOOR reserves above already returned before this line, so
  // his chat reserve survives every burst; falling behind schedule re-engages pacing automatically.
  const elapsedPct = 1 - Math.min(1, st.hoursLeft / WINDOW_H);
  if (elapsedPct - st.usedPct >= BURST_AHEAD_MARGIN) {
    return {
      allow: true, burst: true,
      reason: `burst: pool ahead of schedule (${Math.round(st.usedPct * 100)}% used vs ${Math.round(elapsedPct * 100)}% of the window elapsed) — floors still armed`,
      usedPct: st.usedPct, pacePerHour: st.pacePerHour,
    };
  }
  const ENDGAME_H = 36;
  const base = tier === 'research' ? 0.60 : 0.40;
  const ramp = st.hoursLeft < ENDGAME_H ? (1 - st.hoursLeft / ENDGAME_H) : 0;   // 0 → 1 across the final window
  // THE QUEUED-ABOVE RULE (usage law 09-03): expansion is paced ONLY when work is queued above it. With
  // nothing above (no outstanding thread of his, no directed focus, an empty pen queue) the shares fall
  // away and expansion may spend the WHOLE sustainable rate — never more: the burn-down is the ceiling.
  const unpaced = queuedAbove === false && EXPANSION_TIERS.has(tier);
  const share = unpaced ? 1.0 : base + (0.95 - base) * ramp;
  const allowedThisHour = st.pacePerHour * share * (reopening ? 0.85 : 1);
  // #115: background paces against background spend when the caller can split the hour.
  const paceSpend = spentLastHourBg != null ? num(spentLastHourBg) : num(spentLastHour);
  if (paceSpend + num(estimate) > allowedThisHour) {
    return {
      allow: false,
      reason: `over burn-down pace: ${Math.round(paceSpend).toLocaleString()} ${spentLastHourBg != null ? 'BACKGROUND ' : ''}compute in the last hour vs ${Math.round(allowedThisHour).toLocaleString()} sustainable for ${tier}${unpaced ? ' (the whole rate — nothing queued above)' : ''} (${Math.round(st.remaining).toLocaleString()} left, ${st.hoursLeft.toFixed(1)}h to reset)`,
      usedPct: st.usedPct,
      pacePerHour: st.pacePerHour,
    };
  }
  return { allow: true, reason: unpaced ? 'within the sustainable rate — nothing queued above expansion, so it is unpaced' : 'within pace', usedPct: st.usedPct, pacePerHour: st.pacePerHour, unpaced };
}

/** One line for the log / status surface. Honest when nothing is configured. */
function describe(st) {
  if (!st || !st.known) return 'quota: not configured (no ceiling enforced)';
  if (st.resetPassed) return `quota: reset passed — pool treated as refilled (${Math.round(st.usedPct * 100)}% metered since); re-mark to re-anchor`;
  return `quota: ${Math.round(st.usedPct * 100)}% used · ${Math.round(st.remaining).toLocaleString()} compute left · `
    + `${st.hoursLeft.toFixed(1)}h to reset · sustainable ${Math.round(st.pacePerHour).toLocaleString()}/h`;
}

module.exports = { state, check, describe, weightFor, costOf, tierOf, TIER, TIER_FLOOR, LANE_TIER, EXPANSION_TIERS, CHEAP_WEIGHT, CHEAP_FLOOR, PRESENCE_MAX_TOKENS, HOUR, NAMED_WEIGHTS, DEFAULT_WEIGHT, WINDOW_H, BURST_AHEAD_MARGIN };
