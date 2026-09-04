/**
 * lib/db_health.js — Loop D of the deterministic-loops build (2026-08-15): INTEROCEPTION for the
 * memory substrate. sq.db is what she remembers WITH; Echo's stores are the long-term memory. A
 * `database is locked` error immediately preceded boot_p39's silent death and NOTHING was watching
 * — WAL growth (checkpoint starvation, the lock class), integrity, growth rate, and the backup pile
 * all had zero standing observation. Zero LLM.
 *
 * THE BEAT CONTRACT (§0b): the snapshot lands in meta `db_health`, read by lib/status_vector as its
 * `memory_substrate` section (awareness line + state door — she can answer "how's your memory"
 * from data). Anomalies escalate via obs_bus (lane 'db'), feeding self_watch. No dead dashboard.
 *
 * What it watches (10-min tick, all fs.stat — cheap):
 *   • sq.db + WAL size — a growing WAL means checkpoint starvation → the p39 lock class. >256MB warns.
 *   • Echo's big stores (saga/web_cache/jobs/skuld) + their WALs.
 *   • the BACKUP PILE census — count + GB of sq.db precuration/backup copies (~13GB sat unwatched
 *     at build time). The census REPORTS everything; rotateBackups AUTO-PRUNES exactly one
 *     pattern — sq.db.precuration_* beyond the newest PRECURATION_KEEP — under Lucas's 08-15
 *     reclaim ruling. Every other backup-class file is surfaced, never auto-deleted.
 *   • growth ring — one size sample per ~day, 14 kept → MB/day ("my memory grew 33MB today").
 *   • PRAGMA quick_check WEEKLY, in a CHILD process (scripts/db_quick_check.js) — a 2.6GB
 *     quick_check on the main thread would BE a main-thread stall, the exact disease route_obs
 *     measures. Result lands in meta; a failure is an error-level anomaly.
 *
 * DEFERRED (named, not silent): a SQLITE_BUSY counter needs a central catch at db.js's statement
 * wrapper, which doesn't exist — every call site prepares directly. When a wrapper lands, count
 * busies here. Until then the WAL watch is the lock-class sentinel.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WAL_WARN_MB = 256;
const BACKUP_WARN_GB = 10;
const RING_KEY = 'db_health.size_ring';
const QC_KEY = 'db_health.quick_check';
const SNAP_KEY = 'db_health';
const RING_MIN_GAP_MS = 20 * 3600e3;   // ~one sample/day
const RING_KEEP = 14;
const QC_EVERY_MS = 7 * 24 * 3600e3;
const ANOMALY_COOLDOWN_MS = 6 * 3600e3;

const _lastAnomalyAt = {};

function _defaultPaths() {
  const sq = process.env.SQ_DB_PATH || path.join(__dirname, '..', 'data', 'sq.db');
  const echoData = path.join('C:', 'Users', 'azrae', 'Desktop', 'NX ECHO', 'nx-echo', 'data');
  return {
    sqDb: sq,
    dataDir: path.dirname(sq),
    echo: ['saga.db', 'web_cache.db', 'jobs.db', 'skuld_checkpoints.db'].map((n) => path.join(echoData, n)),
  };
}

function _mb(p) { try { return Math.round(fs.statSync(p).size / 1048576); } catch { return null; } }

function _emitAnomaly(type, level, text, { deps = {}, nowMs = Date.now() } = {}) {
  if (nowMs - (_lastAnomalyAt[type] || 0) < ANOMALY_COOLDOWN_MS) return;
  _lastAnomalyAt[type] = nowMs;
  try {
    ((deps.obsBus) || require('./obs_bus')).emit(
      { lane: 'db', kind: 'anomaly', level, text, ref: type },
      { deps, nowMs }
    );
  } catch {}
}

// PRECURATION ROTATION (Lucas's reclaim ruling, 2026-08-15 "reclaim audit and continue"): the
// nightly pre-curation snapshot writer never pruned — 5 copies ≈ 12.8GB sat on a 4%-free volume
// until a hand-run reclaim. A hand-run repair is an UNFINISHED FEATURE: this keeps exactly the
// newest PRECURATION_KEEP copies and deletes older ones, STRICTLY the sq.db.precuration_<stamp>
// pattern (timestamped names sort chronologically) — never any other file, never the live store.
// Runs on the tick; prunes log + emit obs (lane 'db', kind 'rotation').
// KEEP dropped 2 → 1 (Lucas's 08-31 retention ruling, the 250MB-free night): at ~3.7GB per copy
// the DB outgrew a two-deep pile — ONE snapshot is the safety net, and the write-site keep in
// main.js aligns to the same number so copies can't stack between ticks.
const PRECURATION_KEEP = 1;
const PRECURATION_RE = /^sq\.db\.precuration_\d{8}_\d{6}$/;
function rotateBackups({ deps = {}, nowMs = Date.now(), dataDir = null } = {}) {
  try {
    const dir = dataDir || _defaultPaths().dataDir;
    const matches = fs.readdirSync(dir).filter((n) => PRECURATION_RE.test(n)).sort().reverse();
    const stale = matches.slice(PRECURATION_KEEP);
    const pruned = [];
    for (const n of stale) {
      try {
        const p = path.join(dir, n);
        const gb = Math.round((fs.statSync(p).size / 1073741824) * 100) / 100;
        fs.unlinkSync(p);
        pruned.push(n);
        try { console.log(`[db_health] rotated out ${n} (${gb}GB) — keeping newest ${PRECURATION_KEEP} precuration copies`); } catch {}
      } catch {}
    }
    if (pruned.length) {
      try {
        ((deps.obsBus) || require('./obs_bus')).emit(
          { lane: 'db', kind: 'rotation', level: 'info', text: `precuration rotation pruned ${pruned.length} old cop${pruned.length === 1 ? 'y' : 'ies'} (kept newest ${Math.min(matches.length, PRECURATION_KEEP)})`, data: { pruned } },
          { deps, nowMs }
        );
      } catch {}
    }
    return { pruned, kept: matches.slice(0, PRECURATION_KEEP) };
  } catch { return { pruned: [], kept: [] }; }
}

// ── THE RETENTION SWEEP (Lucas 09-01: "no data, her internal systems or research or anything in
// between should be being stored in an exploding position") ────────────────────────────────────
// SHORT-TERM MUST BE DISPOSABLE BY CONSTRUCTION: quarantine's whole purpose is that a corrupted
// short-term tier can be dumped without touching the long-term investment — an unbounded stream
// is un-dumpable AND a disk bomb (encounters hit 1.2M rows, kg_observations 1.45M before this).
// ONE organ, declared registry, per-store bound + DISTILL-GUARD (a row prunes only after what it
// feeds has consumed it). Long-term stores are NEVER listed here. Quarantine rows prune only
// after a gate decided them — never by age alone (they're claims, not exhaust).
// DARK-FIRST: dry-run by default — passes REPORT would-prune counts until meta retention.armed='on'
// (his word arms it). Batched deletes (bounded per pass) so a sweep never holds a long lock.
const RETENTION = [
  // pure exhaust — ring by rows
  { table: 'cloud_traces', kind: 'ring', maxRows: 20000 },
  { table: 'agent_events', kind: 'ring', maxRows: 20000 },
  { table: 'recent_cards', kind: 'ring', maxRows: 50000 },
  // recency/episodic streams — age windows (their consumers read far shorter windows)
  { table: 'encounters', kind: 'age', tsCol: 'ingested_at', maxAgeMs: 90 * 24 * 3600e3 },
  { table: 'kg_observations', kind: 'age', tsCol: 'captured_at', maxAgeMs: 60 * 24 * 3600e3 },
  { table: 'touchpoints', kind: 'age', tsCol: 'ts', maxAgeMs: 90 * 24 * 3600e3 },
  { table: 'inbound_messages', kind: 'age', tsCol: 'received_ts', maxAgeMs: 90 * 24 * 3600e3 },
  // distill-guarded: a thought prunes ONLY once consolidation has eaten it
  { table: 'monologue', kind: 'age', tsCol: 'ts', maxAgeMs: 90 * 24 * 3600e3, guard: 'consolidated = 1' },
];
const RETENTION_BATCH = 5000;          // max deletes per table per pass — never a long lock
const RETENTION_EVERY_MS = 24 * 3600e3;

function retentionSweep({ deps = {}, nowMs = Date.now(), registry = RETENTION, batch = RETENTION_BATCH } = {}) {
  const db = deps.db || require('./db');
  try {
    if (nowMs - (parseInt(db.getMeta('retention.last_sweep') || '0', 10) || 0) < RETENTION_EVERY_MS) return null;
    db.setMeta('retention.last_sweep', String(nowMs));
    const armed = (db.getMeta('retention.armed') || 'off') === 'on';
    const d = db.getDb();
    const report = [];
    for (const r of registry) {
      try {
        let where = '';
        if (r.kind === 'ring') {
          const hi = d.prepare(`SELECT MAX(id) m FROM ${r.table}`).get();
          if (!hi || !hi.m || hi.m <= r.maxRows) { continue; }
          where = `id <= ${hi.m - r.maxRows}`;
        } else {
          where = `${r.tsCol} < ${nowMs - r.maxAgeMs}`;
        }
        if (r.guard) where += ` AND ${r.guard}`;
        const n = d.prepare(`SELECT COUNT(*) c FROM ${r.table} WHERE ${where}`).get().c;
        if (!n) continue;
        if (armed) {
          const del = d.prepare(`DELETE FROM ${r.table} WHERE rowid IN (SELECT rowid FROM ${r.table} WHERE ${where} LIMIT ${batch})`).run();
          report.push(`${r.table}: pruned ${del.changes}${n > del.changes ? ` of ${n} (batched — the rest next pass)` : ''}`);
        } else {
          report.push(`${r.table}: WOULD prune ${n} (dry-run)`);
        }
      } catch (e) { report.push(`${r.table}: ERR ${String(e.message).slice(0, 60)}`); }
    }
    if (report.length) {
      const mode = armed ? 'ARMED' : 'DRY-RUN';
      console.log(`[db_health] retention sweep (${mode}): ${report.join(' · ')}`);
      try {
        ((deps.obsBus) || require('./obs_bus')).emit(
          { lane: 'db', kind: 'rotation', level: 'info', text: `retention sweep (${mode}): ${report.join(' · ').slice(0, 400)}`, ref: 'retention' },
          { deps, nowMs }
        );
      } catch {}
    }
    return { armed, report };
  } catch (e) { try { console.error('[db_health] retention sweep failed soft:', e.message); } catch {} return null; }
}

// CUT 18 (09-03): the same sweep with its COUNT(*)s (and the ring's MAX(id)) in lib/db_worker — the daily
// dry-run was six synchronous counts over the exhaust tables (1.3M encounters, 1.5M kg_observations…) on
// the main thread. The DELETE, when armed, still runs on the main connection (the worker is read-only) —
// batched to RETENTION_BATCH rows, as before. An injected store (the smokes) or a store with no file
// delegates to the synchronous sweep, so the pins' contract is unchanged.
async function retentionSweepAsync({ deps = {}, nowMs = Date.now(), registry = RETENTION, batch = RETENTION_BATCH } = {}) {
  const db = deps.db || require('./db');
  const dbPath = db.DB_PATH;
  if (deps.db || !dbPath || dbPath === ':memory:') return retentionSweep({ deps, nowMs, registry, batch });
  try {
    if (nowMs - (parseInt(db.getMeta('retention.last_sweep') || '0', 10) || 0) < RETENTION_EVERY_MS) return null;
    db.setMeta('retention.last_sweep', String(nowMs));
    const armed = (db.getMeta('retention.armed') || 'off') === 'on';
    const q = (sql) => require('./db_worker').query(dbPath, sql, [], { limit: 5, timeoutMs: 180000 });
    const report = [];
    for (const r of registry) {
      try {
        let where = '';
        if (r.kind === 'ring') {
          const hi = (await q(`SELECT MAX(id) m FROM ${r.table}`))[0];
          if (!hi || !hi.m || hi.m <= r.maxRows) { continue; }
          where = `id <= ${hi.m - r.maxRows}`;
        } else {
          where = `${r.tsCol} < ${nowMs - r.maxAgeMs}`;
        }
        if (r.guard) where += ` AND ${r.guard}`;
        const n = Number(((await q(`SELECT COUNT(*) c FROM ${r.table} WHERE ${where}`))[0] || {}).c) || 0;
        if (!n) continue;
        if (armed) {
          const del = db.getDb().prepare(`DELETE FROM ${r.table} WHERE rowid IN (SELECT rowid FROM ${r.table} WHERE ${where} LIMIT ${batch})`).run();
          report.push(`${r.table}: pruned ${del.changes}${n > del.changes ? ` of ${n} (batched — the rest next pass)` : ''}`);
        } else {
          report.push(`${r.table}: WOULD prune ${n} (dry-run)`);
        }
      } catch (e) { report.push(`${r.table}: ERR ${String(e.message).slice(0, 60)}`); }
    }
    if (report.length) {
      const mode = armed ? 'ARMED' : 'DRY-RUN';
      console.log(`[db_health] retention sweep (${mode}, counted off the main thread): ${report.join(' · ')}`);
      try {
        ((deps.obsBus) || require('./obs_bus')).emit(
          { lane: 'db', kind: 'rotation', level: 'info', text: `retention sweep (${mode}): ${report.join(' · ').slice(0, 400)}`, ref: 'retention' },
          { deps, nowMs }
        );
      } catch {}
    }
    return { armed, report };
  } catch (e) { try { console.error('[db_health] retention sweep failed soft:', e.message); } catch {} return null; }
}

// Census of backup-ish copies in the data dir (name-matched, ≥50MB). REPORT-ONLY by design.
function backupCensus(dataDir) {
  try {
    const rx = /backup|precuration|precollapse|premerge/i;
    let count = 0, bytes = 0, newest = 0;
    for (const name of fs.readdirSync(dataDir)) {
      if (!rx.test(name)) continue;
      try {
        const st = fs.statSync(path.join(dataDir, name));
        if (!st.isFile() || st.size < 50 * 1048576) continue;
        count++; bytes += st.size; newest = Math.max(newest, st.mtimeMs);
      } catch {}
    }
    return { count, totalGB: Math.round(bytes / 1073741824 * 10) / 10, newestAt: newest || null };
  } catch { return null; }
}

/** One 10-min tick: stat sizes, census, growth ring, anomalies, persist snapshot. Fail-soft. */
function tick({ deps = {}, nowMs = Date.now(), paths = null } = {}) {
  const P = paths || _defaultPaths();
  const db = deps.db || require('./db');
  const out = { at: nowMs };
  // rotation FIRST, so the census below reports the post-rotation truth
  try { rotateBackups({ deps, nowMs, dataDir: P.dataDir }); } catch {}
  // the retention sweep rides the same tick (due-gated daily inside; dry-run until armed). CUT 18: live,
  // its COUNTs run in the db worker (retentionSweepAsync); an injected store keeps the synchronous sweep.
  try { const p = retentionSweepAsync({ deps, nowMs }); if (p && p.catch) p.catch(() => {}); } catch {}
  try {
    out.sq = { sizeMB: _mb(P.sqDb), walMB: _mb(P.sqDb + '-wal') };
    if (out.sq.walMB != null && out.sq.walMB > WAL_WARN_MB) {
      _emitAnomaly('wal_growth', 'warn', `sq.db WAL at ${out.sq.walMB}MB — checkpoint starvation (the p39 lock class)`, { deps, nowMs });
    }
  } catch {}
  try {
    out.echo = P.echo.map((p) => ({ name: path.basename(p), sizeMB: _mb(p), walMB: _mb(p + '-wal') }))
      .filter((e) => e.sizeMB != null);
    for (const e of out.echo) {
      if (e.walMB != null && e.walMB > WAL_WARN_MB) {
        _emitAnomaly(`wal_growth_${e.name}`, 'warn', `${e.name} WAL at ${e.walMB}MB — checkpoint starvation on an Echo store`, { deps, nowMs });
      }
    }
  } catch {}
  try {
    out.backups = backupCensus(P.dataDir);
    if (out.backups && out.backups.totalGB > BACKUP_WARN_GB) {
      _emitAnomaly('backup_pile', 'warn', `${out.backups.count} backup copies totaling ${out.backups.totalGB}GB in data/ — rotation is Lucas's call, surfacing not pruning`, { deps, nowMs });
    }
  } catch {}
  // growth ring (one/day)
  try {
    if (out.sq && out.sq.sizeMB != null) {
      const ring = (JSON.parse(db.getMeta(RING_KEY) || '[]') || []).filter((r) => r && r.ts && r.mb != null);
      if (!ring.length || (nowMs - ring[ring.length - 1].ts) > RING_MIN_GAP_MS) {
        ring.push({ ts: nowMs, mb: out.sq.sizeMB });
        db.setMeta(RING_KEY, JSON.stringify(ring.slice(-RING_KEEP)));
      }
      if (ring.length >= 2) {
        const a = ring[0], b = ring[ring.length - 1];
        const days = (b.ts - a.ts) / 86400e3;
        if (days > 0.5) out.growthMBperDay = Math.round((b.mb - a.mb) / days);
      }
    }
  } catch {}
  // last quick_check verdict rides the snapshot; a failed one is an ERROR anomaly every tick window
  try {
    const qc = JSON.parse(db.getMeta(QC_KEY) || 'null');
    if (qc && qc.at) {
      out.quickCheck = { at: qc.at, ok: !!qc.ok };
      if (!qc.ok) _emitAnomaly('integrity', 'error', `sq.db quick_check FAILED: ${String(qc.msg || '').slice(0, 200)}`, { deps, nowMs });
    }
  } catch {}
  try { db.setMeta(SNAP_KEY, JSON.stringify(out)); } catch {}
  return out;
}

