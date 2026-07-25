/* Smoke: lib/route_drain — the route_obs consumption queue. Proves the fold is correct, the pass
 * consumes AND prunes (so the table stays bounded), the watermark advances, a second pass only sees new
 * rows, and it self-heals after a truncate. Uses an ISOLATED temp DB (SQ_DB_PATH).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_route_drain.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `sq_routedrain_${process.pid}_${Date.now().toString(36)}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.SQ_DB_PATH = tmp;

const db = require('../lib/db');
db.init();
const rd = require('../lib/route_drain');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const ins = db.getDb().prepare('INSERT INTO route_obs (ts, tool, outcome, latency_ms) VALUES (?,?,?,?)');
const seed = (rows) => { for (const r of rows) ins.run(r.ts || 1, r.tool, r.outcome, r.latency == null ? null : r.latency); };

// --- foldHealth (PURE) ---
const folded = rd.foldHealth([
  { tool: 'search_entities', outcome: 'hit', latency_ms: 100 },
  { tool: 'search_entities', outcome: 'miss', latency_ms: 300 },
  { tool: 'search_entities', outcome: 'error' },
  { tool: 'db_query', outcome: 'hit', latency_ms: 50 },
]);
const se = folded.get('search_entities');
ok(se.calls === 3 && se.misses === 1 && se.errors === 1, 'fold: calls/misses/errors counted per tool');
ok(se.latencySum === 400 && se.latencyN === 2, 'fold: latency summed with its own count (error row had none)');
ok(folded.get('db_query').calls === 1, 'fold: a second tool folds independently');

// --- a real drain: consume + PRUNE + advance watermark ---
seed([
  { tool: 'search_entities', outcome: 'hit', latency: 120 },
  { tool: 'search_entities', outcome: 'miss', latency: 250 },
  { tool: 'db_query', outcome: 'error', latency: 40 },
]);
ok(db.getDb().prepare('SELECT COUNT(*) n FROM route_obs').get().n === 3, 'seeded 3 raw observations');
const r1 = rd.drainPass({});
ok(r1.processed === 3 && r1.tools === 2, 'drain processed all 3 rows across 2 tools');
ok(r1.pruned === 3 && db.getDb().prepare('SELECT COUNT(*) n FROM route_obs').get().n === 0,
  'drain PRUNED the consumed rows — route_obs is emptied to its tail (the whole point)');
const health = db.getRouteHealth();
const seH = health.find(h => h.tool === 'search_entities');
ok(seH && seH.calls === 2 && seH.misses === 1 && seH.latency_sum === 370, 'route_health carries the durable per-tool aggregate');
ok(db.getMeta(rd.WATERMARK_KEY) === String(r1.watermark) && r1.watermark > 0, 'watermark advanced to the last consumed id');

// --- health ACCUMULATES across drains (rolling aggregate, not a snapshot) ---
seed([{ tool: 'search_entities', outcome: 'hit', latency: 30 }]);
rd.drainPass({});
ok(db.getRouteHealth().find(h => h.tool === 'search_entities').calls === 3, 'a later drain ADDS to the existing tool row (rolling)');

// --- an empty drain is a clean no-op ---
const empty = rd.drainPass({});
ok(empty.processed === 0 && empty.pruned === 0, 'nothing to drain → clean no-op');

// --- SELF-HEAL after a truncate: watermark points past a now-empty/low table, fresh rows still drain ---
db.getDb().prepare('DELETE FROM route_obs').run();               // simulate the operator TRUNCATE
db.setMeta(rd.WATERMARK_KEY, '999999');                          // stale high watermark left behind
seed([{ tool: 'quick_lookup', outcome: 'hit', latency: 10 }]);  // fresh rows get low ids again
const healed = rd.drainPass({});
ok(healed.processed === 1 && healed.pruned === 1, 'self-heal: a stale watermark past max(id) resets, fresh rows are not skipped');
ok(db.getRouteHealth().find(h => h.tool === 'quick_lookup').calls === 1, 'the post-truncate observation folded correctly');

try { fs.unlinkSync(tmp); } catch {}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
