/* Smoke: lib/confidence_model — C3 calibrated, corroboration-sensitive confidence (offline).
 * Proof: (1) confidence rises monotonically with independent corroboration;
 *        (2) Brier + ECE on a verified-fact holdout BEAT the fixed-0.8 baseline
 *            (reusing the forecast calibration harness, lib/calibration).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_confidence_model.js
 */
'use strict';
const M = require('../lib/confidence_model');
const CAL = require('../lib/calibration');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- monotonic in corroboration (for a fixed grade) ---
const bSeq = [1, 2, 3, 4, 6].map((n) => M.calibratedConfidence({ grade: 'B', corroboration: n }));
ok(bSeq.every((v, i) => i === 0 || v > bSeq[i - 1]), 'monotone: grade-B confidence strictly rises with independent corroboration');
ok(M.calibratedConfidence({ grade: 'B', corroboration: 1 }) === M.GRADE_PRIOR.B, 'corr=1 → the single-source grade prior');
ok(bSeq[bSeq.length - 1] < 1 && bSeq[bSeq.length - 1] <= M.CONF_CEIL, 'asymptotes below 1 (never certain)');
// corroboration LIFTS across a grade band: B single-source → B; B triple-corroborated → A
ok(M.gradeFromConfidence(M.calibratedConfidence({ grade: 'B', corroboration: 1 })) === 'B'
  && M.gradeFromConfidence(M.calibratedConfidence({ grade: 'B', corroboration: 3 })) === 'A',
  'corroboration lifts a single-source B into an A-band belief');
// low-grade single source stays low (no free lift from grade alone)
ok(M.calibratedConfidence({ grade: 'E', corroboration: 1 }) < 0.4, 'single-source E stays low');
// unknown grade → default (C) prior, never throws
ok(M.calibratedConfidence({ grade: 'Z', corroboration: 1 }) === M.GRADE_PRIOR.C, 'unknown grade → C prior');

// --- verified-fact holdout (deterministic): observed true-rate per (grade,corr) cell ---
// Real-world reliability the model does NOT get to see; we score predictions vs these outcomes.
const CELLS = [
  { grade: 'A', corr: 1, rate: 0.97 }, { grade: 'A', corr: 3, rate: 0.99 },
  { grade: 'B', corr: 1, rate: 0.88 }, { grade: 'B', corr: 3, rate: 0.97 },
  { grade: 'C', corr: 1, rate: 0.72 }, { grade: 'C', corr: 3, rate: 0.90 },
  { grade: 'D', corr: 1, rate: 0.52 }, { grade: 'D', corr: 2, rate: 0.68 },
  { grade: 'E', corr: 1, rate: 0.33 },
];
const N = 100;   // examples per cell → observed frequency == rate exactly
const calItems = [], fixedItems = [];
for (const c of CELLS) {
  const trues = Math.round(c.rate * N);
  const calP = M.calibratedConfidence({ grade: c.grade, corroboration: c.corr });
  for (let i = 0; i < N; i++) {
    const outcome = i < trues ? 1 : 0;
    calItems.push({ prob: calP, outcome });
    fixedItems.push({ prob: 0.8, outcome });   // the old fixed-cap baseline
  }
}
const brierCal = CAL.brier(calItems);
const brierFixed = CAL.brier(fixedItems);
const eceCal = CAL.reliability(calItems).ece;
const eceFixed = CAL.reliability(fixedItems).ece;
console.log(`    Brier: calibrated=${brierCal}  fixed0.8=${brierFixed}   |   ECE: calibrated=${eceCal}  fixed0.8=${eceFixed}`);
ok(brierCal < brierFixed, `Brier: calibrated (${brierCal}) beats fixed-0.8 (${brierFixed})`);
ok(eceCal < eceFixed, `ECE: calibrated (${eceCal}) beats fixed-0.8 (${eceFixed})`);
ok(brierCal < 0.15, `calibrated Brier is well-calibrated (${brierCal} < 0.15)`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
