/* Smoke: lib/scenario_engine + lib/regions — Slice 0 of the Conditional Scenario Engine
 * (docs/SCENARIO_ENGINE_DESIGN.md §8). THE PROOFS, all OFFLINE with HAND-WRITTEN effects (no cloud):
 *   • regions map resolves census regions + named thematic zones;
 *   • a selector matches exactly the right seats (national/state/region/seatType + competitiveOnly);
 *   • applyScenario is PURE (baseline slate never mutated) and applies margin_delta/sigma_add + intensity;
 *   • the WILDFIRE worked example (§9): only fire-west competitive seats move, the right seats FLIP;
 *   • runScenario's baseline+scenario share a seed → the delta is the SHOCK not noise (determinism);
 *   • the two-sided honesty rail: a direction_uncertain shock runs BOTH signs → a RANGE straddling zero.
 *   node scripts/smoke_scenario_engine.js
 */
'use strict';
const regions = require('../lib/regions');
const E = require('../lib/scenario_engine');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- fixture slate: margin = Dem lead (points, + = Dem). geo drives state; a few western competitive seats. ---
const baseRaces = [
  { id: 'CA-01:us-representative', chamber: 'house', state: 'CA', geo: 'CA-01', margin: 2,   sigma: 4 },  // West, competitive, Dem-lean
  { id: 'OR-05:us-representative', chamber: 'house', state: 'OR', geo: 'OR-05', margin: -1,  sigma: 4 },  // West, competitive, Rep-lean
  { id: 'NV-03:us-representative', chamber: 'house', state: 'NV', geo: 'NV-03', margin: 0.5, sigma: 5 },  // West, competitive
  { id: 'AZ-06:us-representative', chamber: 'house', state: 'AZ', geo: 'AZ-06', margin: -3,  sigma: 5 },  // West, competitive, Rep-lean
  { id: 'TX-15:us-representative', chamber: 'house', state: 'TX', geo: 'TX-15', margin: -8,  sigma: 4 },  // South, NOT competitive
  { id: 'NY-04:us-representative', chamber: 'house', state: 'NY', geo: 'NY-04', margin: 6,   sigma: 4 },  // Northeast, borderline
  { id: 'OH-13:us-representative', chamber: 'house', state: 'OH', geo: 'OH-13', margin: -2,  sigma: 5 },  // Midwest, competitive
  { id: 'FL-27:us-representative', chamber: 'house', state: 'FL', geo: 'FL-27', margin: -4,  sigma: 5 },  // South, competitive
  { id: 'AZ:us-senator',          chamber: 'senate', state: 'AZ', geo: 'AZ',    margin: 1,   sigma: 5 },  // West, competitive
  { id: 'NV:us-senator',          chamber: 'senate', state: 'NV', geo: 'NV',    margin: -0.5,sigma: 5 },  // West, competitive
  { id: 'OH:us-senator',          chamber: 'senate', state: 'OH', geo: 'OH',    margin: -5,  sigma: 5 },  // Midwest
  { id: 'PA:us-senator',          chamber: 'senate', state: 'PA', geo: 'PA',    margin: 2,   sigma: 5 },  // Northeast
];
const SIM = { seed: 7, iterations: 4000, nationalSigma: 3 };

console.log('regions:');
ok(regions.regionOf('CA') === 'West' && regions.regionOf('OH') === 'Midwest' && regions.regionOf('NY') === 'Northeast' && regions.regionOf('TX') === 'South', 'regionOf maps states to the 4 Census regions');
ok(regions.regionOf('ZZ') === null, 'an unknown abbr has no region (null, not a throw)');
ok(regions.statesIn('fire-west').has('OR') && regions.statesIn('fire-west').has('CA') && !regions.statesIn('fire-west').has('OH'), 'statesIn resolves a named zone (fire-west)');
ok(regions.statesIn('West').has('AZ') && regions.statesIn('west').has('AZ'), 'statesIn resolves a Census region, case-insensitively');

