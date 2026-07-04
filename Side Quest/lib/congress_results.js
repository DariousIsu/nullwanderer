/**
 * lib/congress_results.js — CONGRESSIONAL ground truth: real U.S. House + Senate election results
 * (MEDSL 1976-2018, CC0) parsed into per-seat two-party margins, plus the LOEO backtest that TUNES the
 * congressional-specific priors the presidential backtest can't reach — chiefly the MIDTERM SWING.
 *
 * Why this exists: lib/backtest.js validates the shared mechanics (lean → national shift → margin → win-prob →
 * interval) on presidential history, but the congressional chain adds a mechanic presidential elections don't
 * have — the president's party loses ground at the MIDTERM. That swing was a guessed prior (2.0). Here we
 * measure it: for every seat with prior history, predict its margin with vs. without a midterm adjustment and
 * find the swing magnitude that best predicts real out-party gains, scored with calibration.js.
 *
 * Data source (sidecar/fetch_data.py): MEDSL constituency-returns on GitHub (CC0, no guestbook) —
 *   1976-2018-house.csv (all 435 districts, 11 midterm cycles) + 1976-2018-senate.csv (statewide).
 * PURE: inject the CSV texts; the live driver reads data/elections/. Reuses csvObjects from backtest.js.
 */
'use strict';

const { csvObjects } = require('./backtest');
const cal = require('./calibration');
const sim = require('./forecast_sim');

// Party controlling the White House at each election year → points the midterm swing toward the OUT-party.
// 'D' | 'R'. (Presidential years are ignored by the swing; kept for completeness.)
const PRESIDENT_PARTY_BY_YEAR = {
  1976: 'R', 1978: 'D', 1980: 'D', 1982: 'R', 1984: 'R', 1986: 'R', 1988: 'R',
  1990: 'R', 1992: 'R', 1994: 'D', 1996: 'D', 1998: 'D', 2000: 'D',
  2002: 'R', 2004: 'R', 2006: 'R', 2008: 'R', 2010: 'D', 2012: 'D',
  2014: 'D', 2016: 'D', 2018: 'R', 2020: 'R', 2022: 'D', 2024: 'D', 2026: 'R',
};

// midterm = even year not divisible by 4 (no presidential race on the ballot).
function isMidterm(year) { const y = Number(year); return y % 2 === 0 && y % 4 !== 0; }

// one chamber's candidate-rows → { margins:{'year|seat':Dmargin%}, national:{year:Dmargin%} }.
// Seat = 'ST-DD' (house, at-large→'00') or 'ST' (senate). Margin = two-party (D-R)/(D+R)*100 — the partisan
// signal; two-party denominator so third parties / write-ins don't dilute it and uncontested seats read ±100.
// General elections only (stage 'gen'); special elections dropped (off-cycle, distort the seat baseline).
function parseChamber(text, chamber) {
  const agg = {};
  for (const r of csvObjects(text)) {
    if (String(r.stage || '').trim().toLowerCase() !== 'gen') continue;
    if (String(r.special || '').trim().toUpperCase() === 'TRUE') continue;
    const y = Number(r.year), st = String(r.state_po || '').trim();
    if (!y || !st) continue;
    const party = String(r.party || '').trim().toLowerCase();
    const v = Number(r.candidatevotes) || 0;
    const seat = chamber === 'house'
      ? st + '-' + String(Number(r.district) || 0).padStart(2, '0')
      : st;
    const key = y + '|' + seat;
    const a = agg[key] || (agg[key] = { D: 0, R: 0 });
    if (party === 'democrat') a.D += v; else if (party === 'republican') a.R += v;
  }
  const margins = {}, num = {}, den = {};
  for (const k in agg) {
    const a = agg[k], two = a.D + a.R;
    if (two <= 0) continue;
    margins[k] = (a.D - a.R) / two * 100;
    const y = k.split('|')[0];
    num[y] = (num[y] || 0) + (a.D - a.R); den[y] = (den[y] || 0) + two;
  }
  const national = {}; for (const y in num) if (den[y]) national[y] = num[y] / den[y] * 100;
  return { margins, national };
}

// both chambers → { house:{margins,national}, senate:{margins,national} }
function parseCongressHistory(houseText, senateText) {
  return { house: parseChamber(houseText, 'house'), senate: parseChamber(senateText, 'senate') };
}

// signed midterm adjustment: magnitude `swing` toward the out-party in midterm years, else 0.
// president D → out-party is R → margin shifts negative; president R → shifts positive (toward D).
function midtermAdj(year, swing) {
  if (!isMidterm(year) || !swing) return 0;
  const pres = PRESIDENT_PARTY_BY_YEAR[Number(year)];
  if (pres === 'D') return -swing;
  if (pres === 'R') return +swing;
  return 0;
}

