'use strict';
/* smoke_forecast_answer.js — THE FORECAST ANSWER (catch #6 cure, 08-24).
 * Sprint-2 catch #6: "whats our forecast on the midterms" drew two stacked "let me…" says and NO
 * numbers while the balance-of-power suite sat computed. The cure is the proven injection
 * pattern: a forecast-shaped ask injects the suite's code-authored digest into the reply
 * context. Pure detector + pure digest + the main.js wiring pins. */
const fs = require('fs'), path = require('path');
const fa = require('../lib/forecast_answer');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log(`  ✓ ${t}`); } else { fail++; console.log(`  ✗ ${t}`); } };

// ── the detector ──────────────────────────────────────────────────────────────────────────────
ok(fa.isForecastAsk("whats our forecast on the midterms"), '⭐ the exact catch-#6 phrasing fires the door');
ok(fa.isForecastAsk('what are the odds the House flips this election?'), 'odds + election context fires');
ok(fa.isForecastAsk('who is going to win the senate races'), '"who is going to win" + senate fires');
ok(fa.isForecastAsk('show me the balance of power projection for congress'), 'balance-of-power + congress fires');
ok(!fa.isForecastAsk("what's the weather forecast for Tampa"), 'a WEATHER forecast never enters this door');
ok(!fa.isForecastAsk('any rain in the forecast for the election day drive?'), 'weather term vetoes even with election context');
ok(!fa.isForecastAsk('whats our forecast'), 'a forecast term with NO election context stays out (could be anything)');
ok(!fa.isForecastAsk('the house needs new paint'), 'context token alone never fires');
ok(!fa.isForecastAsk(''), 'empty is safe');

// ── the digest ────────────────────────────────────────────────────────────────────────────────
const RES = {
  ok: true, live: true, computedTs: Date.UTC(2026, 7, 24, 15, 30),
  payload: {
    house: { pD_control: 0.62, pR_control: 0.38, dSeats_mean: 222.4, dSeats_p10: 210, dSeats_p90: 235, need: 218, total: 435 },
    senate: { pD_control: 0.31, pR_control: 0.69, dSeats_mean: 49.2, dSeats_p10: 46, dSeats_p90: 52, need: 51, total: 100 },
    scenarios: [{ label: 'House D + Senate R', prob: 0.45 }, { label: 'House D + Senate D', prob: 0.17 }],
  },
  work: { margins: { polled: 63, total: 470 }, coverage: { races: 470 } },
};
const d = fa.digest(RES);
ok(/House: P\(D control\) 62% \/ P\(R control\) 38%/.test(d), 'digest: House control probabilities, code-authored');
ok(/mean D seats 222 \(p10 210 – p90 235\)/.test(d), 'digest: seat mean + p10/p90 band');
ok(/218 of 435 for the majority/.test(d), 'digest: the majority line rides');
ok(/Senate: P\(D control\) 31%/.test(d), 'digest: Senate rides too');
ok(/Scenarios: House D \+ Senate R 45% · House D \+ Senate D 17%/.test(d), 'digest: top scenarios with probabilities');
ok(/Basis: 63\/470 races polled · 470 seats covered · LIVE polls riding/.test(d), 'digest: the basis line is honest about coverage');
ok(/Computed: Aug 24, 11:30 AM ET/.test(d), 'digest: the computed-at stamp displays EASTERN');
ok(fa.digest(null) === null && fa.digest({ ok: true }) === null && fa.digest({ ok: true, payload: {} }) === null, 'no computed result → null (the caller injects the honest state, never numbers)');

// ── the wiring pins ───────────────────────────────────────────────────────────────────────────
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/_fa\.isForecastAsk\(userMessage\)/.test(main) && /FORECAST — EXACT, computed by the held balance-of-power suite/.test(main), 'wiring: a forecast ask injects the suite digest into the reply context');
ok(/NOT recomputed yet this boot/.test(main) && /NEVER invent numbers/.test(main), 'wiring: no recompute yet → the honest state rides, never invented numbers');
ok(/lastForecast\.computedTs = Date\.now\(\)/.test(main), 'wiring: the recompute stamps its time for the digest');
ok(main.indexOf('_fa.isForecastAsk') > main.indexOf('[DATASET COUNTS — EXACT'), 'wiring: the forecast inject rides beside the proven injection block');

console.log(`\nsmoke_forecast_answer: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
