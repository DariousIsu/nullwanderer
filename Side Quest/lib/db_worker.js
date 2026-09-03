'use strict';
/**
 * lib/db_worker.js — read-only SQL OFF the main thread.
 *
 * THE DISEASE (the 01:24 freeze, §89): synchronous better-sqlite3 on the Electron main thread. Cuts 1–5
 * cured statements by making them CHEAP (partial indexes, pins, the sweep's pool). Some statements cannot
 * be made cheap: the encounters single-source ranking is a GROUP BY over 1.49M rows (14.7s on p256, the
 * largest single block of the night) and the tenant backlog is three COUNT(*)s over ~146k proposals (~1s
 * each). They are RIGHT, they are just big — and both feed a CACHE, not a reply. A cache refresh has no
 * business on the main thread.
 *
 * One worker_thread per database file, started on first use, holding its OWN read-only connection (WAL:
 * a reader never blocks the writer, and the main thread keeps the only pen). One statement per request;
 * rows come back as plain objects. An error or a timeout REJECTS — the caller keeps its stale cache — and a
 * timed-out worker is dropped (a stuck native call cannot wedge the lane for the next request). Workers are
 * unref'd so they never hold the process open.
 */
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const DEFAULT_TIMEOUT_MS = 120000;
const _workers = new Map();   // dbPath → { w, pending: Map<id, { resolve, reject, timer }>, seq }

function _drop(dbPath, entry, err) {
  for (const [, p] of entry.pending) { clearTimeout(p.timer); p.reject(err); }
  entry.pending.clear();
  if (_workers.get(dbPath) === entry) _workers.delete(dbPath);   // a replacement may already be live — never delete it
  const w = entry.w; entry.w = null;
  if (w) { try { w.terminate().catch(() => {}); } catch {} }
}

function _get(dbPath) {
  const have = _workers.get(dbPath);
  if (have && have.w) return have;
  const entry = { w: null, pending: new Map(), seq: 0 };
  const w = new Worker(__filename, { workerData: { __dbWorker: true, dbPath } });
  w.unref();
  w.on('message', (m) => {
    const p = entry.pending.get(m.id);
    if (!p) return;                                   // a reply to a request that already timed out
    entry.pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.rows);
  });
  w.on('error', (e) => _drop(dbPath, entry, e instanceof Error ? e : new Error(String(e))));
  w.on('exit', (code) => _drop(dbPath, entry, new Error(`db worker exited (${code})`)));
  entry.w = w;
  _workers.set(dbPath, entry);
  return entry;
}

/**
 * Run `sql` read-only in the worker for `dbPath`. mode 'all' → rows[]; 'get' → one row or null.
 * Rejects on a SQLite error, a missing file, or after `timeoutMs`.
 */
function query(dbPath, sql, params = [], { timeoutMs = DEFAULT_TIMEOUT_MS, mode = 'all' } = {}) {
  return new Promise((resolve, reject) => {
    let entry;
    try { entry = _get(String(dbPath)); } catch (err) { return reject(err); }
    const id = ++entry.seq;
    const timer = setTimeout(() => {
      if (!entry.pending.has(id)) return;
      entry.pending.delete(id);
      reject(new Error(`db worker timeout after ${timeoutMs}ms`));
      _drop(String(dbPath), entry, new Error('db worker dropped after a timeout'));
    }, timeoutMs);
    timer.unref?.();
    entry.pending.set(id, { resolve, reject, timer });
    try { entry.w.postMessage({ id, sql: String(sql), params: Array.isArray(params) ? params : [], mode: mode === 'get' ? 'get' : 'all' }); }
    catch (err) { entry.pending.delete(id); clearTimeout(timer); reject(err); }
  });
}

/** Stop the worker for one file (pending requests reject). Resolves when the thread has exited. */
async function close(dbPath) {
  const entry = _workers.get(String(dbPath));
  if (!entry) return;
  const w = entry.w;
  _drop(String(dbPath), entry, new Error('db worker closed'));
  if (w) { try { await w.terminate(); } catch {} }
}
async function closeAll() { for (const p of [...(_workers.keys())]) await close(p); }
function _live() { return [..._workers.keys()]; }

module.exports = { query, close, closeAll, DEFAULT_TIMEOUT_MS, _live };

// ── worker entry: this module re-runs in the thread with workerData set ─────────────────────────
try {
  if (!isMainThread && workerData && workerData.__dbWorker) {
    const Database = require('better-sqlite3');
    let db = null;
    const open = () => {
      if (!db) {
        db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
        try { db.pragma('busy_timeout = 5000'); } catch {}
      }
      return db;
    };
    parentPort.on('message', (m) => {
      try {
        const stmt = open().prepare(m.sql);
        const rows = m.mode === 'get' ? stmt.get(...m.params) : stmt.all(...m.params);
        parentPort.postMessage({ id: m.id, rows: rows === undefined ? null : rows });
      } catch (e) { parentPort.postMessage({ id: m.id, error: (e && e.message) || String(e) }); }
    });
  }
} catch { /* not a worker context */ }