console.log('selectors:');
const nat = baseRaces.filter((r) => E.matchesSelector(r, { scope: 'national' }));
ok(nat.length === baseRaces.length, 'national scope matches every seat');
const sen = baseRaces.filter((r) => E.matchesSelector(r, { scope: 'seatType', value: 'senate' }));
ok(sen.length === 4, 'seatType=senate matches the 4 senate seats');
const ca = baseRaces.filter((r) => E.matchesSelector(r, { scope: 'state', value: 'CA' }));
ok(ca.length === 1 && ca[0].id.startsWith('CA-01'), 'state=CA matches only the CA seat');
const fw = baseRaces.filter((r) => E.matchesSelector(r, { scope: 'region', value: 'fire-west', competitiveOnly: true }));
ok(fw.length === 6, 'region=fire-west + competitiveOnly matches the 6 competitive western seats');
const fwAll = baseRaces.filter((r) => E.matchesSelector(r, { scope: 'region', value: 'fire-west' }));
ok(fwAll.length === 6, 'all 6 western seats are competitive here (|margin| ≤ 6) → competitiveOnly is a no-op for this slate');

console.log('applyScenario (pure math + isolation):');
// The WILDFIRE scenario (§9): western competitive seats punished toward Rep (−4), volatility up (+2σ).
const wildfire = E.makeScenario({
  id: 'wildfire-brownouts', name: 'Wildfire brownouts break through the heat',
  description: 'Grid strain + wildfire across the west; incumbent-party punished in competitive western seats.',
  effects: [{ selector: { scope: 'region', value: 'fire-west', competitiveOnly: true }, margin_delta: -4, sigma_add: 2, rationale: 'competence/incumbent penalty', confidence: 0.4 }],
});
const applied = E.applyScenario(baseRaces, wildfire);
const byId = (arr, id) => arr.find((r) => r.id === id);
ok(approx(byId(applied, 'CA-01:us-representative').margin, -2), 'CA-01 margin +2 → −2 (−4 shock applied)');
ok(approx(byId(applied, 'CA-01:us-representative').sigma, 6), 'CA-01 sigma 4 → 6 (+2 sigma_add)');
ok(byId(applied, 'TX-15:us-representative').margin === -8 && !byId(applied, 'TX-15:us-representative')._scenario, 'TX-15 (South, off-zone) is untouched — no _scenario stamp');
ok(byId(applied, 'OH-13:us-representative').margin === -2, 'OH-13 (Midwest, off-zone) untouched even though competitive');
ok(applied.filter((r) => r._scenario).length === 6, 'exactly the 6 western competitive seats carry a _scenario stamp');
ok(byId(baseRaces, 'CA-01:us-representative').margin === 2 && byId(baseRaces, 'CA-01:us-representative').sigma === 4, '⭐ISOLATION: the baseline slate is UNMUTATED after applyScenario');

// intensity scales magnitude: 0.5 → half the shock.
const halfFire = E.makeScenario({ ...wildfire, intensity: 0.5, effects: wildfire.effects });
const appliedHalf = E.applyScenario(baseRaces, halfFire);
ok(approx(byId(appliedHalf, 'CA-01:us-representative').margin, 0), 'intensity 0.5 halves the shock: CA-01 +2 → 0');

console.log('runScenario (comparative sim + delta):');
const run = E.runScenario(baseRaces, wildfire, SIM);
ok(run.status === 'hypothetical' && run.two_sided === false, 'a run is labeled hypothetical, one-sided (no ambiguous effect)');
ok(run.delta.chambers.house.dP_control < 0 && run.delta.chambers.senate.dP_control < 0, '⭐a Rep-ward western shock LOWERS P(Dem control) in both chambers (Δ < 0)');
const flipIds = run.delta.flips.map((f) => f.id).sort();
ok(JSON.stringify(flipIds) === JSON.stringify(['AZ:us-senator', 'CA-01:us-representative', 'NV-03:us-representative']), '⭐the 3 point-estimate seats that cross zero are exactly CA-01, NV-03, AZ-Sen');
ok(run.delta.flips.every((f) => f.toward === 'B/Rep'), 'every flip is toward B/Rep (the shock direction)');
ok(run.delta.flips.every((f) => (f.before_pA > 0.5) === false ? true : f.after_pA < f.before_pA), 'flipped seats lose Dem win-probability');

console.log('determinism (same seed → identical baseline):');
const run2 = E.runScenario(baseRaces, wildfire, SIM);
ok(run.base.chambers.house.pA_control === run2.base.chambers.house.pA_control, 'the baseline sim is reproducible across runs (seeded)');
ok(run.base.chambers.house.pA_control !== run.sim.chambers.house.pA_control, 'baseline ≠ scenario sim (the shock moved the world, same seed)');

