/**
 * lib/board.js — THE WORKSTREAM BOARD + resource locks (conductor slice 2a, 2026-07-22).
 *
 * The audit's goal-2 finding: "what is running in me now" was per-lane console logs — three
 * independent work-pickers that cannot see each other, kept from colliding only by HARD YIELDS that
 * prevent exactly the concurrency Lucas wants (clean the database + explore ideas + write a paper +
 * brainstorm with him, all at once). This is the shared surface both problems resolve onto:
 *
 *   - Every discrete lane run REGISTERS: start() → beat() → finish(). The board is the one queryable
 *     answer to "what are you doing?" (chat's current-activity source + the autonomy manifest both
 *     render it), and the substrate the slice-2b conductor allocates against.
 *   - Concurrency is bounded by RESOURCE CLASSES, not politeness: cloud_slot_1 belongs to the CHAT,
 *     permanently (what makes simultaneous brainstorming safe); cloud_slot_2/3 are allocatable;
 *     db_maintenance:<store> admits one maintenance pass per store; research reads ride alongside.
 *   - Crashes self-heal by HEARTBEAT: a running row or lock whose heartbeat goes stale (5 min) is
 *     swept failed / expired at the next read — a crashed lane can never wedge a slot shut.
 *
 * Thin wrapper over sq.db (tables in lib/db MIGRATIONS). Every function fail-safe: board bookkeeping
 * must never take down the lane doing the actual work. Deps-injectable db → offline-smokeable.
 */
'use strict';

const STALE_MS = 5 * 60 * 1000;            // no heartbeat for this long = the holder is gone
const RESERVED_SLOT = 'cloud_slot_1';       // the chat's, permanently — never allocatable
const CLOUD_POOL = ['cloud_slot_2', 'cloud_slot_3'];
const dbMaintenance = (store) => `db_maintenance:${String(store || 'sq').toLowerCase()}`;

function _db(deps) { return (deps && deps.db) || require('./db'); }

// Sweep crashed state first so every read sees truth: stale running rows → failed, stale locks → gone.
function sweep({ deps = {}, nowMs = Date.now() } = {}) {
  try {
    const d = _db(deps).getDb();
    const cut = nowMs - STALE_MS;
    const swept = d.prepare(`UPDATE workstreams SET status = 'failed', note = COALESCE(note || '; ', '') || 'stale (no heartbeat)', finished_ts = ? WHERE status = 'running' AND heartbeat_ts < ?`).run(nowMs, cut).changes;
    const expired = d.prepare('DELETE FROM resource_locks WHERE heartbeat_ts < ?').run(cut).changes;
    return { swept, expired };
  } catch (e) { console.error('[board] sweep failed:', e.message); return { swept: 0, expired: 0 }; }
}

// Take a lock. Returns true when held. A live holder blocks; a stale one was already swept.
function acquire(resource, { lane = '?', streamId = null, deps = {}, nowMs = Date.now() } = {}) {
  if (!resource) return true;                       // no resource requested = nothing to hold
  if (resource === RESERVED_SLOT) return false;     // the chat's slot is not allocatable, ever
  try {
    sweep({ deps, nowMs });
    const d = _db(deps).getDb();
    const info = d.prepare(`INSERT INTO resource_locks (resource, holder_stream, holder_lane, since_ts, heartbeat_ts)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(resource) DO NOTHING`).run(resource, streamId, lane, nowMs, nowMs);
    return info.changes > 0;
  } catch (e) { console.error('[board] acquire failed:', e.message); return false; }
}

function release(resource, { deps = {} } = {}) {
  if (!resource) return;
  try { _db(deps).getDb().prepare('DELETE FROM resource_locks WHERE resource = ?').run(resource); }
  catch (e) { console.error('[board] release failed:', e.message); }
}

// First free slot from the allocatable pool (never the reserved one). null = both busy → skip, retry
// next tick; contention resolves by time, not queueing (idle work has no right to wait in line).
function acquireCloudSlot({ lane = '?', streamId = null, deps = {}, nowMs = Date.now() } = {}) {
  for (const slot of CLOUD_POOL) if (acquire(slot, { lane, streamId, deps, nowMs })) return slot;
  return null;
}

