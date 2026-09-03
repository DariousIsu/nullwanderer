/* smoke_db_worker.js — read-only SQL off the main thread (lib/db_worker).
 *
 * Freeze cut 6 (2026-09-03): the encounters ranking (GROUP BY over 1.49M rows, 14.7s on p256) and the
 * tenant COUNT(*)s (~1s each) feed CACHES, not replies — they run in a worker thread with its own
 * read-only connection. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_db_worker.js
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const Database = require('better-sqlite3');
const W = require('../lib/db_worker');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

(async () => {
  const tmp = path.join(os.tmpdir(), `smoke_dbw_${process.pid}.db`);
  const d = new Database(tmp);
  d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  d.prepare("INSERT INTO t (v) VALUES ('a'),('b'),('c')").run();
  d.close();

  const rows = await W.query(tmp, 'SELECT id, v FROM t ORDER BY id');
  ok(Array.isArray(rows) && rows.length === 3 && rows[2].v === 'c', 'rows come back as plain objects, in order');
  const one = await W.query(tmp, 'SELECT COUNT(*) c FROM t WHERE v <> ?', ['a'], { mode: 'get' });
  ok(one && one.c === 2, 'mode:get returns one row; parameters bind');
  ok((await W.query(tmp, 'SELECT * FROM t WHERE id = 99', [], { mode: 'get' })) === null, 'mode:get with no row → null, never undefined');
  const [r1, r2, r3] = await Promise.all([
    W.query(tmp, 'SELECT 1 x', [], { mode: 'get' }), W.query(tmp, 'SELECT 2 x', [], { mode: 'get' }), W.query(tmp, 'SELECT 3 x', [], { mode: 'get' }),
  ]);
  ok(r1.x === 1 && r2.x === 2 && r3.x === 3, 'concurrent requests are answered by id, never crossed');
  ok(W._live().length === 1, 'one worker per database file, reused across requests');

  let err = null;
  try { await W.query(tmp, 'SELECT nope FROM t'); } catch (e) { err = e; }
  ok(err && /no such column/.test(err.message), 'a bad statement rejects with SQLite’s own message');
  err = null;
  try { await W.query(tmp, "INSERT INTO t (v) VALUES ('z') RETURNING id", [], { mode: 'get' }); } catch (e) { err = e; }
  ok(err && /readonly|read-only/i.test(err.message), `CRITICAL: the worker’s connection is READ-ONLY — a write is refused; the main thread keeps the only pen (${err && err.message})`);
  ok((await W.query(tmp, 'SELECT COUNT(*) c FROM t', [], { mode: 'get' })).c === 3, '…and the store is untouched');

  // A runaway statement times out and rejects; the worker is dropped so the lane is not wedged behind it.
  err = null;
  const slow = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 4000000) SELECT COUNT(*) n FROM c';
  try { await W.query(tmp, slow, [], { timeoutMs: 100 }); } catch (e) { err = e; }
  ok(err && /timeout/.test(err.message), 'a runaway statement times out — the caller keeps its stale cache');
  ok((await W.query(tmp, 'SELECT 7 x', [], { mode: 'get' })).x === 7, 'the next request is served by a FRESH worker (the timed-out one was dropped)');

  err = null;
  try { await W.query(path.join(os.tmpdir(), `definitely-missing-dbw-${process.pid}.db`), 'SELECT 1'); } catch (e) { err = e; }
  ok(!!err, 'a missing file rejects — never a silent empty result');

  // Freeze cut 15: a row cap and attachments (the localdb door rides both).
  const capped = await W.query(tmp, 'SELECT id FROM t ORDER BY id', [], { limit: 2 });
  ok(Array.isArray(capped) && capped.length === 2 && capped[1].id === 2, 'limit: the walk stops after N rows (the statement is never materialized past them)');
  const tmp2 = path.join(os.tmpdir(), `smoke_dbw2_${process.pid}.db`);
  const d2 = new Database(tmp2); d2.exec("CREATE TABLE t2 (v TEXT); INSERT INTO t2 (v) VALUES ('att')"); d2.close();
  const liveBefore = W._live().length;   // (the missing-file pin above leaves its own entry — count relatively)
  const att = await W.query(tmp, 'SELECT v FROM x.t2', [], { attach: [{ alias: 'x', path: tmp2 }], mode: 'get' });
  ok(att && att.v === 'att', 'attach: a sibling file answers by alias on the worker\'s read-only connection');
  ok(W._live().length === liveBefore + 1 && W._live().filter((k) => k.startsWith(tmp)).length === 2, 'attach: a different attachment set is a different worker (the bare-file worker stays)');
  err = null;
  try { await W.query(tmp, "INSERT INTO x.t2 (v) VALUES ('w') RETURNING v", [], { attach: [{ alias: 'x', path: tmp2 }], mode: 'get' }); } catch (e) { err = e; }
  ok(err && /read-only|readonly/i.test(err.message), 'attach: the attached file is read-only too (a write is refused before it runs)');
  await W.close(tmp);
  ok(!W._live().some((k) => k.startsWith(tmp)), 'close(file) stops every worker on that file, attachments included');
  try { fs.unlinkSync(tmp2); } catch {}

  await W.closeAll();
  ok(W._live().length === 0, 'closeAll stops every worker');
  await new Promise((r) => setTimeout(r, 200));
  try { fs.unlinkSync(tmp); } catch {}

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke_db_worker crashed:', e); process.exit(1); });
