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

const dbLib = require('./db');
const MAX_ROWS = 200;
const WRITE_KW_RE = /\b(insert|update|delete|replace|drop|alter|create|attach|detach|pragma|vacuum|reindex|truncate)\b/i;

// Run a read-only SELECT against her local store. Returns { ok, rows, count, truncated } or { ok:false, error }.
function query(sql, params = []) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!s) return { ok: false, error: 'empty query' };
  if (WRITE_KW_RE.test(s)) return { ok: false, error: 'only read-only SELECT queries are allowed' };
  let stmt;
  try { stmt = dbLib.getDb().prepare(s); }
  catch (e) { return { ok: false, error: 'invalid SQL: ' + e.message }; }   // also catches multi-statement
  if (!stmt.readonly) return { ok: false, error: 'only read-only SELECT queries are allowed' };
  try {
    const rows = stmt.all(...(Array.isArray(params) ? params : []));
    return { ok: true, rows: rows.slice(0, MAX_ROWS), count: rows.length, truncated: rows.length > MAX_ROWS };
  } catch (e) { return { ok: false, error: e.message }; }
}

// The map of her local store: every table + its row count (what the cloud needs to know it's there).
function inventory() {
  try {
    const db = dbLib.getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    return tables.map(t => { let rows = 0; try { rows = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c; } catch {} return { table: t, rows }; });
  } catch { return []; }
}

// Column schema for one table (name + type). Table name is sanitized.
function schema(table) {
  const t = String(table || '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!t) return [];
  try { return dbLib.getDb().prepare(`PRAGMA table_info("${t}")`).all().map(c => ({ name: c.name, type: c.type })); }
  catch { return []; }
}

module.exports = { query, inventory, schema, MAX_ROWS, WRITE_KW_RE };
