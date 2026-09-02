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

// M13 (2026-08-12 review): the usage meter's ring retains 26h (usage_meter.js RETAIN_MS). Once the
// mark is OLDER than that (scrape signed-out / parse-refused / ZOE_QUOTA_SCRAPE=0 — all real,
// handled states), everything before the horizon falls out of _computeSince and the governor
// silently UNDER-COUNTS — the 07-31 silent-drain class re-opened through the metering seam. The
// arithmetic can't be fixed without persisting the ring; what MUST NOT happen is the degradation
// staying invisible. Warn once an hour while degraded.
const RING_RETAIN_MS = 26 * 3600 * 1000;
let _ringWarnAt = 0;
function state(now = Date.now()) {
  const limit = _num('quota.limit_compute', 0);
  const markAt = _num('quota.mark_at', 0);
  let spentSince = 0;
  try {
    // COMPUTE since the mark: the meter records tokens PER MODEL, so weight each model's tokens by
    // its size. Counting calls or raw tokens both mis-rank the lanes — see lib/quota's header.
    spentSince = _computeSince(markAt, now);
    if (markAt && (now - markAt) > RING_RETAIN_MS && (now - _ringWarnAt) > 3600 * 1000) {
      _ringWarnAt = now;
      console.warn(`[quota] mark is ${(Math.round((now - markAt) / 3600000))}h old — OLDER than the 26h meter ring, so spentSince UNDER-COUNTS (scrape down?). Pace readings are advisory until the next true-up.`);
    }
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

/** #115: BACKGROUND compute in the trailing hour — research + idle + untagged ('?', safe-biased:
 *  unattributed spend charges against background until the lane tags populate). */
function spentLastHourBackground(now = Date.now()) {
  try {
    const um = require('./usage_meter');
    const byModel = um.byModelSince(now - quota.HOUR, now, { lanes: ['research', 'idle', '?'] });
    let total = 0;
    for (const [model, tokens] of Object.entries(byModel)) total += quota.costOf({ model, tokens });
    return total;
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
    const r = quota.check({ lane, st, spentLastHour: spentLastHour(now), spentLastHourBg: spentLastHourBackground(now), estimate, reopening: !!closedSince(lane) });
    if (!r.allow && !quiet && now - _lastLog > 5 * 60 * 1000) {
      _lastLog = now;
      console.log(`[quota] ${lane} DEFERRED — ${r.reason}`);
      console.log(`[quota] ${quota.describe(st)}`);
    }
    _noteClosure(lane, r.allow, now);
    return r;
  } catch (e) {
    return { allow: true, reason: `quota gate failed open: ${e.message}` };
  }
}

// CLOSURE STREAKS (census wire 6b, 2026-08-27): every deferral used to vanish into a rate-limited
// log line — a one-hour and a two-week lane closure rendered IDENTICALLY ("idle lane closed"), and
// nothing could say "idle has been starved for 40 hours". Persist only the TRANSITIONS (first deny
// stamps closed-since; first allow clears it) — zero cost on the hot path's steady state.
function _noteClosure(lane, allowed, now = Date.now()) {
  try {
    const db = require('./db');
    const key = `quota.closed_since.${String(lane)}`;
    const cur = db.getMeta(key);
    if (!allowed && !cur) db.setMeta(key, String(now));
    else if (allowed && cur) { db.setMeta(key, ''); console.log(`[quota] ${lane} lane REOPENED after ${Math.max(1, Math.round((now - (parseInt(cur, 10) || now)) / 60000))}m closed`); }
  } catch { /* streak accounting must never break the gate */ }
}
function closedSince(lane) {
  try { const v = require('./db').getMeta(`quota.closed_since.${String(lane)}`); const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; }
}

/** One line for boot / status. */
function describe(now = Date.now()) { return quota.describe(state(now)); }

module.exports = { allow, state, describe, spentLastHour, spentLastHourBackground, closedSince, _noteClosure };
