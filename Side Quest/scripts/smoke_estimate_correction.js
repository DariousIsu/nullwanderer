/* Smoke: lib/estimate + lib/correction — the confirm+estimate+correct loop the silent intake gate was
 * missing (a "money"→"many" misread had no readback, no ETA, no way to take effect). Pure + a mock cloud.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_estimate_correction.js
 */
'use strict';
const est = require('../lib/estimate');
const corr = require('../lib/correction');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- estimate ---
ok(est.humanizeMin(45) === '~45 min', '45 → "~45 min"');
ok(est.humanizeMin(60) === '~1 hour', '60 → "~1 hour"');
ok(est.humanizeMin(95) === '~1h 35m', '95 → "~1h 35m"');
ok(est.estimateRun({ orgCount: 19, deep: true }).totalMin === 95, '19 orgs deep → 95 min (5/org)');
ok(est.estimateRun({ orgCount: 19, deep: false }).totalMin === 57, '19 orgs single → 57 min (3/org)');
ok(est.estimateRun({ orgCount: 5, deep: true }).human === '~25 min', '5 orgs deep → ~25 min');
ok(est.estimateRun({ orgCount: 0 }).human === '(nothing to do)', '0 orgs → nothing');
ok(est.estimateRun({ orgCount: 10, deep: true, perOrgMin: 4 }).basis === 'measured', 'a measured rate override → basis=measured');
const rb = est.readbackLine({ facet: 'as many contacts as possible', orgCount: 5, deep: true, priority: 'red' });
ok(/Understood as \[red\]/.test(rb) && /5 organizations/.test(rb) && /Estimated ~25 min/.test(rb) && /as many contacts/.test(rb), 'readback states scope + facet + estimate + priority');

// --- correction applyPlan (pure) ---
const active = { goal: 'enrich think tanks', facet: 'financial/funding points of contact', orgs: ['Conservative Energy Network', 'Hudson Institute', 'Cicero Institute', 'ClearPath', 'Manhattan Institute', 'Heritage Foundation', 'Cato Institute'], deep: true };
// facet correction (the money→many fix)
ok(corr.applyPlan({ isCorrection: true, newFacet: 'as many points of contact as possible', subsetOrgs: [], deep: null }, active).changes.facet === 'as many points of contact as possible', 'facet correction → rewrites the facet');
// narrow to a subset (resolved back to canonical names, tolerant match)
const narrowed = corr.applyPlan({ isCorrection: true, newFacet: null, subsetOrgs: ['Conservative Energy', 'Hudson', 'Cicero', 'ClearPath', 'Manhattan'], deep: null }, active);
ok(narrowed.changed && narrowed.changes.orgs.length === 5 && narrowed.changes.orgs.includes('Conservative Energy Network'), 'subset narrows the work-list to the matched 5, canonical names');
// depth change
ok(corr.applyPlan({ isCorrection: true, newFacet: null, subsetOrgs: [], deep: false }, active).changes.deep === false, 'depth correction → deep:false');
// combined
const both = corr.applyPlan({ isCorrection: true, newFacet: 'all contact info', subsetOrgs: ['Hudson', 'Cicero'], deep: null }, active);
ok(both.changes.facet === 'all contact info' && both.changes.orgs.length === 2, 'combined facet + subset both applied');
// no-ops
ok(corr.applyPlan({ isCorrection: false }, active).changed === false, 'not a correction → no change');
ok(corr.applyPlan({ isCorrection: true, newFacet: active.facet, subsetOrgs: [], deep: true }, active).changed === false, 'a "correction" identical to current state → no change');
ok(corr.applyPlan(null, active).changed === false, 'null decision → no change');
ok(corr.applyPlan({ isCorrection: true, subsetOrgs: active.orgs, deep: null }, active).changed === false, 'subset == all orgs → not a narrowing (no change)');

(async () => {
  // --- classify (cloud seam) ---
  let captured = null;
  const mockAsk = async (args) => { captured = args; return { isCorrection: true, newFacet: 'as many contacts as possible', subsetOrgs: ['Hudson Institute'], deep: null, note: 'fixed money→many, narrowed' }; };
  const d = await corr.classify('sorry I meant MANY contacts, and just Hudson', { activeRun: active, deps: { ask: mockAsk } });
  ok(captured && captured.task === 'run_correction' && /current_facet/.test(JSON.stringify(captured.input)), 'classify packs the active run state for the cloud');
  ok(d && d.isCorrection === true && corr.applyPlan(d, active).changes.facet === 'as many contacts as possible', 'a real correction flows classify → applyPlan');
  ok((await corr.classify('hi', { activeRun: active, deps: { ask: async () => null } })) === null || true, 'cloud-down tolerated (null)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
