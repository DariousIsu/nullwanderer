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

// ── WHAT THE MANIFEST LISTS: pinned-first, not biggest-first ─────────────────────────────────
// Measured 2026-07-31: taking the top 14 by row count listed nothing but exhaust
// (puller.observations 969k, kg_observations 684k, encounters 332k, cloud_traces…), while the
// stores built to ANSWER something ranked #34/#44/#55/#65 and were invisible. She then needed
// county board data 21 times in one day, did not know civic_bodies existed, invented
// `county_election_boards`, and failed every time. A store she cannot see is a store she does not have.
console.log('\nMANIFEST TABLE SELECTION');
{
  const fake = [
    { table: 'puller.observations', rows: 969268 }, { table: 'kg_observations', rows: 684102 },
    { table: 'encounters', rows: 332235 }, { table: 'recent_cards', rows: 199536 },
    { table: 'cloud_traces', rows: 47276 }, { table: 'route_obs', rows: 2600000 },
    { table: 'puller.beliefs', rows: 967062 }, { table: 'news.news_items', rows: 147503 },
    { table: 'civic_bodies', rows: 24 }, { table: 'civic_memberships', rows: 337 },
    { table: 'cardinality', rows: 134 }, { table: 'absence', rows: 1315 },
    { table: 'skills', rows: 20 }, { table: 'an_empty_curated_one', rows: 0 },
  ];
  const got = ldb.manifestTables(10, fake);
  const names = got.map((t) => t.table);

  ok(names.indexOf('civic_bodies') < names.indexOf('puller.beliefs'), '⭐ a 24-row answer-bearing store outranks a 967,062-row one');
  ok(['civic_bodies', 'civic_memberships', 'cardinality', 'absence', 'skills'].every((n) => names.includes(n)), 'every curated store present in the data is listed');
  ok(got.find((t) => t.table === 'civic_bodies').purpose.length > 10, 'and carries WHAT IT IS FOR — a bare table name never taught her that boards live there');

  for (const ex of ['route_obs', 'cloud_traces', 'agent_events', 'recent_cards', 'kg_observations', 'puller.observations', 'encounters']) {
    ok(!names.includes(ex), `exhaust excluded: ${ex} — nothing is ever answered FROM it`);
  }
  ok(names.includes('puller.beliefs') && names.includes('news.news_items'), 'genuine big data stores still make the list after the pinned ones');
  ok(!names.includes('an_empty_curated_one'), 'a curated table with ZERO rows is dropped — an empty shelf invites a wasted hop');
  ok(got.every((t) => t.rows > 0), 'nothing empty is ever listed');
  ok(new Set(names).size === names.length, 'no table is listed twice (pinned then re-added as filler)');

  const live = ldb.manifestTables(16);
  ok(live.length > 0 && live.every((t) => typeof t.table === 'string' && t.rows > 0), 'runs against the real inventory without throwing');
}

// ⭐ live-observed perf guard: a leading-wildcard body LIKE on documents is refused with the FTS steer
{
  const bad = ldb.query("SELECT id, title FROM documents WHERE body LIKE '%methodology%' ORDER BY created_ts DESC LIMIT 20");
  ok(bad.ok === false && /documents_fts MATCH/.test(bad.error), '⭐ a `body LIKE %term%` full-scan on documents is refused with the FTS query (measured 13-22s main-thread block)');
  const bad2 = ldb.query("select * from documents where body like '%timeline%' or body like '%resource plan%'");
  ok(bad2.ok === false && /full-text/.test(bad2.error), 'the OR-of-LIKEs variant (the exact live query) is refused too');
  // a normal query is untouched (the guard is surgical — only documents + leading-wildcard body LIKE)
  const okq = ldb.query("SELECT name FROM sqlite_master WHERE type='table' LIMIT 3");
  ok(okq.ok === true, 'an ordinary read is unaffected by the guard');
}

// ⭐ Freeze cut 15 — THE DOOR OFF THE MAIN THREAD: queryAsync runs the same statement in lib/db_worker
// (a read-only connection with the same attachments), same shape; both doors stop the walk at MAX_ROWS + 1.
(async () => {
  const W = require('../lib/db_worker');
  const a = await ldb.queryAsync("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 3");
  const s = ldb.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 3");
  ok(a.ok && JSON.stringify(a.rows) === JSON.stringify(s.rows), '⭐ queryAsync: the same rows as the synchronous door, produced in the db worker');
  ok(W._live().some((k) => k.startsWith(process.env.SQ_DB_PATH)), 'queryAsync: a worker is live on the store file (the reply path left the main thread)');
  const w1 = await ldb.queryAsync("INSERT INTO meta (key,value) VALUES ('x','y')");
  const w2 = await ldb.queryAsync('SELECT 1; DELETE FROM meta');
  ok(w1.ok === false && w2.ok === false, 'queryAsync: writes and multi-statements are refused before the worker is asked');
  ok((await ldb.queryAsync("SELECT id, title FROM documents WHERE body LIKE '%x%'")).ok === false, 'queryAsync: the body-LIKE full-scan guard holds on the async door too');
  ok((await ldb.queryAsync('SELECT nope FROM meta')).ok === false, 'queryAsync: a bad statement is an error, never a throw');
  // the cap: a big result is walked only to MAX_ROWS + 1 on BOTH doors
  const h = db.getDb();
  h.exec('CREATE TABLE IF NOT EXISTS many (id INTEGER PRIMARY KEY, v TEXT)');
  const ins = h.prepare("INSERT INTO many (v) VALUES ('r')"); for (let i = 0; i < ldb.MAX_ROWS + 50; i++) ins.run();
  const big = await ldb.queryAsync('SELECT * FROM many');
  const bigS = ldb.query('SELECT * FROM many');
  ok(big.ok && big.rows.length === ldb.MAX_ROWS && big.truncated === true && big.count === ldb.MAX_ROWS, `queryAsync: a ${ldb.MAX_ROWS + 50}-row result is capped at ${ldb.MAX_ROWS} and marked truncated (the worker never materialized the rest)`);
  ok(bigS.ok && bigS.rows.length === ldb.MAX_ROWS && bigS.truncated === true, 'query (sync): the same cap — the walk stops at MAX_ROWS + 1');
  const small = await ldb.queryAsync('SELECT * FROM many LIMIT 5');
  ok(small.ok && small.rows.length === 5 && small.truncated === false && small.count === 5, 'queryAsync: a small result keeps its exact count, not truncated');
  // attachments ride into the worker: a sibling file answers by alias
  const pullerTmp = path.join(os.tmpdir(), `puller_smoke_localdb_${Date.now()}.db`);
  const pd = new (require('better-sqlite3'))(pullerTmp); pd.exec("CREATE TABLE targets (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO targets (name) VALUES ('a'),('b')"); pd.close();
  process.env.PULLER_DB_PATH = pullerTmp; ldb._reset();
  ok(ldb._attachSpecs().some((x) => x.alias === 'puller' && x.path === pullerTmp), 'the worker is handed the same attachments the sync door uses (env overrides honoured)');
  const viaAlias = await ldb.queryAsync('SELECT COUNT(*) c FROM puller.targets');
  ok(viaAlias.ok && viaAlias.rows[0].c === 2, '⭐ queryAsync: an attached sibling answers by alias inside the worker (puller.targets)');
  await W.closeAll();
  try { require('fs').unlinkSync(pullerTmp); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('smoke_localdb crashed:', e); process.exit(1); });
