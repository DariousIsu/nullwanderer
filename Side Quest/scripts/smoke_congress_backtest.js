/**
 * Offline smoke for lib/congress_results.js — the congressional parser + midterm-swing backtest.
 * Deterministic synthetic fixture (no network, no data files). Run: node scripts/smoke_congress_backtest.js
 */
const C = require('../lib/congress_results');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;

// House fixture: one seat over 4 cycles, an at-large seat, plus a SPECIAL and a PRIMARY row that must be dropped.
const houseCsv = 'year,state_po,office,district,stage,special,party,candidatevotes\n'
  + '2012,AZ,US House,1,gen,FALSE,democrat,110000\n2012,AZ,US House,1,gen,FALSE,republican,90000\n'
  + '2014,AZ,US House,1,gen,FALSE,democrat,80000\n2014,AZ,US House,1,gen,FALSE,republican,120000\n'
  + '2016,AZ,US House,1,gen,FALSE,democrat,105000\n2016,AZ,US House,1,gen,FALSE,republican,95000\n'
  + '2018,AZ,US House,1,gen,FALSE,democrat,130000\n2018,AZ,US House,1,gen,FALSE,republican,70000\n'
  + '2018,AK,US House,0,gen,FALSE,democrat,60000\n2018,AK,US House,0,gen,FALSE,republican,140000\n'
  + '2018,AZ,US House,1,gen,TRUE,democrat,999999\n'      // special — drop
  + '2018,AZ,US House,1,pri,FALSE,democrat,999999\n';    // primary — drop
const senateCsv = 'year,state_po,office,district,stage,special,party,candidatevotes\n'
  + '2016,FL,US Senate,statewide,gen,FALSE,democrat,4000000\n2016,FL,US Senate,statewide,gen,FALSE,republican,4600000\n';

const hist = C.parseCongressHistory(houseCsv, senateCsv);
const H = hist.house, S = hist.senate;

// parse — two-party margins, seat keys, gen-only, special/primary dropped
ok('house margin 2012 AZ-01 = D+10', near(H.margins['2012|AZ-01'], 10, 0.01), `${H.margins['2012|AZ-01']}`);
ok('house margin 2014 AZ-01 = R-20', near(H.margins['2014|AZ-01'], -20, 0.01), `${H.margins['2014|AZ-01']}`);
ok('house margin 2018 AZ-01 = D+30 (special+primary NOT leaked)', near(H.margins['2018|AZ-01'], 30, 0.01), `${H.margins['2018|AZ-01']}`);
ok('house at-large padded to AK-00 = R-40', near(H.margins['2018|AK-00'], -40, 0.01), `${H.margins['2018|AK-00']}`);
ok('house national 2018 = -5.0 (two-party, seat-summed)', near(H.national['2018'], -5.0, 0.01), `${H.national['2018']}`);
ok('senate seat key is ST; FL 2016 = R-6.98', near(S.margins['2016|FL'], -6.976, 0.02), `${S.margins['2016|FL']}`);

// reference tables
ok('isMidterm: 2018 true, 2016 false, 2026 true', C.isMidterm(2018) && !C.isMidterm(2016) && C.isMidterm(2026));
ok('president party: 2018 R, 2026 R', C.PRESIDENT_PARTY_BY_YEAR[2018] === 'R' && C.PRESIDENT_PARTY_BY_YEAR[2026] === 'R');
ok('midtermAdj sign: R-president midterm → +swing toward D', C.midtermAdj(2018, 3) === 3 && C.midtermAdj(2014, 3) === -3 && C.midtermAdj(2016, 3) === 0);

// backtest — LOEO count (AZ-01 has 4 years → 3 items; AK-00 single year → 0), fields present
const bt = C.backtestChamber(H, { swing: 3, holdNational: true });
ok('backtestChamber: LOEO n = 3', bt.n === 3, `n ${bt.n}`);
ok('backtestChamber: reports brier/skill/coverage/midterm block', bt.brier != null && bt.brier_skill != null && bt.coverage95 != null && bt.midterm && bt.midterm.n === 2, JSON.stringify(bt.midterm));

// midtermSummary — realized swing vs president, per midterm year with a prior
const sum = C.midtermSummary(H);
ok('midtermSummary: returns per-year + mean', Array.isArray(sum.perYear) && typeof sum.mean === 'number');

// tuneMidtermSwing — sweeps and returns a best swing over the grid
const tune = C.tuneMidtermSwing(H);
ok('tuneMidtermSwing: sweeps the grid, returns a swing', tune && Array.isArray(tune.all) && tune.all.length >= 8 && tune.swing != null, JSON.stringify({ swing: tune.swing, n: tune.all.length }));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
