/* Smoke: lib/scenario_estimate — Slice 1 of the Conditional Scenario Engine (docs/SCENARIO_ENGINE_DESIGN.md
 * §4a). THE PROOFS, all OFFLINE with a MOCKED ask (no cloud):
 *   • summarizeUniverse / universeText build the compact seat-universe prompt input;
 *   • validateEffects parses the model's JSON → normalized Effect[], CAPS magnitudes (a model can't assert a
 *     30-pt swing), DROPS invented regions / bad scopes / no-op effects, and fails safe on garbage;
 *   • estimateEffects returns effects via the injected ask, and fails soft with no ask (no phantom scenario);
 *   • a described what-if becomes a runnable Scenario that propagates through the Slice-0 engine (two-sided
 *     when the estimate flags direction_uncertain).
 *   node scripts/smoke_scenario_estimate.js
 */
'use strict';
const est = require('../lib/scenario_estimate');
const engine = require('../lib/scenario_engine');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const races = [
  { id: 'CA-01:us-representative', chamber: 'house', state: 'CA', geo: 'CA-01', margin: 2, sigma: 4 },
  { id: 'NV-03:us-representative', chamber: 'house', state: 'NV', geo: 'NV-03', margin: 0.5, sigma: 5 },
  { id: 'TX-15:us-representative', chamber: 'house', state: 'TX', geo: 'TX-15', margin: -8, sigma: 4 },
  { id: 'OH-13:us-representative', chamber: 'house', state: 'OH', geo: 'OH-13', margin: -2, sigma: 5 },
  { id: 'AZ:us-senator', chamber: 'senate', state: 'AZ', geo: 'AZ', margin: 1, sigma: 5 },
  { id: 'OH:us-senator', chamber: 'senate', state: 'OH', geo: 'OH', margin: -5, sigma: 5 },
];

console.log('universe summary:');
const u = est.summarizeUniverse(races);
ok(u.chambers.house.total === 4 && u.chambers.senate.total === 2, 'summarizeUniverse counts seats per chamber');
ok(u.competitiveTotal === 5, 'summarizeUniverse counts competitive seats (CA-01, NV-03, OH-13, AZ-Sen, OH-Sen — all |margin|≤6)');
const utext = est.universeText(u);
ok(/Chambers/.test(utext) && /fire-west/.test(utext), 'universeText renders chambers + offers the named zones');

console.log('validateEffects (parse + CAP + drop invalid):');
// A model output with: a two-sided national effect; a fire-west effect with OVER-CAP magnitudes; an INVENTED
// region; a valid state effect; and a no-op. Only 3 should survive, with the over-cap one clamped.
const MOCK_RAW = JSON.stringify([
  { scope: 'national', competitiveOnly: true, margin_delta: 2, sigma_add: 2, direction_uncertain: true, rationale: 'rally vs backlash', confidence: 0.3 },
  { scope: 'region', value: 'fire-west', competitiveOnly: true, margin_delta: -20, sigma_add: 9, rationale: 'western punishment', confidence: 0.4 },
  { scope: 'region', value: 'atlantis', margin_delta: -3, sigma_add: 1, rationale: 'invented place' },
  { scope: 'state', value: 'OH', competitiveOnly: true, margin_delta: -2, sigma_add: 1, rationale: 'ohio', confidence: 0.5 },
  { scope: 'national', margin_delta: 0, sigma_add: 0, rationale: 'no-op' },
]);
const v = est.validateEffects(MOCK_RAW);
ok(v.valid && v.value.length === 3, 'keeps the 3 valid effects, drops the invented region + the no-op');
const fw = v.value.find((e) => e.selector.scope === 'region' && e.selector.value === 'fire-west');
ok(fw && fw.margin_delta === -8 && fw.sigma_add === 5, '⭐magnitudes are CAPPED: −20→−8 and σ 9→5 (wide priors, not precise)');
ok(v.value.find((e) => e.selector.scope === 'national').direction_uncertain === true, 'the ambiguous national effect keeps direction_uncertain');
ok(!v.value.some((e) => e.selector.value === 'atlantis'), '⭐an invented region is dropped (the model cannot name geography that does not exist)');
ok(est.validateEffects('not json').valid === false && est.validateEffects('[]').valid === false, 'garbage / empty output fails safe (no effects)');

console.log('estimateEffects (injected ask) + fail-soft:');
// Mock ask honors the real contract: it runs the module's own `validate` on a raw model string and returns .value.
const mockAsk = async ({ validate }) => { const r = validate(MOCK_RAW); return r.valid ? r.value : null; };
(async () => {
  const e1 = await est.estimateEffects({ description: 'Iran war hot on election day', races, ask: mockAsk });
  ok(e1.effects.length === 3 && !e1.error, 'estimateEffects returns the validated effects via the ask');
  const e2 = await est.estimateEffects({ description: 'x', races, ask: null });
  ok(e2.effects.length === 0 && /no ask/.test(e2.error), 'no ask → fail-soft empty (no phantom scenario)');
  const e3 = await est.estimateEffects({ description: '', races, ask: mockAsk });
  ok(e3.effects.length === 0 && /no description/.test(e3.error), 'empty description → declines');

  console.log('built scenario runs through the engine:');
  const built = await est.buildScenarioFromDescription({ description: 'Iran war hot on election day', races, ask: mockAsk });
  ok(built.scenario && built.scenario.effects.length === 3 && built.scenario.estimated_by === est.MODEL, 'buildScenarioFromDescription wraps the estimate into a runnable, attributed Scenario');
  const run = engine.runScenario(races, built.scenario, { seed: 5, iterations: 2000, nationalSigma: 3 });
  ok(run.status === 'hypothetical', 'the estimated scenario runs as a labeled hypothetical');
  ok(run.two_sided === true && run.positive && run.negative, '⭐direction_uncertain in the estimate → the run is two-sided (a RANGE), preserved end-to-end');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
