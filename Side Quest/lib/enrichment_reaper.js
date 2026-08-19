'use strict';
/**
 * lib/enrichment_reaper.js — SQ-side orphan reaper for Echo's electoral.enrichment_job.
 *
 * WHY SQ owns this (2026-08-19 W4): Echo's `EnrichmentJob` INSERTs a row 'running' on __enter__ and
 * only advances it to complete/failed on __exit__, so a process killed mid-block orphans the row
 * 'running' forever. The process that kills it is almost always OURS — a Side Quest reboot tree-kills
 * the whole Echo stack mid-dive. Echo already reaps its own agent_runs/pass_runs this way, and the
 * sibling reaper lives in echo.saga.heartbeat — but that heartbeat runs in huey_consumer, which is
 * NOT running in this deployment, so the Echo-side wiring is dark. SQ's own maintenance loop IS alive,
 * and SQ is the right owner: it cleans up after the reboots it causes.
 *
 * Marks enrichment_job rows stuck 'running' past `staleS` (default 2h — a deep_dive is minutes;
 * conservative so a genuinely-running dive is never reaped, and even a false reap self-corrects when
 * the running job's own __exit__ later writes its real status) → 'failed' + a distinctive marker
 * (preserves contact_id + any prior error via COALESCE). FAIL-SOFT: a missing/locked/absent DB yields
 * 0, never throws — it must never break the caller's loop. dbPath + deps injectable for the smoke.
 */

const STALE_S = 2 * 60 * 60;   // 2h
const ORPHAN_MARKER =
  "orphaned: stale 'running' enrichment_job reconciled by SQ reaper (process killed mid-run)";

// Reap orphaned 'running' enrichment_job rows in the electoral.db at `dbPath`. Returns the count
// reaped (0 on any error / nothing to do). Best-effort by design.
function reapOrphanedEnrichmentJobs({ dbPath, staleS = STALE_S, now = Date.now, Database = null } = {}) {
  if (!dbPath) return 0;
  const DB = Database || require('better-sqlite3');
  let db = null;
  try {
    db = new DB(dbPath, { timeout: 5000 });
    const cutoff = Math.floor(now() / 1000) - Math.max(0, staleS | 0);
    const info = db.prepare(
      "UPDATE enrichment_job SET status='failed', " +
      "finished_at = CAST(strftime('%s','now') AS INTEGER), " +
      "error_message = COALESCE(error_message, ?) " +
      "WHERE status='running' AND started_at IS NOT NULL AND started_at < ?"
    ).run(ORPHAN_MARKER, cutoff);
    return info.changes || 0;
  } catch {
    return 0;   // fail-soft: DB locked/missing/absent → skip this cycle, try again next tick
  } finally {
    try { if (db) db.close(); } catch {}
  }
}

module.exports = { reapOrphanedEnrichmentJobs, STALE_S, ORPHAN_MARKER };
