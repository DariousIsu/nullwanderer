/**
 * lib/canvas_layout.js — Zoe Canvas freeform board: operator's saved DOCUMENT layout state.
 *
 * The canvas is one infinite surface; the movable objects are whole DOCUMENTS (each = a saga tab).
 * This stores the operator's per-document UI state — position (x,y), size (w,h), and hidden /
 * minimized flags — keyed by doc_key (the tab_key). Content is Echo's; this spatial/UI layer is
 * Side-Quest-owned. Documents with no saved position get a deterministic auto-slot
 * (studio/canvas_layout.autoPlace). "She places (auto) → you move / resize / arrange (saved)."
 *
 * Own sqlite file (data/canvas_layout.db), isolated — purely local UI state, never sent anywhere.
 * CANVAS_LAYOUT_DB_PATH overrides for smokes; ':memory:' supported.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_ROOT, 'data');
const MIN_W = 240, MIN_H = 120;

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS doc_positions (
  doc_key    TEXT PRIMARY KEY,
  x          INTEGER,
  y          INTEGER,
  w          INTEGER,
  h          INTEGER,
  hidden     INTEGER NOT NULL DEFAULT 0,
  minimized  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`;

// Add columns missing from an older (x,y-only) doc_positions so upgrades don't lose saved positions.
function migrate(d) {
  let info = [];
  try { info = d.prepare(`PRAGMA table_info(doc_positions)`).all(); } catch { return; }
  const cols = info.map(c => c.name);
  const add = (name, decl) => { if (!cols.includes(name)) { try { d.exec(`ALTER TABLE doc_positions ADD COLUMN ${name} ${decl}`); } catch {} } };
  add('w', 'INTEGER'); add('h', 'INTEGER');
  add('hidden', 'INTEGER NOT NULL DEFAULT 0'); add('minimized', 'INTEGER NOT NULL DEFAULT 0');

  // RELAX x/y TO NULLABLE. The first version of this table was x,y-only and declared both NOT NULL;
  // migrate() only ever ADDED columns, so live databases kept that constraint while SCHEMA above has
  // long declared them nullable. update() legitimately writes x=NULL — a doc that has never been
  // dragged but is being resized, hidden or minimized carries no position — so every such patch died:
  //
  //   [canvas] update-doc failed: NOT NULL constraint failed: doc_positions.x
  //
  // firing repeatedly on 2026-07-21. SQLite cannot drop a NOT NULL in place, so rebuild the table and
  // copy the rows. Guarded on the constraint actually being present, wrapped in a transaction, and
  // fail-soft: a failed migration leaves the old table exactly as it was.
  const xCol = info.find(c => c.name === 'x');
  if (xCol && xCol.notnull) {
    try {
      d.exec('BEGIN');
      d.exec(`CREATE TABLE doc_positions_new (
        doc_key    TEXT PRIMARY KEY,
        x          INTEGER,
        y          INTEGER,
        w          INTEGER,
        h          INTEGER,
        hidden     INTEGER NOT NULL DEFAULT 0,
        minimized  INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`);
      d.exec(`INSERT INTO doc_positions_new (doc_key, x, y, w, h, hidden, minimized, updated_at)
              SELECT doc_key, x, y, w, h, hidden, minimized, updated_at FROM doc_positions`);
      d.exec('DROP TABLE doc_positions');
      d.exec('ALTER TABLE doc_positions_new RENAME TO doc_positions');
      d.exec('COMMIT');
      console.log('[canvas-layout] migrated doc_positions: x/y are nullable — a doc can be resized or hidden before it is ever placed');
    } catch (e) {
      try { d.exec('ROLLBACK'); } catch {}
      try { d.exec('DROP TABLE IF EXISTS doc_positions_new'); } catch {}
      console.error('[canvas-layout] x/y migration failed, leaving the table as-is:', e.message);
    }
  }
}

function init(opts = {}) {
  if (db) return db;
  const dbPath = opts.path || process.env.CANVAS_LAYOUT_DB_PATH || path.join(DATA_DIR, 'canvas_layout.db');
  if (dbPath !== ':memory:') { try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch {} }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
function _db() { return db || init(); }
function close() { if (db) { try { db.close(); } catch {} db = null; } }
const now = () => Date.now();
const iOrNull = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : null; };       // x,y: any int
const dimOrNull = (v, min) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, n) : null; };  // w,h: clamped

function rowToState(r) {
  if (!r) return null;
  return { x: r.x, y: r.y, w: r.w, h: r.h, hidden: !!r.hidden, minimized: !!r.minimized };
}
function get(docKey) { return rowToState(_db().prepare(`SELECT * FROM doc_positions WHERE doc_key = ?`).get(String(docKey || ''))); }

// Full layout state, as { docKey: {x,y,w,h,hidden,minimized} }. (autoPlace reads only x,y.)
function getPositions() {
  const out = {};
  for (const r of _db().prepare(`SELECT * FROM doc_positions`).all()) out[r.doc_key] = rowToState(r);
  return out;
}

// Merge a partial UI-state patch for a document (position / size / hidden / minimized). Upsert.
function update(docKey, patch = {}) {
  if (!docKey) throw new Error('update: docKey required');
  const cur = get(docKey) || {};
  const next = { ...cur, ...patch };
  const x = iOrNull(next.x), y = iOrNull(next.y), w = dimOrNull(next.w, MIN_W), h = dimOrNull(next.h, MIN_H);
  const hidden = next.hidden ? 1 : 0, minimized = next.minimized ? 1 : 0;
  _db().prepare(
    `INSERT INTO doc_positions (doc_key, x, y, w, h, hidden, minimized, updated_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(doc_key) DO UPDATE SET x=excluded.x, y=excluded.y, w=excluded.w, h=excluded.h,
       hidden=excluded.hidden, minimized=excluded.minimized, updated_at=excluded.updated_at`
  ).run(String(docKey), x, y, w, h, hidden, minimized, now());
  return get(docKey);
}

// Back-compat convenience used by the drag handler.
function setPosition(docKey, x, y) { return update(docKey, { x, y }); }

// Reset: drop one document's saved state, or all of them (no arg).
function clear(docKey) {
  if (docKey) return _db().prepare(`DELETE FROM doc_positions WHERE doc_key = ?`).run(String(docKey)).changes;
  return _db().prepare(`DELETE FROM doc_positions`).run().changes;
}

// Drop saved state for documents that no longer exist — GHOST rows. Every document ever placed left a row
// here forever, including the ephemeral ones the engine lost on each restart, so this table accumulated
// hundreds of entries for tabs nothing can ever show again (205 of them by 2026-07-20). `liveKeys` is the
// set of documents that still exist; anything else is swept. Refuses to run on an EMPTY live set — that
// means the caller couldn't enumerate documents, and deleting everything on a failed lookup would throw
// away the operator's whole arrangement.
function clearMissing(liveKeys) {
  const keys = Array.isArray(liveKeys) ? liveKeys.map(String).filter(Boolean) : [];
  if (!keys.length) return 0;
  const live = new Set(keys);
  const doomed = _db().prepare(`SELECT doc_key FROM doc_positions`).all().map(r => r.doc_key).filter(k => !live.has(k));
  const del = _db().prepare(`DELETE FROM doc_positions WHERE doc_key = ?`);
  for (const k of doomed) del.run(k);
  return doomed.length;
}

module.exports = { init, _db, close, get, getPositions, update, setPosition, clear, clearMissing, MIN_W, MIN_H };
