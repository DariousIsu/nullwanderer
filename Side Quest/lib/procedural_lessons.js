'use strict';
/**
 * lib/procedural_lessons.js — F25: PROCEDURAL INOCULATION (run-2 audit, built 2026-08-20).
 *
 * The proven gap: she does a thing wrong, corrects it (chain-guard replan, R3 self-repair) — and
 * LEARNS NOTHING. chain_guard's failure knowledge dies with the turn (newState() per chain);
 * experience.js captured success-only with one effectively-dead caller; nothing injected lessons at
 * tag-choice time. Live corroboration: the F11 misroute recurred across turns; "who is X" re-ran
 * the same dead-end tool orders it had already survived. known_incorrect inoculates claim VALUES —
 * this is its PROCEDURAL sibling: the failure→working-path PAIR, captured at the exact moment a
 * replan SUCCEEDS, persisted class-keyed, and injected so the NEXT same-class ask starts on the
 * path that worked.
 *
 * DISCIPLINE:
 *  - CLASS-keyed (task-class + tool), never arg-keyed — "legiscan_search failed for person-lookup"
 *    is a lesson; "this exact query failed" is just the per-turn chain-guard's job.
 *  - MEASURED, never asserted: a lesson exists only because a real chain failed on A and then
 *    landed on B, this process, logged. The injection names the count and biases ORDER ONLY — it
 *    never forbids a tool (reachability untouched; the model may still choose differently).
 *  - Lessons DECAY by disuse: served ordering prefers recent+repeated; a lesson unconfirmed for
 *    30d stops being served (the world changes; a stale lesson is a new wrong path).
 */

let _db = null;
const db = () => (_db || (_db = require('./db')));

let _ready = false;
function _ensure() {
  if (_ready) return;
  db().getDb().prepare(`CREATE TABLE IF NOT EXISTS procedural_lessons (
    id INTEGER PRIMARY KEY,
    task_class TEXT NOT NULL,
    failed_tool TEXT NOT NULL,
    worked_tool TEXT NOT NULL,
    hits INTEGER DEFAULT 1,
    first_ts INTEGER NOT NULL,
    last_ts INTEGER NOT NULL,
    UNIQUE(task_class, failed_tool, worked_tool)
  )`).run();
  _ready = true;
}

const SERVE_MAX_AGE_MS = 30 * 24 * 3600e3;   // an unconfirmed month-old lesson stops being served

/** The task-class of a user ask — reuses the E1 matrix's measured vocabulary; 'general' floor. */
function taskClassOf(userText) {
  try { return require('./answer_cache').classifyKind(userText) || 'general'; } catch { return 'general'; }
}

/** Record one failure→working-path pair. Upserts (class, failed, worked); hits++ on repeat. */
function record({ taskClass, failed, worked, now = Date.now() } = {}) {
  try {
    const tc = String(taskClass || '').trim(), f = String(failed || '').trim(), w = String(worked || '').trim();
    if (!tc || !f || !w || f === w) return { ok: false };
    _ensure();
    db().getDb().prepare(`INSERT INTO procedural_lessons (task_class, failed_tool, worked_tool, hits, first_ts, last_ts)
      VALUES (?,?,?,1,?,?)
      ON CONFLICT(task_class, failed_tool, worked_tool) DO UPDATE SET hits = hits + 1, last_ts = excluded.last_ts`)
      .run(tc, f, w, now, now);
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** Lessons for a class, strongest first (hits desc, recency desc), fresh-only. */
function lessonsFor(taskClass, { limit = 2, now = Date.now() } = {}) {
  try {
    _ensure();
    return db().getDb().prepare(`SELECT task_class, failed_tool, worked_tool, hits, last_ts FROM procedural_lessons
      WHERE task_class = ? AND last_ts > ? ORDER BY hits DESC, last_ts DESC LIMIT ?`)
      .all(String(taskClass || 'general'), now - SERVE_MAX_AGE_MS, limit);
  } catch { return []; }
}

/** The tag-choice-time injection — measured history, order-bias only, or null (fail-absent). */
function injectionBlock(taskClass, { limit = 2, now = Date.now() } = {}) {
  const rows = lessonsFor(taskClass, { limit, now });
  if (!rows.length) return null;
  const lines = rows.map((r) => `• ${r.failed_tool} came up empty and ${r.worked_tool} then found it (seen ${r.hits}×, last ${Math.round((now - r.last_ts) / 3600e3)}h ago)`);
  return `[PROCEDURAL LESSONS — measured from your own past ${taskClass} runs, not rules: ${lines.length === 1 ? 'this path' : 'these paths'} failed-then-succeeded before:\n${lines.join('\n')}\nSTART with the tool that worked. You may still try anything — this is history, not a fence.]`;
}

function stats() {
  try { _ensure(); return db().getDb().prepare('SELECT COUNT(*) n, SUM(hits) h FROM procedural_lessons').get(); } catch { return { n: 0, h: 0 }; }
}

module.exports = { taskClassOf, record, lessonsFor, injectionBlock, stats, SERVE_MAX_AGE_MS };
