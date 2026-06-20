/**
 * Curator — deterministic, time-based hygiene for the focus/thread store.
 *
 * Borrowed from Hermes Agent's curator (the deterministic half: a time-state
 * machine, no LLM). Hermes ages skills active→stale(30d)→archived(90d) and NEVER
 * deletes. Side Quest's analog: a STALLED open_thread that hasn't been touched in
 * STALE_THREAD_DAYS is aged to 'abandoned' so it stops resurfacing in the idle
 * loop's thread-review rotation. Resolved threads are kept as record; nothing is
 * ever deleted (archiving via status is the maximum action). The optional LLM
 * "umbrella" consolidation pass is intentionally NOT ported (aspirational).
 */

const db = require('./db');

const STALE_THREAD_DAYS = 14;
const STALE_GAP_DAYS = 21; // an un-acted capability gap this old → dismissed

// Age stalled, long-untouched threads to 'abandoned'. Returns the count aged.
// Pure DB + deterministic; safe to run on a timer or at boot.
function curateThreads({ staleDays = STALE_THREAD_DAYS } = {}) {
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  let aged = 0;
  try {
    const stale = db.getDb()
      .prepare(`SELECT id FROM open_threads WHERE status = 'stalled' AND last_touched_ts < ?`)
      .all(cutoff);
    for (const r of stale) {
      db.markOpenThreadStatus(r.id, 'abandoned', { reason: `curator: stalled > ${staleDays}d untouched` });
      aged++;
    }
  } catch (e) { console.error('[curator] curateThreads failed:', e.message); }
  if (aged > 0) console.log(`[curator] aged ${aged} stale thread(s) → abandoned`);
  return aged;
}

// Age long-unacted capability gaps to 'dismissed' so proposals don't pile up.
// Returns the count dismissed. Deterministic.
function curateGaps({ staleDays = STALE_GAP_DAYS } = {}) {
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  let aged = 0;
  try {
    const stale = db.getStaleCapabilityGaps(cutoff);
    for (const r of stale) { db.markCapabilityGapStatus(r.id, 'dismissed'); aged++; }
  } catch (e) { console.error('[curator] curateGaps failed:', e.message); }
  if (aged > 0) console.log(`[curator] dismissed ${aged} stale capability gap(s)`);
  return aged;
}

module.exports = { curateThreads, curateGaps, STALE_THREAD_DAYS, STALE_GAP_DAYS };
