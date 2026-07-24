/* Smoke: lib/scenario_analogs + the estimator's analog grounding — Slice 4 (docs/SCENARIO_ENGINE_DESIGN.md
 * §6/§10). THE PROOFS, all OFFLINE:
 *   • capMagnitude clamps a magnitude to its historical-analog ceiling, flags whether it capped, and NEVER
 *     leaves one uncapped (unknown/absent analog → the 'generic' engine-wide ceiling);
 *   • the estimator now caps PER-ANALOG: a rally shock estimated at −12 is bounded to −5, an untagged effect
 *     falls back to generic (−8), and each surviving effect carries its {analog, capped} for the glass box.
 *   node scripts/smoke_scenario_analogs.js
 */
'use strict';
const A = require('../lib/scenario_analogs');
const est = require('../lib/scenario_estimate');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

console.log('analog table + capMagnitude:');
ok(!!A.analogOf('rally-round-flag') && A.analogOf('BOGUS') === null, 'analogOf resolves a known key, null for an unknown one');
ok(A.analogKeys().includes('rally-round-flag') && !A.analogKeys().includes('generic'), 'analogKeys lists the categories (excludes the generic fallback)');
const c1 = A.capMagnitude(12, 6, 'rally-round-flag');
ok(c1.margin_delta === 5 && c1.sigma_add === 4 && c1.analog === 'rally-round-flag' && c1.capped === true, '⭐a rally shock estimated at 12 pts is CAPPED to the analog ceiling (5 pts), flagged capped');
const c2 = A.capMagnitude(3, 2, 'rally-round-flag');
ok(c2.margin_delta === 3 && c2.sigma_add === 2 && c2.capped === false, 'a within-bound magnitude passes through untouched (capped:false)');
const c3 = A.capMagnitude(-30, 9, 'nonsense-category');
ok(c3.margin_delta === -8 && c3.sigma_add === 5 && c3.analog === 'generic' && c3.capped === true, '⭐an UNKNOWN analog falls back to generic (8/5) — a magnitude is NEVER left uncapped');
const c4 = A.capMagnitude(-30, 0, 'scandal');
ok(c4.margin_delta === -4 && c4.analog === 'scandal', 'scandal ceiling (4 pts) applied to a large negative estimate');
ok(/rally-round-flag/.test(A.promptGuidance()) && /≤ 5/.test(A.promptGuidance()), 'promptGuidance lists the analogs + their ceilings for the estimator');

console.log('estimator grounds magnitudes to the analog (mocked ask):');
const races = [
  { id: 'CA-01:us-representative', chamber: 'house', state: 'CA', geo: 'CA-01', margin: 2, sigma: 4 },
  { id: 'AZ:us-senator', chamber: 'senate', state: 'AZ', geo: 'AZ', margin: 1, sigma: 5 },
];
// A model output: an over-magnitude RALLY national effect (−12 → cap −5); a fire-west effect with NO analog
// (−20 → generic −8); a disaster effect at −9 (→ −5).
const MOCK = JSON.stringify([
  { scope: 'national', competitiveOnly: true, margin_delta: -12, sigma_add: 6, analog: 'rally-round-flag', direction_uncertain: true, rationale: 'security rally vs fatigue', confidence: 0.3 },
  { scope: 'region', value: 'fire-west', competitiveOnly: true, margin_delta: -20, sigma_add: 9, rationale: 'no analog tag', confidence: 0.4 },
  { scope: 'region', value: 'fire-west', margin_delta: -9, sigma_add: 4, analog: 'disaster-penalty', rationale: 'wildfire', confidence: 0.4 },
]);
const mockAsk = async ({ validate }) => { const v = validate(MOCK); return v.valid ? v.value : null; };
(async () => {
  const { effects, error } = await est.estimateEffects({ description: 'Iran war hot on election day', races, ask: mockAsk });
  ok(!error && effects.length === 3, 'all three effects survive validation');
  const nat = effects.find((e) => e.selector.scope === 'national');
  ok(nat && nat.margin_delta === -5 && nat.analog === 'rally-round-flag' && nat.capped === true, '⭐the rally national effect is bounded to −5 (not −8), tagged rally-round-flag, capped');
  const fw = effects.find((e) => e.selector.scope === 'region' && e.margin_delta === -8);
  ok(fw && fw.analog === 'generic' && fw.capped === true, '⭐an untagged effect falls back to generic (−20 → −8)');
  const dis = effects.find((e) => e.analog === 'disaster-penalty');
  ok(dis && dis.margin_delta === -5, 'a disaster effect at −9 is capped to the disaster ceiling (−5)');

  // the whole scenario still runs through the engine with the grounded magnitudes
  const built = await est.buildScenarioFromDescription({ description: 'Iran war hot on election day', races, ask: mockAsk });
  ok(built.scenario && built.scenario.effects.length === 3 && built.scenario.effects.every((e) => Math.abs(e.margin_delta) <= 8), 'the built scenario carries only analog-bounded magnitudes (all |Δ| ≤ 8)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
