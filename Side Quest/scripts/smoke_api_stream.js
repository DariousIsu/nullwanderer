/* Smoke: lib/api_store + lib/api_stream — persistent snapshots, conservative pulling, change detection, and
 * the raw hooks (getSnapshot / dueDatasets / runDue), with an injected pull + clock (no network). Isolated
 * API_DB_PATH. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_api_stream.js */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `sq_apistream_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.API_DB_PATH = tmp;

const store = require('../lib/api_store');
const stream = require('../lib/api_stream');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const T = 1_760_000_000_000;
const H = 3_600_000, D = 86_400_000;

(async () => {
  // A counting mock caller — stands in for api_manager.managedCall. Returns whatever payload we set.
  let calls = 0, payload = { series: 'v1' };
  const mock = async (apiId, path, opts) => { calls++; return { ok: true, status: 200, data: payload }; };

  ok(stream.datasets().length >= 6 && stream.getDataset('fred:gdp').cadenceMs === 12 * H, 'dataset registry loaded (fred:gdp cadence 12h)');
  ok(stream.getDataset('nope') === null, 'unknown dataset → null');

  // ===== first refresh persists a snapshot =====
  const r1 = await stream.refreshDataset('fred:gdp', { now: T, call: mock });
  ok(r1.fetched === true && r1.changed === true && calls === 1, 'first refresh pulls + persists (changed=true)');
  const snap = stream.getSnapshot('fred:gdp');
  ok(snap && snap.body.series === 'v1' && snap.apiId === 'fred', 'getSnapshot (raw hook) returns the persisted snapshot — no network');

  // ===== conservative: within cadence → no-op (this is the "months to update, poll rarely" behavior) =====
  const r2 = await stream.refreshDataset('fred:gdp', { now: T + H, call: mock });   // 1h later, cadence is 12h
  ok(r2.fetched === false && r2.skipped === 'within-cadence' && calls === 1, 'within cadence → refresh no-ops (no extra API call)');

  // ===== change detection =====
  const r3 = await stream.refreshDataset('fred:gdp', { now: T + 13 * H, call: mock });   // past cadence, same payload
  ok(r3.fetched === true && r3.changed === false && calls === 2, 'past cadence, unchanged payload → fetched but changed=false');
  payload = { series: 'v2' };
  const r4 = await stream.refreshDataset('fred:gdp', { now: T + 26 * H, call: mock });   // past cadence, new payload
  ok(r4.fetched === true && r4.changed === true, 'new payload → changed=true (the landing trigger)');
  ok(store.changedSince(T + 20 * H).some((c) => c.dataset_id === 'fred:gdp'), 'store.changedSince surfaces the changed dataset for the DB-landing pass');

  // ===== force overrides cadence =====
  calls = 0;
  const rf = await stream.refreshDataset('fred:gdp', { now: T + 26 * H + 1000, force: true, call: mock });
  ok(rf.fetched === true && calls === 1, 'force:true refreshes even within cadence');

  // ===== due scheduler =====
  const dueNow = stream.dueDatasets({ now: T + 26 * H });
  ok(!dueNow.includes('fred:gdp') && dueNow.length >= 4, 'dueDatasets excludes the fresh one, includes the never-pulled ones');
  const runFar = await stream.runDue({ now: T + 40 * D, call: mock, limit: 100 });
  ok(runFar.due >= 5 && runFar.refreshed >= 5, 'runDue refreshes everything past its cadence (far-future clock)');

  // ===== error is fail-soft (keeps the old snapshot) =====
  const errMock = async () => ({ ok: false, status: 500, error: 'upstream 500' });
  const re = await stream.refreshDataset('fred:cpi', { now: T + 41 * D, force: true, call: errMock });
  ok(re.fetched === false && /upstream 500/.test(re.error), 'a failed pull is fail-soft (error surfaced, no bad snapshot written)');

  try { store.close(); fs.unlinkSync(tmp); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
