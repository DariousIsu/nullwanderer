/**
 * lib/calibration.js — the CALIBRATION HARNESS: the trust layer. Scores the machine against reality so the
 * tunable priors (midterm swing, incumbency, holdovers, perturbation magnitudes) become VALIDATED, not guessed.
 *
 * Two halves:
 *   • PURE SCORERS — Brier / log-loss / Brier-skill (probabilistic), RMSE / MAE (point), reliability + ECE
 *     (are 70%-forecasts right 70% of the time?), interval coverage (do 95% CIs contain 95%?). All deterministic
 *     with known-answer smoke tests — the harness itself is the most-testable thing in the suite.
 *   • REAL-DATA BACKTEST — `backtestPollAverage` runs our recency+sample weighting (the exact poll_average
 *     weights) over the 538 `raw_polls` history (margin_poll vs margin_actual), scoring it vs an equal-weight
 *     mean and the latest-poll baseline. Positive skill = the weighting earns its keep.
 *
 * No forecast NUMBER is produced here — only SCORES. Pure + injected data → offline-testable; the live driver
 * fetches the 538 history. This is what makes every downstream model/prior defensible.
 */
'use strict';

const pa = require('./poll_average');

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round = (x) => (x == null ? null : Math.round(x * 10000) / 10000);
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

// ---- probabilistic scorers — items: [{ prob:0..1, outcome:0|1 }] ----
function brier(items) {
  const a = (items || []).filter((x) => x && finite(x.prob) && x.outcome != null);
  return a.length ? round(a.reduce((s, x) => s + (x.prob - x.outcome) ** 2, 0) / a.length) : null;
}
function logLoss(items) {
  const a = (items || []).filter((x) => x && finite(x.prob) && x.outcome != null);
  if (!a.length) return null;
  return round(-a.reduce((s, x) => { const p = clamp(x.prob, 1e-15, 1 - 1e-15); return s + (x.outcome * Math.log(p) + (1 - x.outcome) * Math.log(1 - p)); }, 0) / a.length);
}
// Brier SKILL score vs a baseline probability (default = the base rate). >0 = better than the baseline; 1 = perfect.
function brierSkill(items, baseline) {
  const a = (items || []).filter((x) => x && finite(x.prob) && x.outcome != null);
  if (!a.length) return null;
  const rate = baseline != null ? baseline : a.reduce((s, x) => s + x.outcome, 0) / a.length;
  const bref = brier(a.map((x) => ({ prob: rate, outcome: x.outcome })));
  const b = brier(a);
  return bref ? round(1 - b / bref) : null;
}

// reliability curve + ECE (expected calibration error): bin by predicted prob, compare to observed frequency.
function reliability(items, bins = 10) {
  const a = (items || []).filter((x) => x && finite(x.prob) && x.outcome != null);
  if (!a.length) return { bins: [], ece: null };
  const B = Array.from({ length: bins }, () => ({ n: 0, psum: 0, osum: 0 }));
  for (const x of a) { const i = Math.min(bins - 1, Math.max(0, Math.floor(x.prob * bins))); B[i].n++; B[i].psum += x.prob; B[i].osum += x.outcome; }
  let ece = 0; const out = [];
  for (const b of B) { if (!b.n) continue; const mp = b.psum / b.n, of = b.osum / b.n; ece += (b.n / a.length) * Math.abs(mp - of); out.push({ mean_prob: round(mp), observed: round(of), n: b.n }); }
  return { bins: out, ece: round(ece) };
}

// ---- point / interval scorers — items: [{ pred, actual }] or [{ lo, hi, actual }] ----
function rmse(items) {
  const a = (items || []).filter((x) => x && finite(x.pred) && finite(x.actual));
  return a.length ? round(Math.sqrt(a.reduce((s, x) => s + (x.pred - x.actual) ** 2, 0) / a.length)) : null;
}
function mae(items) {
  const a = (items || []).filter((x) => x && finite(x.pred) && finite(x.actual));
  return a.length ? round(a.reduce((s, x) => s + Math.abs(x.pred - x.actual), 0) / a.length) : null;
}
function intervalCoverage(items) {
  const a = (items || []).filter((x) => x && finite(x.lo) && finite(x.hi) && finite(x.actual));
  return a.length ? round(a.filter((x) => x.actual >= Math.min(x.lo, x.hi) && x.actual <= Math.max(x.lo, x.hi)).length / a.length) : null;
}

// ---- real-data poll-aggregation backtest (538 raw_polls) ----
function raceKey(p) { return [p.cycle, p.location, p.race, p.election_date].join('|'); }

/**
 * Group raw polls by race; score our recency+sample-weighted margin vs actual, against an equal-weight mean
 * and the single latest poll. rawPolls = poll_538legacy.parseRawPolls() shape. Positive skill = weighting wins.
 */
function backtestPollAverage(rawPolls, opts = {}) {
  const groups = {};
  for (const p of (rawPolls || [])) {
    if (!finite(p.margin_poll) || !finite(p.margin_actual)) continue;
    (groups[raceKey(p)] = groups[raceKey(p)] || []).push(p);
  }
  const model = [], naive = [], latest = [];
  let nRaces = 0, nPolls = 0;
  for (const k in groups) {
    const g = groups[k];
    const actual = g[0].margin_actual;
    if (!finite(actual)) continue;
    const now = Date.parse(g[0].election_date) || opts.now || Date.now();
    let wsum = 0, wpsum = 0, msum = 0, latestVal = null, latestT = -Infinity;
    for (const p of g) {
      const w = pa.pollWeight({ end_date: p.poll_date, sample_size: p.sample_size, pollster: p.pollster }, { now });
      wsum += w; wpsum += w * p.margin_poll; msum += p.margin_poll;
      const t = Date.parse(p.poll_date) || 0;
      if (t > latestT) { latestT = t; latestVal = p.margin_poll; }
    }
    if (!(wsum > 0)) continue;
    model.push({ pred: wpsum / wsum, actual });
    naive.push({ pred: msum / g.length, actual });
    latest.push({ pred: latestVal, actual });
    nRaces++; nPolls += g.length;
  }
  const rm = rmse(model), rn = rmse(naive), rl = rmse(latest);
  return {
    n_races: nRaces, n_polls: nPolls,
    rmse_model: rm, rmse_naive: rn, rmse_latest: rl, mae_model: mae(model),
    skill_vs_naive: (rm != null && rn) ? round(1 - rm / rn) : null,     // >0 = weighting beats equal-weight mean
    skill_vs_latest: (rm != null && rl) ? round(1 - rm / rl) : null,    // >0 = weighting beats the latest poll alone
  };
}

module.exports = { brier, logLoss, brierSkill, reliability, rmse, mae, intervalCoverage, backtestPollAverage, raceKey };
