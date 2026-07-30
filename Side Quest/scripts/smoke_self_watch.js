/* Smoke: lib/self_watch — the internal log-stream reader (classify → count/store/anomaly →
 * recurring anomaly mints a capability need through the EXISTING rehearse door).
 * Offline: temp DB, nowMs injected everywhere, no console hook installed (observe() driven directly).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_self_watch.js
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_watch_${Date.now()}.db`);
require('../lib/db').init();
const obs = require('../lib/obs_bus');
const sw = require('../lib/self_watch');
const cn = require('../lib/capability_need');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  const T0 = Date.now();

  // --- classification is deterministic and lane-mapped ---
  let c = sw.classify('[subc] synthesis stored — tension: "x" → action: research');
  ok(c.action === 'store' && c.lane === 'subc', 'a signal-lane line is stored under its lane');
  c = sw.classify('[directed] #3632 → started Cobb County → continue');
  ok(c.action === 'store' && c.lane === 'directed' && c.ref === 'thread:3632', 'directed line carries its thread ref');
  c = sw.classify('[caption] resolved CNN');
  ok(c.action === 'count' && c.prefix === 'caption', 'a non-signal lane is counted, not stored');
  ok(sw.classify('[watch] self note').action === 'ignore', 'its own lines are never observed (loop guard)');
  ok(sw.classify('plain unbracketed chatter').action === 'count', 'raw lines count under (raw)');
  c = sw.classify('[media] reading insert failed: boom', 'error');
  ok(c.action === 'anomaly', 'an error-level line is an anomaly regardless of prefix');
  c = sw.classify('[window] gemma prompt ~29203ch ≈ 8112tok vs num_ctx 8192 — will SILENTLY truncate', 'warn');
  ok(c.action === 'anomaly' && c.lane === 'window', '[window] overruns are anomalies even at warn level');
  ok(sw.classify('suite FAILED — 3 of 12').action === 'anomaly', 'FAILED shapes are anomalies at any level');

  // --- signatures blank the volatile parts ---
  ok(sw.signatureOf('[fit] prompt 29112ch > 25171ch budget') === sw.signatureOf('[fit] prompt 28467ch > 25171ch budget'),
    'signatures identify "the same problem again" across changing numbers');

  // --- observe → bus: signal stored, anomaly capped per signature ---
  sw._reset();
  sw.observe('[subc] synthesis stored — tension: "y"', 'info', { nowMs: T0 });
  sw.observe('[media] reading insert failed: db locked', 'error', { nowMs: T0 + 1000 });
  sw.observe('[media] reading insert failed: db locked', 'error', { nowMs: T0 + 2000 });   // < 1h later
  obs.flush();
  const stored = obs.recent({ sinceId: 0, limit: 100 });
  ok(stored.some((r) => r.lane === 'subc' && r.kind === 'line'), 'observed signal line landed on the bus');
  ok(stored.filter((r) => r.kind === 'anomaly').length === 1, 'repeat anomaly within the hour is counted, not re-stored (flood guard)');

  // --- the drive: a recurring anomaly opens a capability need (3rd hit in 24h) ---
  sw.observe('[media] reading insert failed: db locked', 'error', { nowMs: T0 + 3000 });
  obs.flush();
  const needs = cn.listOpen();
  ok(needs.length === 1 && String(needs[0].born_from || '').startsWith('self-watch'), 'third hit in 24h → capability need minted, born_from self-watch');
  ok(/recurring failure/.test(needs[0].need), 'the need names the failure so the rehearse door can work it');
  const needEvts = obs.recent({ sinceId: 0, kinds: ['need'] });
  ok(needEvts.length === 1 && /opened need #\d+/.test(needEvts[0].text), 'the minting decision is itself visible on the bus');

  // --- bounded: with MAX_OPEN_WATCH_NEEDS open, a new recurring signature does NOT mint ---
  cn.record('I need a standing placeholder covering totally unrelated smoke vocabulary here', { bornFrom: 'self-watch: test-fill' });
  for (let i = 0; i < 3; i++) sw.observe('[teams] join failed: lobby timeout 9999', 'error', { nowMs: T0 + 4000 + i * 3700e3 });
  obs.flush();
  ok(cn.listOpen().length === 2, `a third watch-born need is refused at the cap (${sw.MAX_OPEN_WATCH_NEEDS} open max — throttle to completion)`);

  // --- status flush: counters land as ONE event with the tallies ---
  sw._reset();
  sw.observe('[caption] resolved A', 'info', { nowMs: T0 });
  sw.observe('[caption] resolved B', 'info', { nowMs: T0 + 1 });
  sw.observe('[inbox-poll] 3 unread', 'info', { nowMs: T0 + 6 * 60e3 });   // crosses STATUS_FLUSH_MS
  obs.flush();
  const statuses = obs.recent({ sinceId: 0, kinds: ['status'] });
  const st = statuses[statuses.length - 1];
  ok(st && st.data && st.data.counts && st.data.counts.caption === 2, 'status event carries the per-lane counters');

  obs._stop();
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { require('../lib/db').getDb().close(); } catch {}
  try { require('fs').unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
