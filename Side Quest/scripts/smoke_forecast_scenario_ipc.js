/* Smoke: the forecast:scenario IPC handler LOGIC end-to-end (Slice 3 drawer). Replicates main.js's handler
 * (catalog/estimate → scenario_engine.runScenario → payload) against the real libs + a fake lastForecast, and
 * asserts the payload shape is EXACTLY what renderer/forecast.js consumes. Pure (no electron/sqlite).
 *   node scripts/smoke_forecast_scenario_ipc.js
 */
'use strict';
const engine = require('../lib/scenario_engine');
const catalog = require('../lib/scenario_catalog');
const estimate = require('../lib/scenario_estimate');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// a fake lastForecast.work.inputs — a live-ish slate across the zones the catalog selects on
const races = [
  { id: 'CA-01:us-representative', chamber: 'house', state: 'CA', geo: 'CA-01', margin: 2, sigma: 4 },
  { id: 'NV-03:us-representative', chamber: 'house', state: 'NV', geo: 'NV-03', margin: 0.5, sigma: 5 },
  { id: 'AZ-06:us-representative', chamber: 'house', state: 'AZ', geo: 'AZ-06', margin: -3, sigma: 5 },
  { id: 'PA-08:us-representative', chamber: 'house', state: 'PA', geo: 'PA-08', margin: 1, sigma: 5 },
  { id: 'OH-13:us-representative', chamber: 'house', state: 'OH', geo: 'OH-13', margin: -2, sigma: 5 },
  { id: 'TX-15:us-representative', chamber: 'house', state: 'TX', geo: 'TX-15', margin: -8, sigma: 4 },
  { id: 'AZ:us-senator', chamber: 'senate', state: 'AZ', geo: 'AZ', margin: 1, sigma: 5 },
  { id: 'PA:us-senator', chamber: 'senate', state: 'PA', geo: 'PA', margin: 2, sigma: 5 },
];
// no majority override → simulate uses a strict majority of THIS small test chamber (the real forecast passes
// real majorities over 435/100 seats; here we just need a non-degenerate P(control) to see the delta move).
const config = { seed: 2026, iterations: 3000, nationalSigma: 3 };
const lastForecast = { ok: true, work: { inputs: { races, config } } };

// EXACT replica of the main.js forecast:scenario handler body (kept in lockstep — see main.js).
async function handleScenario(opts = {}, ask = null) {
  const fcInputs = (((lastForecast || {}).work || {}).inputs) || {};
  const r = fcInputs.races || [];
  if (!lastForecast || !lastForecast.ok || !r.length) return { ok: false, error: 'no baseline forecast yet' };
  let scn = opts.id ? catalog.get(opts.id) : null;
  let estimated = false;
  if (!scn) {
    const desc = String(opts.description || '').trim();
    if (desc.length < 8) return { ok: false, error: 'pick a catalog scenario or describe a what-if in a phrase' };
    const est = await estimate.buildScenarioFromDescription({ description: desc, races: r, ask });
    if (!est.scenario) return { ok: false, error: `couldn't estimate that what-if (${est.error || 'no effects'})` };
    scn = est.scenario; estimated = true;
  }
  const cfg = { ...(fcInputs.config || {}), ...(opts.seed != null ? { seed: opts.seed } : {}) };
  const run = engine.runScenario(r, scn, cfg);
  const meta = { id: scn.id, name: scn.name, description: scn.description, estimated, two_sided: run.two_sided,
    effects: scn.effects.map((e) => ({ scope: e.selector.scope, value: e.selector.value, competitiveOnly: e.selector.competitiveOnly, margin_delta: e.margin_delta, sigma_add: e.sigma_add, correlated: !!(e.correlation && e.correlation.key), direction_uncertain: e.direction_uncertain, analog: e.analog || null, capped: !!e.capped, rationale: e.rationale, confidence: e.confidence })) };
  if (run.two_sided) return { ok: true, scenario: meta, two_sided: true, positive: { delta: run.positive.delta }, negative: { delta: run.negative.delta } };
  return { ok: true, scenario: meta, two_sided: false, delta: run.delta };
}

(async () => {
  console.log('scenario-list:');
  const list = catalog.list();
  ok(list.length >= 3 && list.every((s) => s.id && s.name), 'forecast:scenario-list returns the catalog (id+name) the picker renders');

  console.log('catalog run (one-sided) → renderer-shaped payload:');
  const r1 = await handleScenario({ id: 'wildfire-brownouts' });
  ok(r1.ok && r1.two_sided === false, 'wildfire runs one-sided, ok:true');
  // the exact fields renderer/forecast.js chamberDeltaEl reads:
  const h = r1.delta && r1.delta.chambers && r1.delta.chambers.house;
  ok(h && typeof h.base_pA_control === 'number' && typeof h.scn_pA_control === 'number' && typeof h.dP_control === 'number', '⭐delta.chambers.house has {base_pA_control, scn_pA_control, dP_control} — the fields the drawer renders');
  ok(h.dP_control < 0, 'wildfire lowers P(Dem House) — the delta is directionally right');
  ok(Array.isArray(r1.delta.flips) && r1.delta.flips.every((f) => f.id && f.toward), '⭐delta.flips each carry {id, toward} — the fields the flip chips render');
  ok(r1.scenario && r1.scenario.name && Array.isArray(r1.scenario.effects) && r1.scenario.effects[0].scope, '⭐scenario.effects each carry {scope,...} — the glass-box "what it applied" list');

  console.log('catalog run (two-sided) → range payload:');
  const r2 = await handleScenario({ id: 'iran-war-hot' });
  ok(r2.ok && r2.two_sided === true && r2.positive && r2.negative, 'iran-war runs two-sided → positive + negative deltas (the RANGE the drawer shows)');
  ok(r2.positive.delta.chambers.house && r2.negative.delta.chambers.house, 'both signs carry house chamber deltas for the range render');

  console.log('typed what-if → estimator path (mocked ask):');
  const MOCK = JSON.stringify([{ scope: 'region', value: 'fire-west', competitiveOnly: true, margin_delta: -3, sigma_add: 2, analog: 'disaster-penalty', rationale: 'west', confidence: 0.4 }]);
  const mockAsk = async ({ validate }) => { const v = validate(MOCK); return v.valid ? v.value : null; };
  const r3 = await handleScenario({ description: 'A western wildfire crisis late in the cycle' }, mockAsk);
  ok(r3.ok && r3.scenario.estimated === true && r3.delta.chambers.house, 'a typed description is estimated on the fly and runs → estimated:true payload');
  ok(r3.scenario.effects[0].analog === 'disaster-penalty' && 'capped' in r3.scenario.effects[0], '⭐Slice 4: the effect carries its {analog, capped} through to the drawer glass-box');

  console.log('honesty + guards:');
  const r4 = await handleScenario({ description: 'x' });
  ok(r4.ok === false && /describe/.test(r4.error), 'too-short description is refused honestly');
  const savedRaces = lastForecast.work.inputs.races.length;
  ok(savedRaces === races.length && lastForecast.work.inputs.races[0].margin === 2, '⭐baseline lastForecast is UNCHANGED — the run never mutates the live slate');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
