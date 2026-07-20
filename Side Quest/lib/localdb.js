/**
 * lib/localdb.js — first-class READ access to her OWN short-term store (the local sq.db) for the cloud.
 *
 * "Zoe IS the memory": her local store is her. The cloud cognition should be able to query the WHOLE of
 * it — not just a k=5 RAG slice — as a first-class data source, exactly as it queries Echo's DBs via
 * db_query. This is the local counterpart: a read-only SELECT surface over sq.db, plus an inventory so
 * the cloud knows what tables exist.
 *
 * SAFETY: read-only by construction. better-sqlite3's `stmt.readonly` is true ONLY for non-writing
 * statements, and prepare() accepts a SINGLE statement — so a non-SELECT or a multi-statement string is
 * rejected before anything executes. A keyword pre-check gives a clear message first. Row-capped + her
 * own data. PURE-ish: only reads through lib/db's handle. Never throws — returns { ok, ... }.
 */
'use strict';

const path = require('path');
const dbLib = require('./db');
const MAX_ROWS = 200;
const WRITE_KW_RE = /\b(insert|update|delete|replace|drop|alter|create|attach|detach|pragma|vacuum|reindex|truncate)\b/i;

// ── THE OTHER FIVE DATABASES ─────────────────────────────────────────────────────────────────
//
// Until now this surface reached sq.db and nothing else — it binds to dbLib.getDb(). The awareness
// audit (docs/DATA_INVENTORY_AND_AWARENESS.md, 2026-07-20) probed that boundary directly:
//
//   REACHABLE  sq.db route_obs             -> 661693
//   BLIND      puller.db targets           -> no such table: targets
//   BLIND      news_bucket news_items      -> no such table: news_items
//   BLIND      api_stream api_usage        -> no such table: api_usage
//   BLIND      editor pipeline_documents   -> no such table: pipeline_documents
//
// So FIVE of six local databases could not be queried at all. The cost is concentrated: puller.db
// alone holds 942,190 rows — her largest body of SELF-GATHERED research — and its only read path was
// gatherHeldContacts(), which fires solely when the turn router classifies a message as 'contacts'.
// Ask about a person any other way and none of it existed; "how many of my targets have emails?" had
// no path at all.
//
// WHY A SEPARATE READ-ONLY CONNECTION, not ATTACH onto the app's handle: those files have their own
// live writers (news_store, puller_db, api_store, editor_registry). Attaching them to the main
// read-WRITE handle would put a second connection into their WAL for no reason and invites lock
// contention on a 180MB bucket being written by the feed poller. A dedicated readonly connection is
// also defence in depth — the existing stmt.readonly check stays, but now the connection itself
// cannot write even if that check were ever wrong.
//
// Paths honour the same env overrides the owning modules use, so an isolated smoke run attaches its
// temp files rather than the real ones.
const ATTACHED = [
  { alias: 'news', env: 'NEWS_DB_PATH', file: 'news_bucket.db', note: 'news bucket — items, stories, layers' },
  { alias: 'puller', env: 'PULLER_DB_PATH', file: 'puller.db', note: 'Puller — targets, beliefs, observations' },
  { alias: 'api', env: 'API_DB_PATH', file: 'api_stream.db', note: 'API stream — usage, cache, bulk records' },
  { alias: 'editor', env: 'EDITOR_DB_PATH', file: 'editor.db', note: 'editor pipeline — documents, checks, certificates' },
];
// canvas_layout.db is deliberately NOT attached: it holds UI geometry (where a card sits on the
// canvas), which is not knowledge and would only add noise to the inventory.

let _conn = null;         // the readonly connection (null until first use, or after a failed open)
let _connTried = false;   // so a failed open is not retried on every query
let _attached = [];       // aliases that actually attached

function _dataPath(file) { return path.join(__dirname, '..', 'data', file); }

// The read-only connection with the other databases attached. Returns null if it cannot be opened —
// callers then fall back to the app handle, so this is never WORSE than the sq.db-only behaviour.
function _readerConn() {
  if (_connTried) return _conn;
  _connTried = true;
  try {
    const Database = require('better-sqlite3');
    _conn = new Database(dbLib.DB_PATH, { readonly: true });
    for (const a of ATTACHED) {
      const p = process.env[a.env] || _dataPath(a.file);
      try {
        if (!require('fs').existsSync(p)) continue;      // absent file is not an error, just unavailable
        _conn.prepare(`ATTACH DATABASE ? AS ${a.alias}`).run(p);
        _attached.push(a.alias);
      } catch (e) { console.error(`[localdb] could not attach ${a.alias}:`, e.message); }
    }
  } catch (e) {
    console.error('[localdb] readonly connection unavailable, falling back to sq.db only:', e.message);
    _conn = null;
  }
  return _conn;
}

// Test seam + a way to pick up a newly-created DB file without a restart.
function _reset() { try { if (_conn) _conn.close(); } catch {} _conn = null; _connTried = false; _attached = []; }

// Run a read-only SELECT against her local store. Returns { ok, rows, count, truncated } or { ok:false, error }.
// Cross-database queries use the attached aliases: `SELECT * FROM puller.targets`, `news.news_items`.
function query(sql, params = []) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!s) return { ok: false, error: 'empty query' };
  if (WRITE_KW_RE.test(s)) return { ok: false, error: 'only read-only SELECT queries are allowed' };
  const conn = _readerConn() || dbLib.getDb();
  let stmt;
  try { stmt = conn.prepare(s); }
  catch (e) { return { ok: false, error: 'invalid SQL: ' + e.message }; }   // also catches multi-statement
  if (!stmt.readonly) return { ok: false, error: 'only read-only SELECT queries are allowed' };
  try {
    const rows = stmt.all(...(Array.isArray(params) ? params : []));
    return { ok: true, rows: rows.slice(0, MAX_ROWS), count: rows.length, truncated: rows.length > MAX_ROWS };
  } catch (e) { return { ok: false, error: e.message }; }
}

// The map of her local store: every table + its row count, across sq.db AND the attached databases.
// Attached tables are reported qualified (`puller.targets`) — which is exactly how they must be
// queried, so the map doubles as the syntax hint.
function inventory() {
  const out = [];
  const conn = _readerConn() || dbLib.getDb();
  const schemas = ['main'].concat(_attached);
  for (const sch of schemas) {
    let tables = [];
    try {
      tables = conn.prepare(`SELECT name FROM ${sch}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all().map(r => r.name);
    } catch { continue; }
    for (const t of tables) {
      const qualified = sch === 'main' ? t : `${sch}.${t}`;
      let rows = 0;
      try { rows = conn.prepare(`SELECT COUNT(*) AS c FROM ${sch}."${t}"`).get().c; } catch {}
      out.push({ table: qualified, rows, db: sch });
    }
  }
  return out;
}

// Column schema for one table (name + type). Accepts a qualified `alias.table`; both halves sanitized.
function schema(table) {
  const raw = String(table || '');
  const [a, b] = raw.includes('.') ? raw.split('.', 2) : [null, raw];
  const sch = a ? a.replace(/[^a-zA-Z0-9_]/g, '') : 'main';
  const t = String(b || '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!t) return [];
  const conn = _readerConn() || dbLib.getDb();
  try { return conn.prepare(`PRAGMA ${sch}.table_info("${t}")`).all().map(c => ({ name: c.name, type: c.type })); }
  catch { return []; }
}

// Which of the other databases are actually live right now (for the tool description / diagnostics).
function attachedDbs() { _readerConn(); return _attached.slice(); }

module.exports = { query, inventory, schema, attachedDbs, ATTACHED, _reset, MAX_ROWS, WRITE_KW_RE };
