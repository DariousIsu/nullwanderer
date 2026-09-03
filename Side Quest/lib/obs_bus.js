/**
 * lib/obs_bus.js — the AUTONOMY OBSERVABILITY BUS (Lucas 2026-07-30: "a visual log of this
 * autonomous system, her logs as they stream and her thoughts and decisions about them").
 *
 * ONE bounded, structured event stream that both consumers read:
 *   • the INTERFACE (a visual log window built in a parallel lane) — poll `recent({sinceId})`
 *     over IPC 'obs:recent', or ride the live 'obs:event' broadcast; contract in
 *     docs/OBS_INTERFACE_HOOKS.md;
 *   • HER OWN self-watch organ (lib/self_watch) — the same events feed anomaly counting and
 *     capability-need minting, so the thing Lucas watches and the thing she reasons about are
 *     one stream, never two drifting copies.
 *
 * VOLUME DISCIPLINE (the route_obs lesson — a write-only pool grew to 2.6M rows and its sync
 * inserts stalled the main thread): writes are BATCHED (in-memory buffer, one transaction per
 * flush tick), the store is CAPPED (prune to MAX_ROWS / MAX_AGE on a write cadence), text is
 * clamped, and this table has READERS from birth. emit() never touches the DB synchronously.
 *
 * Fail-soft everywhere: a broken emit must never take an organ down with it.
 */
'use strict';

const MAX_ROWS = 20000;
const MAX_AGE_MS = 7 * 24 * 3600e3;
const FLUSH_MS = 1500;
const PRUNE_EVERY = 20;          // prune on every Nth flush
const TEXT_CAP = 500;
const DATA_CAP = 2000;

const LEVELS = new Set(['info', 'warn', 'error']);

function _db(deps) { return (deps && deps.db) || require('./db'); }

let _ready = false;
function _ensure(deps) {
  const d = _db(deps).getDb();
  if (!_ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS obs_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      lane TEXT NOT NULL,
      kind TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      text TEXT NOT NULL,
      ref TEXT,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_obs_events_lane_id ON obs_events(lane, id);
    CREATE INDEX IF NOT EXISTS idx_obs_events_ts ON obs_events(ts);`);   // the age prune runs every 20th flush (30s); by ts it scanned all 20k rows (1.8s on p257) — a range now
    _ready = true;
  }
  return d;
}

// ── emit + buffered flush ─────────────────────────────────────────────────────────────────────
let _buf = [];
let _timer = null;
let _flushCount = 0;
const _listeners = new Set();

function emit({ lane, kind, level = 'info', text, ref = null, data = null } = {}, { deps = {}, nowMs = Date.now() } = {}) {
  const l = String(lane || '').trim().toLowerCase();
  const k = String(kind || '').trim().toLowerCase();
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_CAP);
  if (!l || !k || !t) return null;
  const lv = LEVELS.has(level) ? level : 'info';
  let dj = null;
  if (data != null) { try { dj = JSON.stringify(data).slice(0, DATA_CAP); } catch {} }
  const evt = { ts: nowMs, lane: l, kind: k, level: lv, text: t, ref: ref ? String(ref).slice(0, 80) : null, data: dj };
  _buf.push({ evt, deps });
  // Live listeners see the event NOW (no id yet — the poll path carries ids); a listener that
  // throws is that listener's problem, never the emitter's.
  for (const fn of _listeners) { try { fn(evt); } catch {} }
  if (!_timer) {
    _timer = setInterval(() => { try { flush(); } catch {} }, FLUSH_MS);
    if (_timer.unref) _timer.unref();
  }
  return evt;
}

function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function flush({ deps = {} } = {}) {
  if (!_buf.length) return 0;
  const batch = _buf; _buf = [];
  const useDeps = batch[0].deps && batch[0].deps.db ? batch[0].deps : deps;
  let n = 0;
  try {
    const d = _ensure(useDeps);
    const ins = d.prepare('INSERT INTO obs_events (ts, lane, kind, level, text, ref, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const tx = d.transaction((rows) => { for (const { evt } of rows) { ins.run(evt.ts, evt.lane, evt.kind, evt.level, evt.text, evt.ref, evt.data); n++; } });
    tx(batch);
    _flushCount++;
    if (_flushCount % PRUNE_EVERY === 0) prune({ deps: useDeps });
  } catch (e) { try { console.error('[obs] flush failed:', e.message); } catch {} }
  return n;
}

function prune({ deps = {}, nowMs = Date.now() } = {}) {
  try {
    const d = _ensure(deps);
    d.prepare('DELETE FROM obs_events WHERE ts < ?').run(nowMs - MAX_AGE_MS);
    const hi = d.prepare('SELECT MAX(id) m FROM obs_events').get();
    if (hi && hi.m) d.prepare('DELETE FROM obs_events WHERE id <= ?').run(hi.m - MAX_ROWS);
  } catch {}
}

// ── the reader (the interface's poll surface) ─────────────────────────────────────────────────
// Tail semantics: id > sinceId, ascending, capped — the standard incremental-poll contract.
function recent({ sinceId = 0, lanes = null, kinds = null, limit = 200 } = {}, { deps = {} } = {}) {
  try {
    const d = _ensure(deps);
    const cap = Math.max(1, Math.min(500, Number(limit) || 200));
    const where = ['id > ?']; const args = [Number(sinceId) || 0];
    const laneList = Array.isArray(lanes) ? lanes.filter(Boolean).map(String) : null;
    if (laneList && laneList.length) { where.push(`lane IN (${laneList.map(() => '?').join(',')})`); args.push(...laneList); }
    const kindList = Array.isArray(kinds) ? kinds.filter(Boolean).map(String) : null;
    if (kindList && kindList.length) { where.push(`kind IN (${kindList.map(() => '?').join(',')})`); args.push(...kindList); }
    const rows = d.prepare(`SELECT * FROM obs_events WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ${cap}`).all(...args);
    return rows.map((r) => { let data = null; try { data = r.data ? JSON.parse(r.data) : null; } catch {} return { ...r, data }; });
  } catch { return []; }
}

// The NEWEST n events (ascending order after the cut) — the "what just happened" reader.
// recent() is the tail-poll cursor (oldest-first from sinceId — a backfill walks it); this is
// for consumers that want the last few things regardless of cursor (the subc's anomaly sources,
// the exhaust audit). The parallel UI lane hit exactly this gap on day one.
function latest({ lanes = null, kinds = null, limit = 20 } = {}, { deps = {} } = {}) {
  try {
    const d = _ensure(deps);
    const cap = Math.max(1, Math.min(200, Number(limit) || 20));
    const where = ['1=1']; const args = [];
    const laneList = Array.isArray(lanes) ? lanes.filter(Boolean).map(String) : null;
    if (laneList && laneList.length) { where.push(`lane IN (${laneList.map(() => '?').join(',')})`); args.push(...laneList); }
    const kindList = Array.isArray(kinds) ? kinds.filter(Boolean).map(String) : null;
    if (kindList && kindList.length) { where.push(`kind IN (${kindList.map(() => '?').join(',')})`); args.push(...kindList); }
    const rows = d.prepare(`SELECT * FROM obs_events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${cap}`).all(...args).reverse();
    return rows.map((r) => { let data = null; try { data = r.data ? JSON.parse(r.data) : null; } catch {} return { ...r, data }; });
  } catch { return []; }
}

// Test/shutdown helper — stop the timer so a smoke's process can exit clean.
function _stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { emit, subscribe, flush, prune, recent, latest, _stop, MAX_ROWS, MAX_AGE_MS };
