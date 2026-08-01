/*
 * lib/quota_gate.js — the impure half of lib/quota: reads the config + the real meter, answers one
 * question, and says why.
 *
 * Separate from quota.js so the arithmetic stays pure and testable, and separate from the LANES so
 * there is exactly one place that decides. The four rolling windows this replaces each had their own
 * copy of "am I allowed to spend", which is how four lanes could all be within budget while the pool
 * emptied. One gate, or it fragments again.
 *
 * CONFIG (meta keys, all operator-set — the provider's counter is not readable from here):
 *   quota.limit_compute  COMPUTE UNITS in the period (params-in-billions x tokens/1000). UNSET →
 *                       no ceiling, everything allowed, and the status line says so.
 *   quota.mark_pct      usage observed on the provider's dashboard at the mark, 0..1
 *   quota.mark_at       when that mark was taken (epoch ms)
 *   quota.reset_at      when the pool refills (epoch ms)
 *
 * Spend after the mark is measured from lib/usage_meter's PER-MODEL token totals, weighted by model
 * size — so the estimate is an operator observation plus a measurement, never a guess by this process.
 *
 * ⚠ The unit is COMPUTE, not requests and not tokens. The provider bills compute, and the two naive
 * units disagree about which lane is expensive: gemma4:31b has 3x the REQUESTS of deepseek-v4-flash
 * and less of the bar. Weighting by model size reproduces the dashboard's proportions.
 */
'use strict';

const quota = require('./quota');

let _lastLog = 0;

function _db() { return require('./db'); }
function _meta(k, d = '') { try { return _db().getMeta(k) || d; } catch { return d; } }
function _num(k, d = 0) { const v = Number(_meta(k, '')); return Number.isFinite(v) ? v : d; }

/** The pool's current state, from config + the real token meter. */
/** Weighted compute the app has metered in [since, now]. Reads usage_meter's per-model token totals. */
function _computeSince(since, now) {
  try {
    const um = require('./usage_meter');
    const s = um.summary({ now, windowMs: Math.max(1, now - since) });
    const byModel = (s && s.byModel) || {};
    let total = 0;
    for (const [model, tokens] of Object.entries(byModel)) total += quota.costOf({ model, tokens });
    return total;
  } catch { return 0; }
}

function state(now = Date.now()) {
  const limit = _num('quota.limit_compute', 0);
  const markAt = _num('quota.mark_at', 0);
  let spentSince = 0;
  try {
    // COMPUTE since the mark: the meter records tokens PER MODEL, so weight each model's tokens by
    // its size. Counting calls or raw tokens both mis-rank the lanes — see lib/quota's header.
    spentSince = _computeSince(markAt, now);
  } catch {}
  return quota.state({
    limit, markPct: _num('quota.mark_pct', 0), markAt, spentSince,
    resetAt: _num('quota.reset_at', 0), now,
  });
}

/** COMPUTE across ALL lanes in the trailing hour — the rate the pace check is against. */
function spentLastHour(now = Date.now()) {
  try {
    const um = require('./usage_meter');
    return _computeSince(now - quota.HOUR, now);
  } catch { return 0; }
}

/**
 * May `lane` spend? Fails OPEN on any error or missing config — a throttle that bricks her because a
 * meta key is absent would be a worse bug than the one it prevents.
 *
 * @param {string} lane      'interactive' | 'directed' | 'research' | 'idle'
 * @param {number} estimate  expected COMPUTE for this call — quota.costOf({model, tokens})
 */
function allow(lane, { estimate = 0, now = Date.now(), quiet = false } = {}) {
  try {
    const st = state(now);
    const r = quota.check({ lane, st, spentLastHour: spentLastHour(now), estimate });
    if (!r.allow && !quiet && now - _lastLog > 5 * 60 * 1000) {
      _lastLog = now;
      console.log(`[quota] ${lane} DEFERRED — ${r.reason}`);
      console.log(`[quota] ${quota.describe(st)}`);
    }
    return r;
  } catch (e) {
    return { allow: true, reason: `quota gate failed open: ${e.message}` };
  }
}

/** One line for boot / status. */
function describe(now = Date.now()) { return quota.describe(state(now)); }

module.exports = { allow, state, describe, spentLastHour };
