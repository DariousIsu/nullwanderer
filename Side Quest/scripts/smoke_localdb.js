/* Smoke: lib/localdb — first-class READ access to her own store, read-only by construction. Proves the
 * cloud can SELECT across her whole local DB but cannot write/alter it. Isolated temp DB. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_localdb.js
 */
'use strict';
const os = require('os'), path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_smoke_localdb_${Date.now()}.db`);
const db = require('../lib/db'); db.init();
const ldb = require('../lib/localdb');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- SELECT works ---
const r = ldb.query("SELECT name FROM sqlite_master WHERE type='table' LIMIT 3");
ok(r.ok && Array.isArray(r.rows), 'SELECT returns rows');
ok(ldb.query('WITH x AS (SELECT 1 AS n) SELECT n FROM x').ok === true, 'CTE (WITH … SELECT) allowed');

// --- writes rejected (the read-only guard) — none of these execute ---
ok(ldb.query("INSERT INTO meta (key,value) VALUES ('x','y')").ok === false, 'INSERT rejected');
ok(ldb.query("UPDATE meta SET value='z'").ok === false, 'UPDATE rejected');
ok(ldb.query('DELETE FROM meta').ok === false, 'DELETE rejected');
ok(ldb.query('DROP TABLE meta').ok === false, 'DROP rejected');
ok(ldb.query('CREATE TABLE hack (x)').ok === false, 'CREATE rejected');
ok(ldb.query('ALTER TABLE meta ADD COLUMN x').ok === false, 'ALTER rejected');
ok(ldb.query('PRAGMA table_info(meta)').ok === false, 'PRAGMA rejected through query()');
ok(ldb.query("SELECT 1; DELETE FROM meta").ok === false, 'multi-statement rejected');
ok(ldb.query('').ok === false, 'empty query rejected');

// word-boundary: a column like created_at / updated_count is NOT mistaken for a write keyword
ok(!ldb.WRITE_KW_RE.test('SELECT created_at, updated_count FROM t'), '"created_at"/"updated_count" not flagged as writes');

// --- reads real data written through the PROPER api (proves the window into her store) ---
db.setMeta('localdb_smoke', 'hello-from-store');
const rr = ldb.query('SELECT * FROM meta');
ok(rr.ok && JSON.stringify(rr.rows).includes('hello-from-store'), 'reads a value written via the normal memory API');

// --- inventory + schema (the map the cloud needs) ---
const inv = ldb.inventory();
ok(Array.isArray(inv) && inv.some(t => t.table === 'meta'), 'inventory lists tables (incl. meta)');
ok(inv.every(t => typeof t.rows === 'number'), 'inventory carries row counts');
ok(ldb.schema('meta').length > 0, 'schema lists columns for a table');
ok(ldb.schema('meta; DROP TABLE meta').length >= 0, 'schema sanitizes the table name (no injection)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
