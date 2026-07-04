/**
 * lib/backtest.js — the FULL-CHAIN backtest: validate the structural forecasting model end-to-end against real
 * outcomes, and TUNE the uncertainty prior to a calibrated value. Uses presidential history (state margins
 * 1976-2024) as ground truth; the mechanics it validates (lean-prior → national swing → margin → win-prob →
 * interval) are exactly the ones the congressional chain reuses. The congressional-SPECIFIC mechanic (the
 * midterm swing) is backtested separately in lib/congress_results.js against MEDSL 1976-2018 results.
 *
 * The chain under test, leave-one-election-out: for each (state, year) with prior history,
 *   prior_lean  = mean of the state's PRIOR presidential margins        (the partisan baseline)
 *   nat_shift   = national margin this year − the state's prior-window national average   (the environment)
 *   predicted   = prior_lean + nat_shift
 *   win_prob    = Φ(predicted / σ)                                       (forecast_sim.marginToWinProb)
 * scored with calibration.js: margin RMSE/MAE, win Brier + skill, reliability/ECE (are the probs calibrated?),
 * and 95% interval coverage. `tuneSigma` sweeps σ to the value whose intervals actually cover 95% — turning a
 * guessed race-σ into a measured one. PURE (inject the CSV texts) → offline-testable; the live driver reads the data.
 */
'use strict';

const cal = require('./calibration');
const sim = require('./forecast_sim');

// quote-aware CSV → array-of-objects (candidate names contain commas, so a naive split corrupts columns)
function csvRows(text) {
  const s = String(text == null ? '' : text);
  const rows = []; let f = '', row = [], q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function csvObjects(text) {
  const r = csvRows(text); if (r.length < 2) return [];
  const h = r[0].map((x) => x.trim());
  return r.slice(1).map((row) => { const o = {}; h.forEach((k, i) => { o[k] = row[i]; }); return o; });
}

// MEDSL presidential CSV text(s) → { margins:{'year|ST':Dmargin%}, national:{year:Dmargin%} }
function parsePresHistory(texts) {
  const agg = {};
  for (const text of (Array.isArray(texts) ? texts : [texts])) {
    for (const r of csvObjects(text)) {
      const y = Number(r.year), st = (r.state_po || '').trim(), p = (r.party_simplified || '').trim();
      const v = Number(r.candidatevotes != null && r.candidatevotes !== '' ? r.candidatevotes : r.votes) || 0;
      const tot = Number(r.totalvotes) || 0;
      if (!y || !st) continue;
      const a = agg[y + '|' + st] || (agg[y + '|' + st] = { D: 0, R: 0, T: 0 });
      if (p === 'DEMOCRAT') a.D += v; else if (p === 'REPUBLICAN') a.R += v;
      if (tot > a.T) a.T = tot;
    }
  }
  const margins = {}, num = {}, den = {};
  for (const k in agg) {
    const a = agg[k], tot = a.T || (a.D + a.R);
    if (tot > 0) { margins[k] = (a.D - a.R) / tot * 100; const y = k.split('|')[0]; num[y] = (num[y] || 0) + (a.D - a.R); den[y] = (den[y] || 0) + tot; }
  }
  const national = {}; for (const y in num) if (den[y]) national[y] = num[y] / den[y] * 100;
  return { margins, national };
}

/**
 * LOEO backtest of the structural chain. opts: { sigma=9, holdNational=false }.
 * holdNational=true drops the environment term (tests the state-baseline alone).
 * → { n, rmse, mae, brier, brier_skill, ece, reliability, coverage95, sigma }
 */
function backtestChain(history, opts = {}) {
  const { margins, national } = history || {};
  const sigma = opts.sigma != null ? opts.sigma : 9;
  const byState = {};
  for (const k in (margins || {})) { const parts = k.split('|'); (byState[parts[1]] = byState[parts[1]] || []).push({ year: Number(parts[0]), margin: margins[k] }); }
  for (const st in byState) byState[st].sort((a, b) => a.year - b.year);

  const marginItems = [], winItems = [], intervalItems = [];
  for (const st in byState) {
    const seq = byState[st];
    for (let i = 1; i < seq.length; i++) {
      const actual = seq[i].margin;
      const prior = seq.slice(0, i).map((x) => x.margin);
      const priorLean = prior.reduce((s, x) => s + x, 0) / prior.length;
      const priorNat = seq.slice(0, i).map((x) => national[x.year]).filter((x) => x != null);
      const natBase = priorNat.length ? priorNat.reduce((s, x) => s + x, 0) / priorNat.length : 0;
      const natShift = opts.holdNational ? 0 : ((national[seq[i].year] != null ? national[seq[i].year] : 0) - natBase);
      const pred = priorLean + natShift;
      marginItems.push({ pred, actual });
      winItems.push({ prob: sim.marginToWinProb(pred, sigma), outcome: actual > 0 ? 1 : 0 });
      intervalItems.push({ lo: pred - 1.96 * sigma, hi: pred + 1.96 * sigma, actual });
    }
  }
  return {
    n: marginItems.length,
    rmse: cal.rmse(marginItems), mae: cal.mae(marginItems),
    brier: cal.brier(winItems), brier_skill: cal.brierSkill(winItems),
    ece: cal.reliability(winItems).ece, reliability: cal.reliability(winItems, 5).bins,
    coverage95: cal.intervalCoverage(intervalItems), sigma,
  };
}

// sweep σ → the value whose 95% intervals actually cover ~95% (a MEASURED race-σ, not a guess).
function tuneSigma(history, sigmas = [5, 6, 7, 8, 9, 10, 11, 12, 14, 16], opts = {}) {
  let best = null;
  for (const s of sigmas) {
    const r = backtestChain(history, { ...opts, sigma: s });
    const covErr = Math.abs((r.coverage95 || 0) - 0.95);
    if (!best || covErr < best.covErr) best = { sigma: s, covErr, coverage95: r.coverage95, brier: r.brier, rmse: r.rmse };
  }
  return best;
}

module.exports = { csvObjects, parsePresHistory, backtestChain, tuneSigma };