// Register a run. With `resource`, registration and the lock are one decision: blocked → no row,
// {id:null, blocked:true} — a run that can't have its resource must not claim to be running.
function start({ lane, kind = null, target = null, resource = null, note = null, deps = {}, nowMs = Date.now() } = {}) {
  if (!lane) return { id: null, blocked: false };
  try {
    if (resource && !acquire(resource, { lane, deps, nowMs })) return { id: null, blocked: true, resource };
    const d = _db(deps).getDb();
    const info = d.prepare(`INSERT INTO workstreams (lane, kind, target, status, resource, note, started_ts, heartbeat_ts)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`).run(lane, kind, String(target || '').slice(0, 200) || null, resource, note, nowMs, nowMs);
    if (resource) { try { d.prepare('UPDATE resource_locks SET holder_stream = ? WHERE resource = ?').run(info.lastInsertRowid, resource); } catch {} }
    return { id: info.lastInsertRowid, blocked: false, resource };
  } catch (e) { console.error('[board] start failed:', e.message); return { id: null, blocked: false }; }
}

function beat(id, { deps = {}, nowMs = Date.now() } = {}) {
  if (!id) return;
  try {
    const d = _db(deps).getDb();
    d.prepare('UPDATE workstreams SET heartbeat_ts = ? WHERE id = ? AND status = ?').run(nowMs, id, 'running');
    d.prepare('UPDATE resource_locks SET heartbeat_ts = ? WHERE holder_stream = ?').run(nowMs, id);
  } catch (e) { console.error('[board] beat failed:', e.message); }
}

function finish(id, { status = 'done', note = null, deps = {}, nowMs = Date.now() } = {}) {
  if (!id) return;
  try {
    const d = _db(deps).getDb();
    const row = d.prepare('SELECT resource FROM workstreams WHERE id = ?').get(id);
    d.prepare(`UPDATE workstreams SET status = ?, note = COALESCE(?, note), finished_ts = ?, heartbeat_ts = ? WHERE id = ?`)
      .run(status === 'failed' ? 'failed' : 'done', note, nowMs, nowMs, id);
    if (row && row.resource) release(row.resource, { deps });
  } catch (e) { console.error('[board] finish failed:', e.message); }
}

// The live board (sweeps first, so a crashed lane reads as failed, never as running).
function running({ deps = {}, nowMs = Date.now() } = {}) {
  try {
    sweep({ deps, nowMs });
    return _db(deps).getDb().prepare('SELECT * FROM workstreams WHERE status = ? ORDER BY started_ts ASC').all('running');
  } catch (e) { console.error('[board] running failed:', e.message); return []; }
}

function _ago(now, ts) {
  const d = Math.max(0, now - (ts || now));
  if (d < 3600e3) return Math.round(d / 60e3) + 'm';
  return Math.round(d / 3600e3) + 'h';
}

// Board lines for the manifest + activity snapshot. Includes the VIRTUAL rows (scribe holds its own
// meta; the chat slot is a standing fact) so the picture is whole without rewiring those lanes.
function manifestLines({ deps = {}, nowMs = Date.now() } = {}) {
  const lines = [];
  try {
    const dbm = _db(deps);
    for (const r of running({ deps, nowMs }).slice(0, 8)) {
      lines.push(`- [${r.lane}] ${r.kind || 'run'}${r.target ? `: "${String(r.target).slice(0, 80)}"` : ''} (${_ago(nowMs, r.started_ts)} in${r.resource ? `, holds ${r.resource}` : ''})`);
    }
    try { if (dbm.getMeta('scribe_active') === '1') lines.push('- [scribe] live meeting in progress (holds chat surface)'); } catch {}
    let held = [];
    try { held = dbm.getDb().prepare('SELECT resource FROM resource_locks').all().map((x) => x.resource); } catch {}
    const pool = CLOUD_POOL.filter((s) => !held.includes(s));
    lines.push(`- cloud slots: ${RESERVED_SLOT} reserved for chat (always); ${pool.length}/${CLOUD_POOL.length} allocatable free${held.length ? `; held: ${held.join(', ')}` : ''}`);
  } catch (e) { console.error('[board] manifestLines failed:', e.message); }
  return lines;
}

module.exports = {
  STALE_MS, RESERVED_SLOT, CLOUD_POOL, dbMaintenance,
  sweep, acquire, release, acquireCloudSlot, start, beat, finish, running, manifestLines,
};
