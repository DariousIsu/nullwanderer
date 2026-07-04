/**
 * Offline smoke for lib/calibration.js — the calibration harness. Known-answer tests for every scorer + a
 * poll-aggregation backtest on fixtures + a forecast_sim self-consistency check. Run: node scripts/smoke_calibration.js
 */
const C = require('../lib/calibration');
const sim = require('../lib/forecast_sim');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;

// ---- Brier / log-loss / skill (known answers) ----
ok('brier: perfect forecast → 0', C.brier([{ prob: 1, outcome: 1 }, { prob: 0, outcome: 0 }]) === 0);
ok('brier: coin-flip on decided outcomes → 0.25', C.brier([{ prob: 0.5, outcome: 1 }, { prob: 0.5, outcome: 0 }]) === 0.25);
ok('logLoss: perfect → ~0', near(C.logLoss([{ prob: 0.999999, outcome: 1 }, { prob: 1e-6, outcome: 0 }]), 0, 1e-3));
ok('brierSkill: confident-correct beats base rate (>0)', C.brierSkill([{ prob: 0.9, outcome: 1 }, { prob: 0.1, outcome: 0 }, { prob: 0.8, outcome: 1 }, { prob: 0.2, outcome: 0 }]) > 0.5);
ok('brierSkill: the base-rate forecast scores 0', C.brierSkill([{ prob: 0.5, outcome: 1 }, { prob: 0.5, outcome: 0 }], 0.5) === 0);

// ---- reliability / ECE ----
const calibrated = [];
for (let i = 0; i < 10; i++) calibrated.push({ prob: 0.0, outcome: 0 });
for (let i = 0; i < 10; i++) calibrated.push({ prob: 1.0, outcome: 1 });
ok('reliability: perfectly calibrated → ECE ~0', near(C.reliability(calibrated).ece, 0, 0.02));
const miscal = Array.from({ length: 10 }, () => ({ prob: 0.9, outcome: 0 }));   // says 90% but never happens
ok('reliability: overconfident → high ECE', C.reliability(miscal).ece > 0.5);

// ---- point / interval ----
ok('rmse: known', C.rmse([{ pred: 2, actual: 0 }, { pred: -2, actual: 0 }]) === 2);
ok('mae: known', C.mae([{ pred: 3, actual: 0 }, { pred: -1, actual: 0 }]) === 2);
ok('intervalCoverage: 1 in, 1 out → 0.5', C.intervalCoverage([{ lo: -1, hi: 1, actual: 0 }, { lo: -1, hi: 1, actual: 5 }]) === 0.5);

// ---- poll-aggregation backtest: recency weighting should beat the naive mean when the old poll is off ----
const race = (id, polls) => polls.map((p) => ({ cycle: 2020, location: 'XX', race: id, election_date: '2020-11-03', margin_actual: 5, ...p }));
const rawPolls = [
  ...race('R1', [
    { pollster: 'A', poll_date: '2020-06-01', sample_size: 800, margin_poll: -10 },  // old, way off
    { pollster: 'B', poll_date: '2020-10-30', sample_size: 1200, margin_poll: 5 },    // recent, accurate
  ]),
  ...race('R2', [
    { pollster: 'A', poll_date: '2020-05-01', sample_size: 600, margin_poll: 15 },
    { pollster: 'C', poll_date: '2020-10-28', sample_size: 1500, margin_poll: 4 },
  ]),
];
const bt = C.backtestPollAverage(rawPolls);
ok('backtest: groups by race', bt.n_races === 2 && bt.n_polls === 4);
ok('backtest: recency-weighted RMSE beats equal-weight mean (skill > 0)', bt.skill_vs_naive > 0, `model ${bt.rmse_model} vs naive ${bt.rmse_naive}`);

// ---- forecast_sim self-consistency: margin-0 races → seatsA_mean ≈ n/2; national swing widens the distribution ----
const zeroRaces = Array.from({ length: 100 }, (_, i) => ({ id: 'h' + i, chamber: 'house', margin: 0, sigma: 5 }));
const indep = sim.simulate(zeroRaces, { nationalSigma: 0, iterations: 20000, seed: 3 }).chambers.house;
const corr = sim.simulate(zeroRaces, { nationalSigma: 6, iterations: 20000, seed: 3 }).chambers.house;
ok('sim: 100 margin-0 races → seatsA_mean ≈ 50 (symmetric)', near(indep.seatsA_mean, 50, 1.5), `mean ${indep.seatsA_mean}`);
ok('sim: independent sd ≈ binomial sqrt(100)/2 = 5', near(indep.seatsA_sd, 5, 1.2), `sd ${indep.seatsA_sd}`);
ok('sim: national swing FATTENS the distribution (correlation)', corr.seatsA_sd > indep.seatsA_sd * 1.5, `corr sd ${corr.seatsA_sd} vs indep ${indep.seatsA_sd}`);
ok('sim: a lopsided race is ~always won', sim.simulate([{ id: 'x', chamber: 'house', margin: 40, sigma: 5 }], { nationalSigma: 3, iterations: 5000, seed: 1 }).chambers.house.pA_control === 1);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
