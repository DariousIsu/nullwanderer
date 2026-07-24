/* Smoke: the SCENARIO WORK-MOVE (F3's other half) — the decider can ELECT to run a hypothetical what-if
 * against the live forecast. OFFLINE proofs (no cloud, no db):
 *   • the hand-authored catalog resolves, and each entry runs through the Slice-0 engine;
 *   • the readout is LABELED HYPOTHETICAL and honest (two-sided shocks show a RANGE);
 *   • "scenario" is a valid decider move (validateDecision), needs a target;
 *   • buildManifest OFFERS the move only when the floor has elapsed (last_scenario_run_at), and lists the
 *     runnable ids — the floor keeps it occasional.
 *   node scripts/smoke_scenario_workmove.js
 */
'use strict';
const catalog = require('../lib/scenario_catalog');
const engine = require('../lib/scenario_engine');
const autonomy = require('../lib/autonomy');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// A compact live-ish slate covering the zones the catalog selects on (fire-west, rust-belt) + national.
const races = [
  { id: 'CA-01:us-representative', chamber: 'house', state: 'CA', geo: 'CA-01', margin: 2, sigma: 4 },
  { id: 'NV-03:us-representative', chamber: 'house', state: 'NV', geo: 'NV-03', margin: 0.5, sigma: 5 },
  { id: 'AZ-06:us-representative', chamber: 'house', state: 'AZ', geo: 'AZ-06', margin: -3, sigma: 5 },
  { id: 'OH-13:us-representative', chamber: 'house', state: 'OH', geo: 'OH-13', margin: -2, sigma: 5 },
  { id: 'PA-08:us-representative', chamber: 'house', state: 'PA', geo: 'PA-08', margin: 1, sigma: 5 },
  { id: 'MI-07:us-representative', chamber: 'house', state: 'MI', geo: 'MI-07', margin: -1, sigma: 5 },
  { id: 'TX-15:us-representative', chamber: 'house', state: 'TX', geo: 'TX-15', margin: -8, sigma: 4 },
  { id: 'AZ:us-senator', chamber: 'senate', state: 'AZ', geo: 'AZ', margin: 1, sigma: 5 },
  { id: 'NV:us-senator', chamber: 'senate', state: 'NV', geo: 'NV', margin: -0.5, sigma: 5 },
  { id: 'PA:us-senator', chamber: 'senate', state: 'PA', geo: 'PA', margin: 2, sigma: 5 },
  { id: 'OH:us-senator', chamber: 'senate', state: 'OH', geo: 'OH', margin: -5, sigma: 5 },
];
const CONFIG = { seed: 11, iterations: 3000, nationalSigma: 3 };

console.log('catalog:');
const cat = catalog.list();
ok(cat.length >= 3 && cat.every((s) => s.id && s.name && s.description), 'list() returns the hand-authored what-ifs (id/name/description)');
ok(!!catalog.get('wildfire-brownouts') && catalog.get('nope') === null, 'get() resolves a known id and is null for an unknown one');
ok(cat.find((s) => s.id === 'iran-war-hot').two_sided === true, 'iran-war-hot is flagged two-sided (ambiguous direction)');

console.log('each catalog scenario runs through the Slice-0 engine + reads out honestly:');
for (const meta of cat) {
  const scn = catalog.get(meta.id);
  const run = engine.runScenario(races, scn, CONFIG);
  const text = catalog.summarize(scn, run);
  ok(run.status === 'hypothetical', `${meta.id}: run is labeled hypothetical`);
  ok(text.startsWith('[Hypothetical — illustrative only, NOT a forecast]'), `${meta.id}: readout is LABELED hypothetical, not asserted as fact`);
  if (meta.two_sided) ok(run.two_sided === true && /RANGE|band/i.test(text), `${meta.id}: two-sided shock reads as a RANGE, never a point`);
}
// The wildfire run should move the west toward Rep (P(Dem) drops) and flip ≥1 competitive western seat.
const wf = engine.runScenario(races, catalog.get('wildfire-brownouts'), CONFIG);
ok(wf.delta.chambers.house.dP_control < 0, 'wildfire (Rep-ward western shock) lowers P(Dem House)');
ok(wf.delta.flips.length >= 1 && wf.delta.flips.every((f) => f.toward === 'B/Rep'), 'wildfire flips ≥1 western seat, all toward Rep');
ok(/Δ P\(Dem House\)/.test(catalog.outcomeLine(catalog.get('wildfire-brownouts'), wf)), 'outcomeLine gives a compact one-line ledger entry');

console.log('decider vocabulary:');
ok(autonomy.MOVES.includes('scenario'), '"scenario" is a valid decider move');
ok(autonomy.DECISION_WANT.includes('scenario'), 'the decision prompt documents the scenario move');
const good = autonomy.validateDecision('{"move":"scenario","target":"wildfire-brownouts","why":"House is tight; a named western shock sharpens what could move it"}');
ok(good.valid && good.value.move === 'scenario' && good.value.target === 'wildfire-brownouts', 'validateDecision accepts a scenario move with a target');
const bad = autonomy.validateDecision('{"move":"scenario","why":"no target"}');
ok(!bad.valid, 'a scenario move with no target is rejected (target required)');

console.log('manifest OFFER is floor-gated:');
const snap = { ok: true, as_of: 'test', work: { sim: { chambers: { house: { pA_control: 0.5, seatsA_mean: 217, seatsA_p10: 210, seatsA_p90: 224, total_seats: 435 } } } } };
const mkDb = (lastAt) => ({ getDb: () => { throw new Error('no db (smoke)'); }, getMeta: (k) => (k === 'last_scenario_run_at' ? lastAt : null) });
const _err = console.error; console.error = () => {};   // silence the expected dropped-section logs from the mock db
const farPast = String(Date.now() - 10 * 3600e3);        // 10h ago → past the 3h floor
const justNow = String(Date.now());                       // now → inside the floor
const mOffered = autonomy.buildManifest({ db: mkDb(farPast), deps: { forecast: () => snap } }).text;
const mFloored = autonomy.buildManifest({ db: mkDb(justNow), deps: { forecast: () => snap } }).text;
console.error = _err;
ok(/move "scenario"/.test(mOffered) && catalog.ids().every((id) => mOffered.includes(id)), 'floor elapsed → the manifest OFFERS the scenario move and lists every runnable id');
ok(/YOUR 2026 FORECAST/.test(mFloored) && !/move "scenario"/.test(mFloored), 'inside the floor → the forecast still shows but the scenario offer is withheld (stays occasional)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
