/* Smoke: lib/touchpoint.js — M4.1 touchpoint emission (offline, temp DB — never the live sq.db).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_touchpoint.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

// Point lib/db at a throwaway store BEFORE anything requires it (db.js reads SQ_DB_PATH at require).
const TMP = path.join(os.tmpdir(), `tp_smoke_${process.pid}_${Math.random().toString(36).slice(2)}.db`);
process.env.SQ_DB_PATH = TMP;

require('../lib/db').init();   // the app inits at boot; the smoke must too (against the temp store)
const tp = require('../lib/touchpoint');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  const NOW = 1754400000000;

  // --- keyOf: normalization joins variant forms; short keys dropped ---
  ok(tp.keyOf('City of Sacramento') === tp.keyOf('CITY OF SACRAMENTO'), 'keyOf: variant case/form joins to one key');
  ok(tp.keyOf('') === '' && tp.keyOf('AB') === '', 'keyOf: empty + too-short keys are dropped');

  // --- record: lands, and UPSERTS on (entity, stream) ---
  ok(tp.record({ name: 'Rainey Center', type: 'organization', stream: { kind: 'focus', key: 'focus:1', label: 'think tanks' }, ref: 'run1.md', now: NOW }), 'record: a stamp lands');
  ok(tp.record({ name: 'Rainey Center', type: 'organization', stream: { kind: 'focus', key: 'focus:1', label: 'think tanks' }, ref: 'run1.md', now: NOW + 1000 }), 'record: same entity×stream again is accepted (refresh)');
  const d = require('../lib/db').getDb();
  const n1 = d.prepare("SELECT COUNT(*) n FROM touchpoints WHERE stream_key='focus:1'").get().n;
  ok(n1 === 1, `record: upsert — one row per entity×stream (got ${n1})`);
  ok(d.prepare("SELECT ts FROM touchpoints WHERE stream_key='focus:1'").get().ts === NOW + 1000, 'record: refresh advanced ts');

  // --- recordObservation: promoted flows, held is refused, missing sourceEntity refused ---
  ok(tp.recordObservation({ sourceEntity: 'Lucas Overby', type: 'person', status: 'promoted' }, { stream: { kind: 'meeting', key: 'doc:9', label: 'Meeting — LAMP' }, ref: '9', now: NOW }), 'observation: promoted entity stamps');
  ok(!tp.recordObservation({ sourceEntity: 'Held Person', type: 'person', status: 'held' }, { stream: { kind: 'meeting', key: 'doc:9' }, ref: '9', now: NOW }), 'observation: a held candidate never stamps');
  ok(!tp.recordObservation({ type: 'person' }, { stream: { kind: 'meeting', key: 'doc:9' }, ref: '9', now: NOW }), 'observation: no sourceEntity → refused');

  // --- cross-stream join surface: same entity from a second stream → fresh() groups it ---
  ok(tp.record({ name: 'Rainey  Center', type: 'organization', stream: { kind: 'meeting', key: 'doc:9', label: 'Meeting — LAMP' }, ref: '9', now: NOW + 2000 }), 'record: same entity, different stream lands separately');
  const fresh = tp.fresh({ sinceMs: 24 * 3600 * 1000, now: NOW + 3000 });
  const rainey = fresh.find((g) => g.entity_key === tp.keyOf('Rainey Center'));
  ok(!!rainey && rainey.streams.length === 2, `fresh: entity grouped across BOTH streams (got ${rainey ? rainey.streams.length : 0})`);
  ok(rainey.streams.some((s) => s.kind === 'focus') && rainey.streams.some((s) => s.kind === 'meeting'), 'fresh: the join surface names both stream kinds');
  const sf = tp.streamsFor(tp.keyOf('Rainey Center'));
  ok(sf.length === 2 && sf[0].ts >= sf[1].ts, 'streamsFor: historical surface, newest first');

  // --- per-product cap (names must survive keyOf DISTINCTLY — coreKey strips digits, so use letters) ---
  const alpha = (i) => { let s = ''; do { s = String.fromCharCode(97 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0); return s; };
  for (let i = 0; i < tp.MAX_PER_PRODUCT + 10; i++) tp.record({ name: `Placeholder ${alpha(i)}ton Society`, stream: { kind: 'doc', key: 'doc:cap' }, ref: 'capdoc', now: NOW });
  const nCap = d.prepare("SELECT COUNT(*) n FROM touchpoints WHERE stream_key='doc:cap'").get().n;
  ok(nCap === tp.MAX_PER_PRODUCT, `cap: exactly MAX_PER_PRODUCT stamps per product — the cap ENGAGED (got ${nCap})`);

  // --- kill switch ---
  process.env.ZOE_TOUCHPOINTS = '0';
  ok(!tp.record({ name: 'Switched Off Org', stream: { kind: 'doc', key: 'doc:off' }, now: NOW }), 'kill switch: ZOE_TOUCHPOINTS=0 refuses stamps');
  delete process.env.ZOE_TOUCHPOINTS;
  ok(tp.record({ name: 'Switched Back On Org', stream: { kind: 'doc', key: 'doc:on' }, now: NOW }), 'kill switch: cleared → stamps again');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { require('../lib/db').getDb().close(); } catch {}
  try { fs.unlinkSync(TMP); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
