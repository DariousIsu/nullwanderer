/**
 * Offline smoke for lib/forecast_sim.js — the correlated scenario simulator (the machine's parts→whole core).
 * Known-answer checks for the normal math; seeded/statistical checks for the simulation. Deterministic.
 * Run: node scripts/smoke_forecast_sim.js
 */
const S = require('../lib/forecast_sim');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }
function near(name, got, want, tol) { ok(name, Math.abs(got - want) <= tol, `got ${got} want ${want}±${tol}`); }

// --- normal CDF / inverse / margin↔prob ---
near('Phi(0)=0.5', S.Phi(0), 0.5, 1e-3);
near('Phi(1.96)=0.975', S.Phi(1.96), 0.975, 2e-3);
near('PhiInv(0.975)=1.96', S.PhiInv(0.975), 1.96, 0.02);
near('marginToWinProb(0,5)=0.5', S.marginToWinProb(0, 5), 0.5, 1e-3);
near('marginToWinProb(10,5)=0.977', S.marginToWinProb(10, 5), 0.9772, 2e-3);
near('winProbToMargin round-trips', S.winProbToMargin(S.marginToWinProb(8, 5), 5), 8, 0.05);
ok('winProbToMargin sign: >0.5 → +', S.winProbToMargin(0.8, 5) > 0);

// --- determinism (same seed → identical) ---
const races1 = [{ id: 'a', chamber: 'house', margin: 2, sigma: 5 }, { id: 'b', chamber: 'house', margin: -1, sigma: 5 }];
ok('deterministic under fixed seed', JSON.stringify(S.simulate(races1, { seed: 7, iterations: 500 })) === JSON.stringify(S.simulate(races1, { seed: 7, iterations: 500 })));

// --- safe sweep: 3 strong-A house races → A controls ~always ---
const safe = [1, 2, 3].map((i) => ({ id: 'h' + i, chamber: 'house', margin: 20, sigma: 3 }));
const rSafe = S.simulate(safe, { nationalSigma: 0.01, iterations: 3000, seed: 1 });
ok('safe sweep: pA_control ≈ 1', rSafe.chambers.house.pA_control > 0.99, String(rSafe.chambers.house.pA_control));
ok('safe sweep: A wins ~all 3 seats', rSafe.chambers.house.seatsA_mean > 2.9);

// --- toss-up: single margin-0 race → ~50/50 ---
const toss = S.simulate([{ id: 't', chamber: 'house', margin: 0, sigma: 5 }], { nationalSigma: 0.01, iterations: 6000, seed: 3 });
near('toss-up: seatsA_mean ≈ 0.5', toss.chambers.house.seatsA_mean, 0.5, 0.05);
near('toss-up: pA_control ≈ 0.5', toss.chambers.house.pA_control, 0.5, 0.05);

// --- CORRELATION FATTENS TAILS (the load-bearing property) ---
const tossup10 = [...Array(10)].map((_, i) => ({ id: 'r' + i, chamber: 'house', margin: 0, sigma: 5 }));
const indep = S.simulate(tossup10, { nationalSigma: 0.01, iterations: 5000, seed: 5 });
const corr = S.simulate(tossup10, { nationalSigma: 12, iterations: 5000, seed: 5 });
ok('correlation raises seat-count SD (independent ≈1.6, correlated ≫)', corr.chambers.house.seatsA_sd > indep.chambers.house.seatsA_sd * 1.5,
  `indep sd ${indep.chambers.house.seatsA_sd} vs corr sd ${corr.chambers.house.seatsA_sd}`);
near('independent 10 toss-ups: SD ≈ binomial 1.58', indep.chambers.house.seatsA_sd, 1.58, 0.25);

// --- scenarios: valid probability distribution over joint control ---
const twoCh = S.simulate([
  { id: 'h', chamber: 'house', margin: 1, sigma: 6 },
  { id: 's', chamber: 'senate', margin: -1, sigma: 6 },
], { iterations: 4000, seed: 9 });
const psum = twoCh.scenarios.reduce((s, x) => s + x.prob, 0);
near('scenario probs sum to 1', psum, 1, 0.002);
ok('scenario probs in [0,1]', twoCh.scenarios.every((s) => s.prob >= 0 && s.prob <= 1));
ok('joint labels span both chambers', twoCh.scenarios.every((s) => /house:[AB] \| senate:[AB]/.test(s.label)));
ok('all four control combos possible under uncertainty', twoCh.scenarios.length === 4, `got ${twoCh.scenarios.length} scenarios`);

// --- holdovers + majority threshold (Senate: seats not up this cycle) ---
const sen = S.simulate([1, 2, 3].map((i) => ({ id: 's' + i, chamber: 'senate', margin: 20, sigma: 3 })),
  { nationalSigma: 0.01, iterations: 2000, seed: 2, holdovers: { senate: { A: 48, B: 49 } }, majority: { senate: 51 } });
ok('holdovers+majority: 48 held + 3 won = 51 ≥ threshold → A controls', sen.chambers.senate.pA_control > 0.95, String(sen.chambers.senate.pA_control));
ok('total_seats counts holdovers (3 up + 97 held = 100)', sen.chambers.senate.total_seats === 100, String(sen.chambers.senate.total_seats));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