console.log('two-sided honesty rail (direction_uncertain → a RANGE):');
const iran = E.makeScenario({
  id: 'iran-war-hot', name: 'Iran war hot during voting',
  description: 'A national security shock of genuinely ambiguous partisan direction (rally vs. fatigue).',
  effects: [{ selector: { scope: 'national' }, margin_delta: 3, sigma_add: 2, direction_uncertain: true, rationale: 'rally-round-flag vs war-fatigue', confidence: 0.3 }],
});
const two = E.runScenario(baseRaces, iran, SIM);
ok(two.two_sided === true && two.positive && two.negative, 'an ambiguous shock runs BOTH signs (two-sided result)');
ok(two.positive.delta.chambers.house.dP_control > 0 && two.negative.delta.chambers.house.dP_control < 0, '⭐the two signs straddle zero — read as a RANGE, never one confident number');
ok(approx(byId(two.positive.applied, 'OH-13:us-representative').margin, 1) && approx(byId(two.negative.applied, 'OH-13:us-representative').margin, -5), 'the two signs are ±the same magnitude (OH-13: −2±3 → +1 / −5)');

console.log('waterfall (stacked futures — cumulative delta compounds):');
// Stack the western wildfire (Rep-ward, fire-west competitive) THEN a national Rep-ward shock. Each stage's
// cumulative delta should push P(Dem) further down, and a western competitive seat carries BOTH deltas.
const nationalRep = E.makeScenario({ id: 'national-rep-drift', name: 'National Rep drift', description: 'A uniform Rep-ward shift in competitive seats.', effects: [{ selector: { scope: 'national', competitiveOnly: true }, margin_delta: -2, sigma_add: 0, rationale: 'uniform drift', confidence: 0.4 }] });
const wf = E.runScenario ? E.runWaterfall(baseRaces, [wildfire, nationalRep], SIM) : null;
ok(wf && wf.stages.length === 2, 'runWaterfall emits one stage per stacked scenario');
ok(wf.stages[0].cumulativeDelta.chambers.house.dP_control < 0 && wf.stages[1].cumulativeDelta.chambers.house.dP_control < wf.stages[0].cumulativeDelta.chambers.house.dP_control, '⭐each stacked shock compounds — stage 2 lowers P(Dem House) further than stage 1');
const wfCA = wf.stages[1].applied.find((r) => r.id === 'CA-01:us-representative');
ok(approx(wfCA.margin, 2 - 4 - 2), '⭐a western competitive seat carries BOTH stacked shocks (CA-01: +2 −4 −2 = −4)');
ok(byId(baseRaces, 'CA-01:us-representative').margin === 2, 'ISOLATION holds through a waterfall — the baseline slate is still unmutated');

console.log('correlation (a regional shock swings its seats TOGETHER — fatter tails):');
// 6 western house toss-ups. Compare a PURE-correlation shock (a shared fire-west swing, no margin shift) vs.
// the SAME volatility applied INDEPENDENTLY per seat. Correlated → the seats flip together → a much wider
// seat-count distribution, the load-bearing property of correlation (design §5).
const westRaces = ['CA', 'OR', 'WA', 'AZ', 'NV', 'CA'].map((st, i) => ({ id: `${st}-1${i}:us-representative`, chamber: 'house', state: st, geo: `${st}-1${i}`, margin: 0, sigma: 5 }));
const corrScn = E.makeScenario({ id: 'fw-corr', name: 'fire-west correlated', description: 'a shared western swing', effects: [{ selector: { scope: 'region', value: 'fire-west' }, margin_delta: 0, sigma_add: 0, correlation: { key: 'fire-west', sigma: 6 }, rationale: 'shared', confidence: 0.4 }] });
const indScn = E.makeScenario({ id: 'fw-ind', name: 'fire-west independent', description: 'independent western volatility', effects: [{ selector: { scope: 'region', value: 'fire-west' }, margin_delta: 0, sigma_add: 6, rationale: 'independent', confidence: 0.4 }] });
const CSIM = { seed: 3, iterations: 6000, nationalSigma: 0.01 };
const rc = E.runScenario(westRaces, corrScn, CSIM);
const ri = E.runScenario(westRaces, indScn, CSIM);
ok(rc.applied.every((r) => r.region === 'fire-west'), 'applyScenario tags the whole cohort with r.region = the correlation key');
ok(westRaces[0].region === undefined, 'ISOLATION: the correlation tag lives on the applied slate, never the baseline');
ok(rc.sim.chambers.house.seatsA_sd > ri.sim.chambers.house.seatsA_sd * 1.4, `⭐correlation FATTENS the tail — shared-swing seat SD ${rc.sim.chambers.house.seatsA_sd} ≫ independent ${ri.sim.chambers.house.seatsA_sd}`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
