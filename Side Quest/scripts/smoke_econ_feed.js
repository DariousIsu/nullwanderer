/**
 * Offline smoke for lib/econ_feed.js — the api_stream⇄forecast CONTRACT. Pure parsing/derivation over a fake
 * FRED body + the live wrappers with an injected getSnapshot (no network / no DB). Run: node scripts/smoke_econ_feed.js
 */
const E = require('../lib/econ_feed');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

// FRED body: out-of-order, a '.' missing row, spans >1yr; latest 2026-06 = 110, 1yr ago = 100, 90d ago = 105.
const gdpBody = { observations: [
  { date: '2025-06-01', value: '100' },
  { date: '2026-06-01', value: '110' },
  { date: '2026-03-01', value: '105' },
  { date: '2026-01-01', value: '.' },        // FRED missing → dropped
  { date: '2025-01-01', value: '96' },
] };

const s = E.seriesFrom(gdpBody);
ok('seriesFrom drops missing + sorts ascending', s.length === 4 && s[0].date === '2025-01-01' && s[s.length - 1].date === '2026-06-01', JSON.stringify(s.map((x) => x.date)));
ok('seriesFrom coerces values to numbers', s.every((x) => typeof x.value === 'number'));
ok('latest returns the newest obs', E.latest(s).value === 110);

const yoy = E.changeOver(s, 365);
ok('changeOver 365d → +10 abs / +10%', yoy && yoy.abs === 10 && yoy.pct === 10, JSON.stringify(yoy));
const tr = E.changeOver(s, 90);
ok('changeOver 90d → +5 abs (trend)', tr && tr.abs === 5, JSON.stringify(tr));

const ind = E.indicatorFrom('fred:gdp', gdpBody, { label: 'GDP' });
ok('indicatorFrom: value/asOf/yoy/trend/direction', ind.value === 110 && ind.asOf === '2026-06-01' && ind.yoyPct === 10 && ind.trendAbs === 5 && ind.direction === 'up' && ind.n === 4, JSON.stringify(ind));
ok('indicatorFrom on null body → null fields, no throw', E.indicatorFrom('fred:x', null).value === null);

// live wrappers with an injected getSnapshot (keyed bodies)
const bodies = {
  'fred:gdp': gdpBody,
  'fred:unrate': { observations: [{ date: '2025-06-01', value: '4.0' }, { date: '2026-03-01', value: '4.1' }, { date: '2026-06-01', value: '4.2' }] },
};
const getSnapshot = (id) => (bodies[id] ? { datasetId: id, body: bodies[id], ok: true } : null);

const env = E.environment({ getSnapshot });
ok('environment returns the compact macro keys', 'gdp' in env && 'cpi' in env && 'unrate' in env && 'fedfunds' in env && 'dgs10' in env);
ok('environment: gdp populated from snapshot', env.gdp.value === 110 && env.gdp.yoyPct === 10);
ok('environment: unrate populated, missing series → null value', env.unrate.value === 4.2 && env.cpi.value === null);
ok('environment: no getSnapshot → all-null, no throw', E.environment({}).gdp.value === null);

const list = E.indicators({ getSnapshot });
ok('indicators: array over the macro set', Array.isArray(list) && list.length === E.FRED_SET.length && list.find((i) => i.id === 'fred:gdp').value === 110);
ok('indicators: no getSnapshot → []', E.indicators({}).length === 0);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
