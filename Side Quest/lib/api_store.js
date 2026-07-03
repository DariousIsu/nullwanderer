/*
 * lib/api_store.js — the API management stream's PERSISTENT snapshot store (its own isolated DB).
 *
 * Most of these APIs are SNAPSHOT sources that update slowly (monthly/quarterly econ series, annual census).
 * So we pull conservatively and PERSIST the latest snapshot per dataset — it survives restarts (you fetch GDP
 * once, it's good for a month), other sections read it with no network, and a content HASH gives cheap
 * change-detection so the "process into the DB like news" path only fires when the data actually moved.
 *
 * Physically separate from sq.db (like the news bucket): raw API payloads never pollute memory; only
 * processed/worthy data crosses into the DB via a later landing pass. Path: API_DB_PATH override else
 * data/api_stream.db. Lazy-opened, WAL.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.API_DB_PATH || path.join(__dirname, '..', 'data', 'api_stream.db');
let _db = null;
function get() {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  return _db;
}
function close() { if (_db) { try { _db.close(); } catch {} _db = null; } }

let _ready = false;
function ensureSchema() {
  if (_ready) return;
  get().exec(`
    CREATE TABLE IF NOT EXISTS api_snapshots (
      dataset_id  TEXT PRIMARY KEY,          -- one LATEST snapshot per dataset (upsert)
      api_id      TEXT NOT NULL,
      path        TEXT,
      params      TEXT,                       -- JSON
      body        TEXT,                       -- JSON (the raw response payload)
      hash        TEXT,                       -- content hash → change detection
      ok          INTEGER NOT NULL DEFAULT 1,
      status      INTEGER,
      fetched_ts  INTEGER NOT NULL,           -- when we last PULLED (freshness / cadence)
      changed_ts  INTEGER                     -- when the content last actually CHANGED (landing trigger)
    );
    CREATE INDEX IF NOT EXISTS idx_api_snapshots_api ON api_snapshots(api_id);
  `);
  // migration: landed_hash tracks the content last PROCESSED into memory (the landing pass), so a snapshot
  // is (re)landed only when its content actually changed — never re-processing an unchanged monthly series.
  try {
    const cols = get().prepare('PRAGMA table_info(api_snapshots)').all().map((c) => c.name);
    if (!cols.includes('landed_hash')) get().exec('ALTER TABLE api_snapshots ADD COLUMN landed_hash TEXT');
  } catch { /* fresh table */ }
  _ready = true;
}

const jparse = (s, d = null) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
function hashOf(v) { return crypto.createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v == null ? null : v)).digest('hex'); }

// Upsert the latest snapshot for a dataset. Returns { changed, changedTs, hash } — `changed` = the content
// differs from the stored snapshot (the signal the landing/processing pass keys on).
function putSnapshot(datasetId, { apiId, path: p = null, params = null, body = null, ok = true, status = null, now = Date.now() } = {}) {
  ensureSchema();
  if (!datasetId || !apiId) return { changed: false, error: 'need datasetId + apiId' };
  const h = hashOf(body);
  const prev = get().prepare('SELECT hash, changed_ts FROM api_snapshots WHERE dataset_id = ?').get(datasetId);
  const changed = !prev || prev.hash !== h;
  const changedTs = changed ? now : (prev.changed_ts || now);
  get().prepare(
    `INSERT INTO api_snapshots (dataset_id, api_id, path, params, body, hash, ok, status, fetched_ts, changed_ts)
     VALUES (@d, @a, @p, @params, @body, @h, @ok, @status, @fetched, @changed)
     ON CONFLICT(dataset_id) DO UPDATE SET
       api_id=@a, path=@p, params=@params, body=@body, hash=@h, ok=@ok, status=@status, fetched_ts=@fetched, changed_ts=@changed`
  ).run({
    d: datasetId, a: apiId, p, params: params ? JSON.stringify(params) : null, body: body != null ? JSON.stringify(body) : null,
    h, ok: ok ? 1 : 0, status, fetched: now, changed: changedTs,
  });
  return { changed, changedTs, hash: h };
}

// The latest snapshot for a dataset (parsed), or null. This is the read side of the raw-pull hook.
function getSnapshot(datasetId) {
  ensureSchema();
  const r = get().prepare('SELECT * FROM api_snapshots WHERE dataset_id = ?').get(datasetId);
  if (!r) return null;
  return { datasetId: r.dataset_id, apiId: r.api_id, path: r.path, params: jparse(r.params), body: jparse(r.body), hash: r.hash, ok: !!r.ok, status: r.status, fetched_ts: r.fetched_ts, changed_ts: r.changed_ts };
}

// Lightweight index of what's stored (no bodies) — the management/inventory view.
function listSnapshots() {
  ensureSchema();
  return get().prepare('SELECT dataset_id, api_id, ok, status, fetched_ts, changed_ts FROM api_snapshots ORDER BY fetched_ts DESC').all();
}

// Snapshots whose content changed at/after sinceMs — the landing pass reads these to process into the DB.
function changedSince(sinceMs) {
  ensureSchema();
  return get().prepare('SELECT dataset_id, api_id, changed_ts FROM api_snapshots WHERE ok = 1 AND changed_ts >= ? ORDER BY changed_ts DESC').all(sinceMs);
}

// Snapshots whose current content has NOT yet been landed into memory (new or changed since last landing).
// Full rows (parsed) — the DB-landing pass consumes these. Deterministic order (oldest change first).
function unlandedChanged() {
  ensureSchema();
  const rows = get().prepare('SELECT * FROM api_snapshots WHERE ok = 1 AND (landed_hash IS NULL OR landed_hash <> hash) ORDER BY changed_ts ASC').all();
  return rows.map((r) => ({ datasetId: r.dataset_id, apiId: r.api_id, path: r.path, params: jparse(r.params), body: jparse(r.body), hash: r.hash, status: r.status, fetched_ts: r.fetched_ts, changed_ts: r.changed_ts }));
}
// Mark a dataset's content as landed (processed into memory) so it isn't re-landed until it changes again.
function markLanded(datasetId, hash) {
  ensureSchema();
  return get().prepare('UPDATE api_snapshots SET landed_hash = ? WHERE dataset_id = ?').run(String(hash || ''), datasetId).changes;
}

module.exports = { get, close, ensureSchema, hashOf, putSnapshot, getSnapshot, listSnapshots, changedSince, unlandedChanged, markLanded, DB_PATH };