/**
 * LOEO backtest of the congressional chain for ONE chamber. Mirrors backtest.backtestChain but adds the
 * midterm swing. opts: { swing=2, sigma=12, holdNational=false }.
 *  - holdNational=true  → drop the realized-environment term (the PREDICTIVE test: the midterm swing is our
 *    a-priori stand-in for an environment we don't yet know; this is the mode that tunes the live prior).
 *  - holdNational=false → include the realized national shift (diagnostic: validates the baseline+environment).
 * Scores overall AND restricted to midterm-year items (where the swing actually applies).
 * → { n, n_midterm, rmse, brier, brier_skill, ece, coverage95, midterm:{ n, rmse, brier, brier_skill }, swing, sigma }
 */
function backtestChamber(chamber, opts = {}) {
  const { margins, national } = chamber || {};
  const swing = opts.swing != null ? opts.swing : 2;
  const sigma = opts.sigma != null ? opts.sigma : 12;
  const bySeat = {};
  for (const k in (margins || {})) { const p = k.split('|'); (bySeat[p[1]] = bySeat[p[1]] || []).push({ year: Number(p[0]), margin: margins[k] }); }
  for (const s in bySeat) bySeat[s].sort((a, b) => a.year - b.year);

  const marginItems = [], winItems = [], intervalItems = [], mMargin = [], mWin = [];
  for (const s in bySeat) {
    const seq = bySeat[s];
    for (let i = 1; i < seq.length; i++) {
      const year = seq[i].year, actual = seq[i].margin;
      const prior = seq.slice(0, i).map((x) => x.margin);
      const priorLean = prior.reduce((a, b) => a + b, 0) / prior.length;
      const priorNat = seq.slice(0, i).map((x) => national[x.year]).filter((x) => x != null);
      const natBase = priorNat.length ? priorNat.reduce((a, b) => a + b, 0) / priorNat.length : 0;
      const natShift = opts.holdNational ? 0 : ((national[year] != null ? national[year] : 0) - natBase);
      const pred = priorLean + midtermAdj(year, swing) + natShift;
      const mi = { pred, actual }, wi = { prob: sim.marginToWinProb(pred, sigma), outcome: actual > 0 ? 1 : 0 };
      marginItems.push(mi); winItems.push(wi);
      intervalItems.push({ lo: pred - 1.96 * sigma, hi: pred + 1.96 * sigma, actual });
      if (isMidterm(year)) { mMargin.push(mi); mWin.push(wi); }
    }
  }
  return {
    n: marginItems.length, n_midterm: mMargin.length,
    rmse: cal.rmse(marginItems), brier: cal.brier(winItems), brier_skill: cal.brierSkill(winItems),
    ece: cal.reliability(winItems).ece, coverage95: cal.intervalCoverage(intervalItems),
    midterm: { n: mMargin.length, rmse: cal.rmse(mMargin), brier: cal.brier(mWin), brier_skill: cal.brierSkill(mWin) },
    swing, sigma,
  };
}

// Realized midterm swing, measured directly from the national two-party margin: for each midterm year, how far
// did the national margin move AGAINST the president's party vs. the prior (presidential-year) election?
// The mean of these = the empirical midterm penalty. → { perYear:[{year,pres,swingVsPres}], mean, n }
function midtermSummary(chamber) {
  const nat = (chamber && chamber.national) || {};
  const years = Object.keys(nat).map(Number).sort((a, b) => a - b);
  const perYear = [];
  for (const y of years) {
    if (!isMidterm(y)) continue;
    const prev = years.filter((x) => x < y).pop();
    if (prev == null) continue;
    const pres = PRESIDENT_PARTY_BY_YEAR[y];
    // swing toward out-party, expressed as a positive penalty on the president's party
    const delta = nat[y] - nat[prev];                 // change in D-margin
    const swingVsPres = pres === 'D' ? -delta : (pres === 'R' ? delta : null);   // >0 = moved against president
    if (swingVsPres != null) perYear.push({ year: y, pres, swingVsPres: Math.round(swingVsPres * 10) / 10 });
  }
  const mean = perYear.length ? perYear.reduce((a, b) => a + b.swingVsPres, 0) / perYear.length : 0;
  return { perYear, mean: Math.round(mean * 10) / 10, n: perYear.length };
}

// sweep the midterm swing → the magnitude that maximizes win-Brier SKILL on midterm-year items (the PREDICTIVE
// test, holdNational). This is the measured replacement for the guessed live prior. → { swing, skill, all:[...] }
function tuneMidtermSwing(chamber, swings = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6], opts = {}) {
  let best = null; const all = [];
  for (const sw of swings) {
    const r = backtestChamber(chamber, { ...opts, holdNational: true, swing: sw });
    const rec = { swing: sw, skill: r.midterm.brier_skill, brier: r.midterm.brier, rmse: r.midterm.rmse };
    all.push(rec);
    if (!best || rec.skill > best.skill) best = rec;
  }
  return { swing: best ? best.swing : null, skill: best ? best.skill : null, all };
}

module.exports = {
  PRESIDENT_PARTY_BY_YEAR, isMidterm, midtermAdj,
  parseChamber, parseCongressHistory, backtestChamber, midtermSummary, tuneMidtermSwing,
};
