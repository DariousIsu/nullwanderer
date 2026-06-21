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

// SPIRAL/JUNK classifier — the aggressive-curation core. A free-association thought (or
// a reading) matching this is hygiene-deleted at write time AND swept periodically, so the
// anxious-overanalyzer / prude / capability-doubt spiral and search-junk can't accumulate
// or re-seed. Self-contained (no LLM, no other lib) so it's safe to call on the hot path.
// Deliberately broad per "be more aggressive": a dropped thought just isn't surfaced this
// tick (she re-ticks ~every 35s) — cheap, vs. letting one spiral line re-prime the loop.
const JUNK = /All Regions Argentina|Argentina Australia Austria Belgium|Australia\s+Austria\s+Belgium/i; // DDG region-picker scrape
const SPIRAL = /overanaly|hesitat\b|wasn'?t (?:being )?honest|didn'?t (?:quite|really) answer|not (?:sure|fully)[^.]{0,25}honest|don'?t have (?:a |personal )?(?:self|preferen|favou?rite|feelings)|don'?t experience|\bnsfw\b|crushon|cleverbot|unrestricted|no[- ]?filter|safety net|default to research|struggle to (?:grasp|separate)|fabricat|oversell|second[\s-]?guess|performed rather than|contradicted (?:my |the )?constraint|catalogue (?:my )?flaws|hard[- ]?cod(?:ed|ing)|uncomfortable|discomfort|the tension (?:we|around)|\bas a (?:test|reset)\b|testing me|pivot(?:ed|ing)? (?:away|us)|prefers? (?:to|for) avoid/i;

function isJunk(text) {
  const t = String(text || '');
  return !!t && (JUNK.test(t) || SPIRAL.test(t));
}

// Aggressive sweep: hard-delete spiral/junk thoughts and search-junk readings from the
// recent window (older rows never re-inject). Runs at boot + on a timer. Unlike thread/gap
// aging this DELETES — for hygiene rows there's no value in keeping a tombstone, and the
// user asked for aggressive curation. Returns the count pruned.
function curateMonologue({ scanLast = 600 } = {}) {
  let removed = 0;
  try {
    const d = db.getDb();
    const rows = d.prepare("SELECT id, content FROM monologue WHERE type IN ('thought','reading') ORDER BY id DESC LIMIT ?").all(scanLast);
    const del = d.prepare('DELETE FROM monologue WHERE id = ?');
    const tx = d.transaction(() => { for (const r of rows) { if (isJunk(r.content)) { del.run(r.id); removed++; } } });
    tx();
  } catch (e) { console.error('[curator] curateMonologue failed:', e.message); }
  if (removed > 0) console.log(`[curator] pruned ${removed} spiral/junk monologue row(s)`);
  return removed;
}

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

module.exports = { curateThreads, curateGaps, curateMonologue, isJunk, STALE_THREAD_DAYS, STALE_GAP_DAYS };