/**
 * Weekly integrity check, in a CHILD process so the main thread never stalls. Spawns this same
 * runtime as node (ELECTRON_RUN_AS_NODE) on scripts/db_quick_check.js; the child opens the DB
 * read-only and prints one JSON line. Due-gated here; call from the tick cadence.
 */
// IN-PROGRESS guard (2026-08-15 backcheck fix): a quick_check of the ~2.6GB store can outlive the
// 10-min tick interval (its own timeout is 15min), and the due-gate only clears when the child
// COMPLETES (writes QC_KEY). Without this flag the next tick re-reads the still-stale timestamp and
// spawns a SECOND concurrent full-scan — doubled disk I/O on an already-tight volume. One in-flight
// child at a time; the flag clears in the completion callback (and on spawn failure).
let _qcInFlight = false;
function maybeQuickCheck({ deps = {}, nowMs = Date.now(), paths = null } = {}) {
  const db = deps.db || require('./db');
  if (_qcInFlight) return false;
  try {
    const qc = JSON.parse(db.getMeta(QC_KEY) || 'null');
    if (qc && qc.at && (nowMs - qc.at) < QC_EVERY_MS) return false;
  } catch {}
  const P = paths || _defaultPaths();
  try {
    const { execFile } = require('child_process');
    const script = path.join(__dirname, '..', 'scripts', 'db_quick_check.js');
    _qcInFlight = true;
    const child = execFile(process.execPath, [script, P.sqDb], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 15 * 60e3, windowsHide: true, maxBuffer: 1048576,
    }, (err, stdout) => {
      _qcInFlight = false;
      let res = null;
      try { res = JSON.parse(String(stdout || '').trim().split('\n').pop()); } catch {}
      if (!res) res = { ok: false, msg: err ? `child failed: ${err.message}` : 'no output' };
      try { db.setMeta(QC_KEY, JSON.stringify({ at: Date.now(), ok: !!res.ok, msg: res.msg || '', ms: res.ms || null })); } catch {}
      try { console.log(`[db_health] weekly quick_check ${res.ok ? 'OK' : 'FAILED'} (${res.ms || '?'}ms)`); } catch {}
    });
    if (child.unref) child.unref();
    return true;
  } catch (e) { _qcInFlight = false; try { console.error('[db_health] quick_check spawn failed:', e.message); } catch {} return false; }
}

// One compact phrase for the status vector's memory_substrate section.
function describe(v) {
  if (!v || !v.at) return null;
  const bits = [];
  if (v.sq && v.sq.sizeMB != null) bits.push(`sq.db ${(v.sq.sizeMB / 1024).toFixed(1)}GB${v.sq.walMB != null ? ` (WAL ${v.sq.walMB}MB)` : ''}`);
  if (v.growthMBperDay != null) bits.push(`growing ~${v.growthMBperDay}MB/day`);
  if (v.quickCheck) bits.push(`integrity ${v.quickCheck.ok ? 'OK' : 'FAILED'}`);
  if (v.backups && v.backups.count) bits.push(`${v.backups.count} backups ${v.backups.totalGB}GB`);
  return bits.length ? bits.join(' · ') : null;
}

module.exports = { tick, maybeQuickCheck, backupCensus, rotateBackups, retentionSweep, retentionSweepAsync, describe, RETENTION, RETENTION_BATCH, WAL_WARN_MB, BACKUP_WARN_GB, PRECURATION_KEEP, RING_KEY, QC_KEY, SNAP_KEY };
