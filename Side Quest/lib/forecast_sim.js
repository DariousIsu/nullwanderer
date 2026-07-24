/**
 * lib/forecast_sim.js — the CORRELATED SCENARIO SIMULATOR (the forecasting machine's parts→whole core).
 *
 * Turns a set of race forecasts into the DISTRIBUTION of whole-government outcomes: seat counts per chamber,
 * P(party controls each chamber), and the joint government-control SCENARIOS (trifecta / divided / …) that
 * Lucas wants "to play out and run." The load-bearing idea is CORRELATION: a shared national (and optional
 * regional) swing moves races TOGETHER, so the uncertainty is realistic — independent races catastrophically
 * understate tail risk (the 2016 lesson). Deterministic (seeded PRNG) → fully offline-testable.
 *
 * A race is party-A-vs-party-B (generalize D/R): { id, chamber, margin, sigma, region? }
 *   margin = party-A's expected lead in points (+ = A ahead).  sigma = race-level SD (points).
 * Aggregation adds holdover seats (Senate seats not up this cycle) + a majority threshold per chamber.
 *
 * PURE + no deps. Connects to poll_average via marginToWinProb / winProbToMargin (a race can be specified
 * as a win-probability instead of a margin). The reactive-recompute + conditional-cascade layers are later
 * machine pieces that CALL this; this piece just answers "given these race forecasts, what worlds result?"
 */
'use strict';

// ---- seeded PRNG (mulberry32) + standard normal (Box–Muller) → deterministic sims ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---- normal CDF (Φ) + inverse (Acklam) — for margin↔win-probability conversion ----
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function Phi(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function PhiInv(p) {
  if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl; let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= ph) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
// party-A win probability from an expected margin + SD; and the inverse.
function marginToWinProb(margin, sigma = 5) { return Phi(margin / (sigma || 5)); }
function winProbToMargin(p, sigma = 5) { return PhiInv(Math.min(0.999999, Math.max(0.000001, p))) * (sigma || 5); }

// ---- summary stats ----
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function variance(a) { if (a.length < 2) return 0; const m = mean(a); return a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1); }
function quantile(a, q) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1)))); return s[i]; }

/**
 * simulate(races, opts) → whole-outcome distribution.
 * opts: {
 *   nationalSigma=3   correlated national swing SD (points) applied to every race — the correlation knob
 *   regionSigma=0     optional correlated swing SD within each race.region
 *   defaultSigma=5    race SD when a race omits sigma
 *   iterations=10000, seed=42
 *   holdovers={ senate:{A:34,B:30} }   seats NOT up this cycle, added to A's/B's base
 *   majority={ house:218, senate:51 }  A controls the chamber at >= this many A-seats (default: strict majority of total)
 * }
 * returns { iterations, chambers:{ [ch]:{ pA_control, seatsA_mean, seatsA_sd, seatsA_p10, seatsA_p90, n_races, total_seats } },
 *           scenarios:[{label, prob}] }  // label = joint control across chambers, e.g. "house:A | senate:B"
 */
function simulate(races, opts = {}) {
  const { nationalSigma = 3, regionSigma = 0, defaultSigma = 5, iterations = 10000, seed = 42 } = opts;
  const holdovers = opts.holdovers || {};
  const majority = opts.majority || {};
  const rng = mulberry32(seed);
  // Regional correlation groups, drawn each iteration. To keep SEED-PARITY between two slates compared at the
  // same seed (a baseline vs. a scenario that TAGS some seats with r.region — see lib/scenario_engine), the
  // draw COUNT + ORDER must be identical for both runs: callers comparing slates pass the SAME `regionKeys` to
  // both, so swings are drawn for a fixed key list UP FRONT (below), never lazily in seat order. Default (no
  // regionKeys, regionSigma=0) → null → NO region draws, byte-identical to the pre-correlation baseline path.
  const regionKeys = opts.regionKeys != null
    ? opts.regionKeys
    : (regionSigma > 0 ? [...new Set((races || []).map((r) => r && r.region).filter(Boolean))].sort() : null);

  const byCh = {};
  for (const r of (races || [])) { if (r && r.chamber) (byCh[r.chamber] = byCh[r.chamber] || []).push(r); }
  const chNames = Object.keys(byCh).sort();

  const seatSeries = {}; const controlA = {};
  for (const ch of chNames) { seatSeries[ch] = new Array(iterations); controlA[ch] = 0; }
  const scenarioCounts = {};

  for (let i = 0; i < iterations; i++) {
    const natSwing = normal(rng) * nationalSigma;
    // Draw a swing per region key UP FRONT, in fixed order (deterministic → seed-parity across slates). Null
    // regionKeys (the default path) draws nothing, so the baseline forecast's RNG stream is untouched.
    let regionSwing = null;
    if (regionKeys && regionKeys.length) { regionSwing = {}; for (const k of regionKeys) regionSwing[k] = normal(rng) * regionSigma; }
    const ctrl = {};
    for (const ch of chNames) {
      const hv = holdovers[ch] || {};
      let aSeats = hv.A || 0;
      for (const r of byCh[ch]) {
        const rs = (regionSwing && r.region != null && (r.region in regionSwing)) ? regionSwing[r.region] : 0;
        const m = r.margin + natSwing + rs + normal(rng) * (r.sigma != null ? r.sigma : defaultSigma);
        if (m > 0) aSeats++;
      }
      seatSeries[ch][i] = aSeats;
      const totalSeats = byCh[ch].length + (hv.A || 0) + (hv.B || 0);
      const need = majority[ch] != null ? majority[ch] : Math.floor(totalSeats / 2) + 1;
      const aWins = aSeats >= need;
      if (aWins) controlA[ch]++;
      ctrl[ch] = aWins ? 'A' : 'B';
    }
    const label = chNames.map((ch) => `${ch}:${ctrl[ch]}`).join(' | ');
    scenarioCounts[label] = (scenarioCounts[label] || 0) + 1;
  }

  const chambers = {};
  for (const ch of chNames) {
    const arr = seatSeries[ch]; const hv = holdovers[ch] || {};
    chambers[ch] = {
      pA_control: controlA[ch] / iterations,
      seatsA_mean: Number(mean(arr).toFixed(2)),
      seatsA_sd: Number(Math.sqrt(variance(arr)).toFixed(2)),
      seatsA_p10: quantile(arr, 0.1), seatsA_p90: quantile(arr, 0.9),
      n_races: byCh[ch].length, total_seats: byCh[ch].length + (hv.A || 0) + (hv.B || 0),
    };
  }
  const scenarios = Object.entries(scenarioCounts).map(([label, c]) => ({ label, prob: Number((c / iterations).toFixed(4)) })).sort((a, b) => b.prob - a.prob);
  return { iterations, chambers, scenarios };
}

module.exports = { simulate, marginToWinProb, winProbToMargin, Phi, PhiInv, mulberry32, mean, variance, quantile };
