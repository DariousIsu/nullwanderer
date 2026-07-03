/* Smoke: lib/api_manager — the management layer (rate-limit guard + response cache + usage + health), with an
 * injected callFn + clock (no network). Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_api_manager.js */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `sq_apimgr_${process.pid}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.API_DB_PATH = tmp;   // rate usage + cache are now durable (api_store) → isolated temp DB
const mgr = require('../lib/api_manager');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const T = 1_760_000_000_000;

(async () => {
  // A counting mock caller — stands in for api_client.call.
  let calls = 0;
  const mock = async (apiId, path, opts) => { calls++; return { ok: true, status: 200, data: { apiId, path, n: calls } }; };

  // ===== caching =====
  mgr.resetUsage(); calls = 0;
  const a1 = await mgr.managedCall('fred', 'series/observations', { params: { series_id: 'GDP' }, now: T, callFn: mock });
  const a2 = await mgr.managedCall('fred', 'series/observations', { params: { series_id: 'GDP' }, now: T + 1000, callFn: mock });
  ok(a1.ok && a1.cached !== true && calls === 1, 'first call hits the API');
  ok(a2.cached === true && calls === 1, 'identical call within TTL is served from cache (no second API hit)');
  const a3 = await mgr.managedCall('fred', 'series/observations', { params: { series_id: 'CPI' }, now: T + 1000, callFn: mock });
  ok(a3.cached !== true && calls === 2, 'a DIFFERENT request is not a cache hit');
  const a4 = await mgr.managedCall('fred', 'series/observations', { params: { series_id: 'GDP' }, now: T + 5_000_000_000, callFn: mock });
  ok(a4.cached !== true && calls === 3, 'cache expires after the TTL (fresh fetch)');
  const a5 = await mgr.managedCall('fred', 'series/observations', { params: { series_id: 'GDP' }, now: T, force: true, callFn: mock });
  ok(a5.cached !== true && calls === 4, 'force:true bypasses the cache');

  // ===== rate-limit guard (polygon = 5/min) =====
  mgr.resetUsage(); calls = 0;
  for (let i = 0; i < 5; i++) await mgr.managedCall('polygon', 'v1/x', { now: T, force: true, callFn: mock });
  ok(calls === 5, 'polygon: 5 calls allowed within the minute');
  const blocked = await mgr.managedCall('polygon', 'v1/x', { now: T, force: true, callFn: mock });
  ok(blocked.ok === false && blocked.rateLimited === true && blocked.window === 'perMin' && calls === 5, '6th call in the minute is rate-limited (no API hit)');
  const later = await mgr.managedCall('polygon', 'v1/x', { now: T + 61_000, force: true, callFn: mock });
  ok(later.ok === true && calls === 6, 'after the window rolls, calls resume');

  // ===== usage view =====
  mgr.resetUsage(); calls = 0;
  await mgr.managedCall('alphavantage', 'query', { params: { function: 'X' }, now: T, force: true, callFn: mock });
  await mgr.managedCall('alphavantage', 'query', { params: { function: 'Y' }, now: T, force: true, callFn: mock });
  const u = mgr.usage('alphavantage', { now: T });
  ok(u.used.perMin === 2 && u.used.perDay === 2 && u.limits.perDay === 25, 'usage() reports counts per window + the limits');
  ok(mgr.usage('census', { now: T }).rateLimited === false, 'an unlimited API is never rate-limited');

  // ===== health =====
  mgr.resetUsage(); calls = 0;
  const upMock = async () => ({ ok: true, status: 200, data: {} });
  const downMock = async () => ({ ok: false, status: 401, error: 'unauthorized' });
  ok((await mgr.health('fred', { callFn: upMock, now: T })).ok === true, 'health: up API → ok true');
  const h = await mgr.health('polygon', { callFn: downMock, now: T });
  ok(h.ok === false && h.status === 401, 'health: rejected key → ok false + status surfaced');
  ok((await mgr.health('bea', { callFn: upMock })).ok === null, 'health: API with no defined probe → ok null (not a failure)');

  // ===== unknown api =====
  ok((await mgr.managedCall('nope', 'x', { callFn: mock })).ok === false, 'unknown api → error');

  // ===== PERSISTENCE: rate usage + cache survive a restart (durable store, not in-memory) =====
  mgr.resetUsage(); calls = 0;
  await mgr.managedCall('newsapi', 'everything', { params: { q: 'x' }, now: T, callFn: mock });   // 1 usage row + cached (newsapi TTL 5m)
  require('../lib/api_store').close();   // simulate a RESTART — drop the DB connection; the file persists
  ok(mgr.usage('newsapi', { now: T }).used.perDay === 1, 'rate usage SURVIVES a restart (durable — a reboot cannot reset a spent quota)');
  const afterRestart = await mgr.managedCall('newsapi', 'everything', { params: { q: 'x' }, now: T + 1000, callFn: mock });
  ok(afterRestart.cached === true && calls === 1, 'the response cache SURVIVES a restart (served from the durable cache, no re-fetch)');

  try { require('../lib/api_store').close(); fs.unlinkSync(tmp); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
