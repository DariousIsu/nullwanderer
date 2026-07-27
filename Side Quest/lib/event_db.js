/**
 * lib/event_db.js — the Event-Ingest Lane's OWN idempotency ledger.
 *
 * Why its own file (mirrors news_db.js, Lucas 2026-07-02 "raw buckets stay physically separate from
 * sq.db"): the event lane pulls the SAME convenings every pass (a city-council calendar re-lists the
 * same meeting for weeks). Without a durable "already landed this one" ledger, every nightly pass would
 * re-propose every convening — burning Echo writes and leaning on name-dedup to paper over it. This
 * table is the lane's memory of what it has already turned into an Echo `event` object, keyed on the
 * SOURCE's stable id (Legistar EventId / gcal event id), so a re-list is a cheap skip, not a re-write.
 *
 * It holds ONLY the ledger — the convenings themselves live in Echo (the public graph) once landed.
 * The row records the Echo ref + the temporal state we set, so a later pass can detect a convening that
 * MOVED (start-time changed) or FLIPPED scheduled→occurred and update just that, without a full re-land.
 *
 * Path: EVENT_DB_PATH env override (smokes/tests use a temp file) else data/event_lane.db. Lazy-opened.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.EVENT_DB_PATH || path.join(__dirname, '..', 'data', 'event_lane.db');
let _db = null;
let _schemaReady = false;

function get() {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  return _db;
}

function ensureSchema() {
  if (_schemaReady) return;
  get().exec(`
    CREATE TABLE IF NOT EXISTS event_ledger (
      ext_id      TEXT PRIMARY KEY,   -- "<source>:<stable source id>" — the idempotency key
      source      TEXT NOT NULL,      -- 'legistar' | 'gcal' | ...
      name        TEXT NOT NULL,      -- the convening name landed into Echo
      entity_ref  TEXT,              -- public Echo entity id once landed (null = proposed but not yet public → retry)
      occurred_at INTEGER,           -- epoch SECONDS (Echo's clock) — the start we set on the object
      event_state TEXT,              -- 'scheduled' (future) | 'occurred' (past) as of the landing pass
      first_seen  INTEGER NOT NULL,  -- epoch ms this convening first entered the lane
      updated     INTEGER NOT NULL   -- epoch ms of the last land/update
    );
    CREATE INDEX IF NOT EXISTS idx_event_ledger_source ON event_ledger(source, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_event_ledger_state ON event_ledger(event_state);
  `);
  _schemaReady = true;
}

// The ledger row for a source id, or null if this convening has never been landed.
function seen(extId) {
  ensureSchema();
  return get().prepare('SELECT * FROM event_ledger WHERE ext_id = ?').get(String(extId)) || null;
}

// Upsert the ledger after a land/update. entity_ref may be null (proposed, promotion pending → retried).
function record({ extId, source, name, entityRef = null, occurredAt = null, eventState = null, now = Date.now() }) {
  ensureSchema();
  get().prepare(
    `INSERT INTO event_ledger (ext_id, source, name, entity_ref, occurred_at, event_state, first_seen, updated)
     VALUES (@e, @s, @n, @r, @o, @st, @now, @now)
     ON CONFLICT(ext_id) DO UPDATE SET
       name=@n, entity_ref=COALESCE(@r, entity_ref), occurred_at=@o, event_state=@st, updated=@now`
  ).run({ e: String(extId), s: String(source), n: String(name), r: entityRef != null ? String(entityRef) : null,
    o: occurredAt != null ? Math.floor(occurredAt) : null, st: eventState, now });
}

function close() { if (_db) { try { _db.close(); } catch {} _db = null; _schemaReady = false; } }

module.exports = { get, ensureSchema, seen, record, close, DB_PATH };
