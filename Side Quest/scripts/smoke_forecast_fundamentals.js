/**
 * Offline smoke for lib/forecast_fundamentals.js — the FUNDAMENTALS leg (national economic environment → a
 * capped, audited uniform swing). Pure scoring + apply, plus live assess with an injected getSnapshot.
 * Run: node scripts/smoke_forecast_fundamentals.js
 */
const F = require('../lib/forecast_fundamentals');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

const ind = (o) => ({ value: null, yoyPct: null, trendAbs: null, direction: null, ...o });

// STRONG economy: high growth, low inflation, low + falling unemployment → helps incumbent (default B=Rep).
const strong = { gdp: ind({ yoyPct: 6 }), cpi: ind({ yoyPct: 2 }), unrate: ind({ value: 3.5, trendAbs: -0.2 }), fedfunds: ind({ value: 3.5 }), dgs10: ind({ trendAbs: -0.1 }) };
const sStrong = F.scoreEnvironment(strong);
ok('strong economy → favors incumbent B, lean negative (toward B)', sStrong.favors === 'B' && sStrong.lean < 0, JSON.stringify({ lean: sStrong.lean, favors: sStrong.favors }));
ok('strong economy → components audited', sStrong.components.length >= 4 && sStrong.has_data && sStrong.provisional);

// WEAK economy: stagnant growth, high inflation, high + rising unemployment → helps challenger (A=Dem).
const weak = { gdp: ind({ yoyPct: 0 }), cpi: ind({ yoyPct: 7 }), unrate: ind({ value: 7, trendAbs: 0.5 }), fedfunds: ind({ value: 6 }), dgs10: ind({ trendAbs: 0.4 }) };
const sWeak = F.scoreEnvironment(weak);
ok('weak economy → favors challenger A, lean positive (toward A)', sWeak.favors === 'A' && sWeak.lean > 0, JSON.stringify({ lean: sWeak.lean, favors: sWeak.favors }));
ok('lean is hard-capped at envCap (3) — no runaway', sWeak.lean === F.DEFAULTS.envCap && Math.abs(sWeak.lean) <= F.DEFAULTS.envCap, `lean ${sWeak.lean}`);
ok('per-component cap holds', sWeak.components.every((c) => Math.abs(c.points_incumbent) <= F.DEFAULTS.perComponentCap));

// incumbent-party flip: same strong economy, but if the incumbent were party A, the lean sign flips.
const flip = F.scoreEnvironment(strong, { incumbentParty: 'A' });
ok('incumbentParty flip inverts the lean sign', Math.sign(flip.lean) === -Math.sign(sStrong.lean) && flip.favors === 'A');

// neutral / no data
ok('empty environment → no data, lean 0, neutral', (() => { const z = F.scoreEnvironment({}); return z.has_data === false && z.lean === 0 && z.favors === 'neutral'; })());

// applyToSlate — uniform shift + audit trail
const races = [
  { id: 'AZ:sen', chamber: 'senate', margin: 2, sigma: 5 },
  { id: 'NH-02:hou', chamber: 'house', margin: -1, sigma: 5 },
];
const applied = F.applyToSlate(races, sWeak);
ok('applyToSlate shifts every race by the lean, uniformly', applied[0].margin === Number((2 + sWeak.lean).toFixed(3)) && applied[1].margin === Number((-1 + sWeak.lean).toFixed(3)));
ok('applyToSlate records env_delta + base_margin_pre_env (audit)', applied[0].env_delta === sWeak.lean && applied[0].base_margin_pre_env === 2);
const noShift = F.applyToSlate(races, F.scoreEnvironment({}));
ok('applyToSlate with lean 0 → margins untouched, env_delta 0', noShift[0].margin === 2 && noShift[0].env_delta === 0);

// live assess with an injected getSnapshot (weak-economy bodies → favors A)
const bodies = {
  'fred:gdp': { observations: [{ date: '2025-06-01', value: '100' }, { date: '2026-06-01', value: '100' }] },      // 0% growth
  'fred:cpi': { observations: [{ date: '2025-06-01', value: '100' }, { date: '2026-06-01', value: '107' }] },      // +7% inflation
  'fred:unrate': { observations: [{ date: '2025-06-01', value: '6.5' }, { date: '2026-03-01', value: '6.7' }, { date: '2026-06-01', value: '7.0' }] },
  'fred:dgs10': { observations: [{ date: '2026-03-01', value: '4.1' }, { date: '2026-06-01', value: '4.5' }] },
};
const getSnapshot = (id) => (bodies[id] ? { body: bodies[id] } : null);
const live = F.assess({ getSnapshot });
ok('live assess (via econ_feed getSnapshot) → weak economy favors A', live.has_data && live.favors === 'A' && live.lean > 0, JSON.stringify({ lean: live.lean, favors: live.favors }));
ok('live assess fail-soft: no getSnapshot → lean 0', F.assess({}).lean === 0 && F.assess({}).has_data === false);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
