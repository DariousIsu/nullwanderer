/* Smoke: lib/api_landing — changed API snapshots → memory documents (the processed→DB path, like news).
 * Seeds snapshots into an isolated store; lands with a mock landDoc. Proves FRED formatting, idempotency
 * (unchanged → not re-landed), and re-land on change. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_api_landing.js */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `sq_apiland_${process.pid}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.API_DB_PATH = tmp;

const store = require('../lib/api_store');
const landing = require('../lib/api_landing');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const T = 1_760_000_000_000;

// FRED-shaped body: GDP jumped 100 → 110 (+10%).
const gdpBody = { observations: [{ date: '2025-10-01', value: '100' }, { date: '2026-01-01', value: '110' }] };

(async () => {
  // ===== pure formatter =====
  const ds = require('../lib/api_stream').getDataset('fred:gdp');
  const doc = landing.formatSnapshot(ds, { body: gdpBody, fetched_ts: T });
  ok(doc && /US GDP/.test(doc.title) && /= 110/.test(doc.body) && /\+10\.00%/.test(doc.body), 'FRED formatter: latest value + prior + % change');
  ok(landing.genericSummary({ id: 'x', api: 'census', label: 'X' }, { body: [1, 2, 3], fetched_ts: T }).body.includes('3 rows'), 'generic fallback summarizes a non-FRED payload');

  // ===== landChanged: lands a changed snapshot once, idempotent thereafter =====
  store.putSnapshot('fred:gdp', { apiId: 'fred', path: 'series/observations', params: ds.params, body: gdpBody, ok: true, status: 200, now: T });
  const landedDocs = [];
  const landDoc = async (d) => { landedDocs.push(d); return { landed: true }; };

  const r1 = await landing.landChanged({ landDoc, now: T });
  ok(r1.landed === 1 && landedDocs.length === 1, 'landChanged: a new snapshot lands one document');
  ok(landedDocs[0].source === 'api' && landedDocs[0].ref === 'api:snapshot:fred:gdp' && /US GDP/.test(landedDocs[0].title), 'landed doc: source=api + stable per-dataset ref + readable title');

  const r2 = await landing.landChanged({ landDoc, now: T + 1000 });
  ok(r2.landed === 0 && landedDocs.length === 1, 'idempotent: an unchanged snapshot is NOT re-landed (monthly series not re-processed)');

  // ===== content changes → re-lands =====
  const gdpBody2 = { observations: gdpBody.observations.concat([{ date: '2026-04-01', value: '112' }]) };
  store.putSnapshot('fred:gdp', { apiId: 'fred', path: 'series/observations', params: ds.params, body: gdpBody2, ok: true, status: 200, now: T + 2000 });
  const r3 = await landing.landChanged({ landDoc, now: T + 3000 });
  ok(r3.landed === 1 && landedDocs.length === 2 && /= 112/.test(landedDocs[1].body), 'a CHANGED snapshot re-lands (new value processed)');

  // ===== unknown dataset is marked (won't loop) =====
  store.putSnapshot('mystery:zzz', { apiId: 'nope', body: { x: 1 }, ok: true, now: T + 4000 });
  const r4 = await landing.landChanged({ landDoc, now: T + 5000 });
  ok(r4.skipped >= 1 && store.unlandedChanged().every((s) => s.datasetId !== 'mystery:zzz'), 'unknown dataset is marked landed (skipped, does not re-loop)');

  try { store.close(); fs.unlinkSync(tmp); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
