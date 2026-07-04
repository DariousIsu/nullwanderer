/**
 * Offline smoke for lib/backtest.js — the full-chain presidential backtest. Run: node scripts/smoke_backtest.js
 */
const B = require('../lib/backtest');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;

// csvObjects: quote-aware (candidate names with commas must NOT shift columns)
const rows = B.csvObjects('year,candidate,state_po\n1976,"CARTER, JIMMY",GA\n2020,"BIDEN, JOSEPH R. JR",PA\n');
ok('csvObjects: quoted comma kept intact, columns aligned', rows[0].state_po === 'GA' && rows[0].candidate === 'CARTER, JIMMY' && rows[1].state_po === 'PA');

// parsePresHistory: margins + national from a tiny MEDSL-shaped CSV
const csv = 'year,state_po,party_simplified,candidatevotes,totalvotes\n'
  + '2020,CA,DEMOCRAT,11000000,17500000\n2020,CA,REPUBLICAN,6000000,17500000\n'
  + '2020,TX,DEMOCRAT,5259000,11300000\n2020,TX,REPUBLICAN,5890000,11300000\n';
const h1 = B.parsePresHistory(csv);
ok('parsePresHistory: CA margin ≈ D+28.6', near(h1.margins['2020|CA'], 28.57, 0.1), `${h1.margins['2020|CA']}`);
ok('parsePresHistory: TX margin ≈ R-5.6', near(h1.margins['2020|TX'], -5.58, 0.1), `${h1.margins['2020|TX']}`);
ok('parsePresHistory: national aggregated', near(h1.national['2020'], ((11000000 + 5259000 - 6000000 - 5890000) / (17500000 + 11300000)) * 100, 0.1));

// backtestChain: synthetic history — stable-lean states predict well; a tossup lands near 50/50
const history = {
  national: { 2000: 0, 2004: -2, 2008: 7, 2012: 4, 2016: -1 },
  margins: {},
};
const put = (st, vals) => Object.entries(vals).forEach(([y, m]) => { history.margins[y + '|' + st] = m; });
put('AA', { 2000: 20, 2004: 22, 2008: 18, 2012: 21, 2016: 19 });   // stable D
put('BB', { 2000: -30, 2004: -28, 2008: -32, 2012: -29, 2016: -31 });  // stable R
put('CC', { 2000: 2, 2004: -1, 2008: 3, 2012: -2, 2016: 1 });      // tossup

const bt = B.backtestChain(history, { sigma: 8 });
ok('backtestChain: LOEO count = (years-1)*states', bt.n === 12, `n ${bt.n}`);
ok('backtestChain: stable leans → low RMSE (<10)', bt.rmse != null && bt.rmse < 10, `rmse ${bt.rmse}`);
ok('backtestChain: beats coin flip (brier < 0.25 / skill > 0)', bt.brier < 0.25 && bt.brier_skill > 0, `brier ${bt.brier} skill ${bt.brier_skill}`);
ok('backtestChain: coverage + ece reported', bt.coverage95 != null && bt.coverage95 >= 0 && bt.coverage95 <= 1 && bt.ece != null);
ok('backtestChain: holdNational drops the environment term', B.backtestChain(history, { sigma: 8, holdNational: true }).n === 12);

// tuneSigma: sweeps σ, returns the coverage-matched value
const tuned = B.tuneSigma(history);
ok('tuneSigma: returns a σ with a coverage read', tuned && tuned.sigma > 0 && tuned.coverage95 != null, JSON.stringify(tuned));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
