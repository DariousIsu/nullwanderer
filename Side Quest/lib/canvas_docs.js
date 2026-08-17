/**
 * lib/canvas_docs.js — Zoe Canvas DURABILITY: the documents themselves, so a restart doesn't blank the board.
 *
 * The engine's canvas is IN-MEMORY ONLY (echo/saga/canvas_publisher keeps _TABS/_BLOCKS in module globals and
 * GET /canvas serves exactly those). Its `_persist_*_to_tenant` mirror does NOT apply to us: `_tenant_conn()`
 * returns None unless the store is a TenantStore, which is false on Saga's own process — the process we run.
 * So every engine restart wiped the board, and the only restore was a boot sweep over
 * data/zoe_workspace/notes/directed-*.md, which covers her research runs and NOTHING the operator dropped.
 * Drop a contract on the canvas, restart, and it was simply gone.
 *
 * This is the Side-Quest-owned durable copy: every block we write to the engine is mirrored here, and on boot
 * main replays it back. Content still belongs to the engine at runtime — this is a write-through log so we can
 * rebuild it, not a second source of truth.
 *
 * Own sqlite file (data/canvas_docs.db), isolated, purely local. CANVAS_DOCS_DB_PATH overrides for smokes;
 * ':memory:' supported. Sibling of lib/canvas_layout.js (which owns WHERE a doc sits; this owns WHAT it is).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_ROOT, 'data');

// A dropped image/PDF rides as a base64 data URI and can be huge. Mirror generously but not without limit —
// past this a block is left un-mirrored (it won't survive a restart) rather than bloating the store forever.
const MAX_BLOCK_BYTES = 12 * 1024 * 1024;
// Keep the most recently touched documents; older ones age out with their blocks.
const KEEP_DOCS = 60;

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  tab_key    TEXT PRIMARY KEY,
  mode       TEXT NOT NULL,
  title      TEXT,
  opened_at  INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
  block_id   TEXT PRIMARY KEY,
  tab_key    TEXT NOT NULL,
  block_type TEXT NOT NULL,
  data       TEXT NOT NULL,
  position   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_tab ON blocks(tab_key, position);
`;

function init(opts = {}) {
  if (db) return db;
  const dbPath = opts.path || process.env.CANVAS_DOCS_DB_PATH || path.join(DATA_DIR, 'canvas_docs.db');
  if (dbPath !== ':memory:') { try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch {} }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
function _db() { return db || init(); }
function close() { if (db) { try { db.close(); } catch {} db = null; } }
const now = () => Date.now();
const str = (v) => (v == null ? '' : String(v));

// Record a tab. Idempotent: re-opening keeps the original opened_at (ordering stays stable across restarts)
// but refreshes the title/mode, which can legitimately change as a run names itself.
function recordTab({ tabKey, mode = 'DOC', title = '' } = {}) {
  const key = str(tabKey);
  if (!key) return false;
  _db().prepare(
    `INSERT INTO docs (tab_key, mode, title, opened_at, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(tab_key) DO UPDATE SET mode=excluded.mode, title=excluded.title, updated_at=excluded.updated_at`
  ).run(key, str(mode) || 'DOC', str(title), now(), now());
  return true;
}

// Mirror a block. Upsert on block_id, so the live-grow path (add once, then patch in place) converges on the
// block's CURRENT content rather than accumulating revisions. New blocks append at the end of the tab.
function recordBlock({ tabKey, blockId, blockType = 'paragraph', data = {} } = {}) {
  const key = str(tabKey), id = str(blockId);
  if (!key || !id) return false;
  let payload;
  try { payload = JSON.stringify(data || {}); } catch { return false; }
  if (payload.length > MAX_BLOCK_BYTES) return false;
  const d = _db();
  const existing = d.prepare(`SELECT position FROM blocks WHERE block_id = ?`).get(id);
  const position = existing ? existing.position
    : ((d.prepare(`SELECT MAX(position) AS m FROM blocks WHERE tab_key = ?`).get(key) || {}).m ?? -1) + 1;
  d.prepare(
    `INSERT INTO blocks (block_id, tab_key, block_type, data, position, updated_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(block_id) DO UPDATE SET tab_key=excluded.tab_key, block_type=excluded.block_type,
       data=excluded.data, updated_at=excluded.updated_at`
  ).run(id, key, str(blockType), payload, position, now());
  d.prepare(`UPDATE docs SET updated_at = ? WHERE tab_key = ?`).run(now(), key);
  return true;
}

// Drop every mirrored block of one tab (2026-08-08, the stacked parish tab): a whole-document
// re-emit REPLACES the doc, and the durability mirror must match — otherwise the boot replay
// resurrects every superseded revision as extra blocks under the current one.
function clearTabBlocks(tabKey) {
  const key = str(tabKey);
  if (!key) return 0;
  try { return _db().prepare(`DELETE FROM blocks WHERE tab_key = ?`).run(key).changes; } catch { return 0; }
}

// Every stored document, oldest-opened first, each with its blocks in stream order — the replay list.
function all() {
  const d = _db();
  const blocksByTab = {};
  for (const b of d.prepare(`SELECT * FROM blocks ORDER BY tab_key, position`).all()) {
    let data = {};
    try { data = JSON.parse(b.data); } catch { data = {}; }
    (blocksByTab[b.tab_key] = blocksByTab[b.tab_key] || []).push({ blockId: b.block_id, blockType: b.block_type, data });
  }
  return d.prepare(`SELECT * FROM docs ORDER BY opened_at ASC`).all().map((t) => ({
    tabKey: t.tab_key, mode: t.mode, title: t.title, openedAt: t.opened_at,
    blocks: blocksByTab[t.tab_key] || [],
  }));
}

function forget(tabKey) {
  const key = str(tabKey);
  if (!key) return 0;
  _db().prepare(`DELETE FROM blocks WHERE tab_key = ?`).run(key);
  return _db().prepare(`DELETE FROM docs WHERE tab_key = ?`).run(key).changes;
}

// Age out all but the `keep` most recently touched documents.
function prune({ keep = KEEP_DOCS } = {}) {
  const d = _db();
  const doomed = d.prepare(`SELECT tab_key FROM docs ORDER BY updated_at DESC LIMIT -1 OFFSET ?`).all(Math.max(0, keep));
  for (const r of doomed) forget(r.tab_key);
  return doomed.length;
}

function clear() {
  _db().prepare(`DELETE FROM blocks`).run();
  return _db().prepare(`DELETE FROM docs`).run().changes;
}

// Most-recent canvas write timestamp (ms). recordBlock bumps docs.updated_at, so MAX reflects any block
// write. Cheap single-row query — used by the anti-fabrication reply gate to check "did a canvas write
// actually happen this turn?" before trusting a reply's "…on your canvas" claim. 0 if none / on error.
function lastWriteTs() { try { const r = _db().prepare('SELECT MAX(updated_at) AS m FROM docs').get(); return (r && r.m) || 0; } catch { return 0; } }

// The TITLES + body text of every doc written since `sinceTs` (each doc's title + ALL its blocks) — the
// evidence for the anti-fab CONTENT check ("did the landed doc actually match the claim, or was a wrong doc
// mislabeled?", the #12338 fabrication). Crucially UNIONS all this-turn docs + all their blocks so a real
// multi-doc / multi-block delivery is never false-scolded (a claim about doc A finds A's text even when doc B
// is newest). sinceTs=0 → just the single newest doc (back-compat). Fail-soft → ''.
function lastWriteText(sinceTs = 0) {
  try {
    const d = _db();
    const docs = sinceTs > 0
      ? d.prepare('SELECT tab_key, title FROM docs WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 6').all(sinceTs)
      : (() => { const o = d.prepare('SELECT tab_key, title FROM docs ORDER BY updated_at DESC LIMIT 1').get(); return o ? [o] : []; })();
    if (!docs.length) return '';
    const CAP = 8000;
    let out = '';
    const add = (t) => { if (t && out.length < CAP) out += ' ' + String(t); };
    for (const doc of docs) {
      if (out.length >= CAP) break;
      add(doc.title);
      try {
        const blks = d.prepare('SELECT data FROM blocks WHERE tab_key = ? ORDER BY position LIMIT 30').all(doc.tab_key);
        for (const blk of blks) {
          if (out.length >= CAP) break;
          if (!blk || !blk.data) continue;
          let body = '';
          try { const j = JSON.parse(blk.data); body = String(j.markdown || j.text || (Array.isArray(j.headers) ? [].concat(j.headers, ...((j.rows || []).slice(0, 40))).join(' ') : '') || ''); }
          catch { body = String(blk.data).slice(0, 500); }
          add(body);
        }
      } catch {}
    }
    return out.slice(0, CAP).trim();
  } catch { return ''; }
}

module.exports = { init, _db, close, recordTab, recordBlock, clearTabBlocks, all, forget, prune, clear, lastWriteTs, lastWriteText, MAX_BLOCK_BYTES, KEEP_DOCS };
