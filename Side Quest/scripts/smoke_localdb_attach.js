/* smoke_localdb_attach.js — cross-database reach for her local SQL surface.
 *
 * The awareness audit (docs/DATA_INVENTORY_AND_AWARENESS.md) found localdb bound to sq.db alone, so
 * FIVE of six local databases could not be queried at all — including puller.db, 942,190 rows of her
 * own contact research whose only read path was the 'contacts' turn route.
 *
 * The load-bearing tests are the SAFETY ones. This surface now reaches four more databases, so the
 * read-only guarantee has to hold across all of them: the write-keyword pre-check, the
 * stmt.readonly check, and single-statement enforcement. A read surface that can write is a far
 * worse bug than a blind one.
 *
 * Runs against ISOLATED temp databases via the same env overrides the owning modules honour
 * (SQ_DB_PATH / PULLER_DB_PATH / NEWS_DB_PATH / API_DB_PATH / EDITOR_DB_PATH), so it touches no real data.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localdb-attach-'));
const p = (n) => path.join(tmp, n);

// Build isolated stand-ins BEFORE requiring lib/db, so the env overrides take.
function make(file, ddl, rows) {
  const d = new Database(p(file));
  d.exec(ddl);
  for (const r of rows) d.prepare(r.sql).run(...r.args);
  d.close();
}
make('puller.db', 'CREATE TABLE targets (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE beliefs (id INTEGER PRIMARY KEY, target_id INT, type TEXT, value TEXT);',
  [{ sql: 'INSERT INTO targets VALUES (1, ?)', args: ['Jane Roe'] }, { sql: 'INSERT INTO targets VALUES (2, ?)', args: ['John Doe'] },
   { sql: 'INSERT INTO beliefs VALUES (1, 1, ?, ?)', args: ['email', 'jane@example.gov'] }]);
make('news_bucket.db', 'CREATE TABLE news_items (id INTEGER PRIMARY KEY, title TEXT);',
  [{ sql: 'INSERT INTO news_items VALUES (1, ?)', args: ['a headline'] }]);
make('api_stream.db', 'CREATE TABLE api_usage (id INTEGER PRIMARY KEY, api TEXT);',
  [{ sql: 'INSERT INTO api_usage VALUES (1, ?)', args: ['census'] }]);
make('editor.db', 'CREATE TABLE pipeline_documents (id INTEGER PRIMARY KEY, title TEXT);',
  [{ sql: 'INSERT INTO pipeline_documents VALUES (1, ?)', args: ['a draft'] }]);

process.env.SQ_DB_PATH = p('sq.db');
process.env.PULLER_DB_PATH = p('puller.db');
process.env.NEWS_DB_PATH = p('news_bucket.db');
process.env.API_DB_PATH = p('api_stream.db');
process.env.EDITOR_DB_PATH = p('editor.db');

const dbLib = require('../lib/db');
dbLib.init();
const localdb = require('../lib/localdb');
localdb._reset();   // pick up the env paths set above

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

(async () => {
  // ── reach ────────────────────────────────────────────────────────────────────────────────────
  ok(localdb.attachedDbs().length === 4, `all four databases attached (got ${localdb.attachedDbs().join(',') || 'none'})`);
  const cnt = (sql) => { const r = localdb.query(sql); return r.ok ? r.rows[0].c : `ERR ${r.error}`; };
  ok(cnt('SELECT COUNT(*) c FROM puller.targets') === 2, 'puller.targets reachable');
  ok(cnt('SELECT COUNT(*) c FROM news.news_items') === 1, 'news.news_items reachable');
  ok(cnt('SELECT COUNT(*) c FROM api.api_usage') === 1, 'api.api_usage reachable');
  ok(cnt('SELECT COUNT(*) c FROM editor.pipeline_documents') === 1, 'editor.pipeline_documents reachable');
  ok(typeof cnt('SELECT COUNT(*) c FROM open_threads') === 'number', 'her main store still reachable unqualified');

  // the shape of question that had NO path before: a JOIN across two of her stores
  {
    const r = localdb.query("SELECT t.name FROM puller.targets t JOIN puller.beliefs b ON b.target_id=t.id WHERE b.type='email'");
    ok(r.ok && r.rows.length === 1 && r.rows[0].name === 'Jane Roe', 'cross-table join inside an attached db works');
  }

  // ── SAFETY: read-only across every attached database ─────────────────────────────────────────
  {
    const writes = [
      'DELETE FROM puller.targets',
      'UPDATE puller.beliefs SET value = 1',
      "INSERT INTO news.news_items VALUES (99, 'x')",
      'DROP TABLE api.api_usage',
      'CREATE TABLE editor.evil (x INT)',
      "ATTACH DATABASE 'other.db' AS other",
      'PRAGMA journal_mode = DELETE',
    ];
    for (const w of writes) {
      const r = localdb.query(w);
      ok(!r.ok, `SAFETY: refused — ${w.slice(0, 42)}`);
    }
    // and nothing actually changed
    ok(cnt('SELECT COUNT(*) c FROM puller.targets') === 2, 'SAFETY: attached data is intact after the write attempts');
    ok(cnt('SELECT COUNT(*) c FROM news.news_items') === 1, 'SAFETY: news data intact');
  }

  // multi-statement smuggling must not execute
  {
    const r = localdb.query("SELECT 1; DELETE FROM puller.targets");
    ok(!r.ok, 'SAFETY: multi-statement string rejected');
    ok(cnt('SELECT COUNT(*) c FROM puller.targets') === 2, 'SAFETY: nothing deleted by the smuggled statement');
  }

  // ── inventory + schema are qualified, so the map doubles as the syntax hint ───────────────────
  {
    const inv = localdb.inventory();
    const names = inv.map(i => i.table);
    ok(names.includes('puller.targets') && names.includes('news.news_items'), 'inventory reports attached tables QUALIFIED');
    ok(names.includes('open_threads'), 'inventory reports main-store tables unqualified');
    ok(inv.find(i => i.table === 'puller.targets').rows === 2, 'inventory carries row counts for attached tables');
    ok(new Set(inv.map(i => i.db)).size === 5, 'inventory spans all five databases');

    const cols = localdb.schema('puller.beliefs');
    ok(cols.some(c => c.name === 'target_id'), 'schema() resolves a qualified table');
    ok(localdb.schema('open_threads').length > 0, 'schema() still resolves an unqualified table');
    ok(localdb.schema('puller.no_such_table').length === 0, 'schema() on a missing table → [] (no throw)');
    ok(localdb.schema('').length === 0, 'schema("") → []');
  }

  // ── a missing database file is not an error, just unavailable ────────────────────────────────
  {
    process.env.API_DB_PATH = p('does_not_exist.db');
    localdb._reset();
    ok(!localdb.attachedDbs().includes('api'), 'absent db file is skipped, not fatal');
    ok(cnt('SELECT COUNT(*) c FROM puller.targets') === 2, 'the other databases still attach and query');
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
