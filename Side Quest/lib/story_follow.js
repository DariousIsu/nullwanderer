/**
 * lib/story_follow — DEVELOPING STORIES SHE FOLLOWS (memory slice 1B, 2026-07-22).
 *
 * Lucas's divergence check: "commenting on a news story in progress should generate conversation."
 * The pieces existed and never met: the hourly pass clusters items into news_stories with a real
 * update trail (news_story_updates), stories already ride chat grounding as streamHits — but nothing
 * REMEMBERED that a story had entered a conversation, so a development three hours later was
 * indistinguishable from any other headline. And the anti-tangent rules (built to kill the
 * Salesforce-dump) throttle exactly this kind of unprompted news talk.
 *
 * This is the calendar pattern (lib/week_context) reapplied to news: a small FOLLOW table over the
 * news bucket marks stories as `discussed` (it rode into a chat turn's grounding) or `interest`
 * (fresh + corroborated match on one of her active interests). The autonomy manifest then carries a
 * DEVELOPING STORIES YOU FOLLOW section holding only the DELTA — what changed since she last raised
 * it — and the decision prompt licenses an engage on a discussed story's development as a real
 * opening, not padding. She raises what CHANGED; re-narrating the story is exactly the tangent the
 * throttles exist to kill.
 *
 * Baseline discipline: following a story starts the clock AT ITS CURRENT last_ts — the story's past
 * is context she already saw, never a "development". markRaised() re-baselines, so one development is
 * raised once. Lives in the news bucket (NEWS_DB_PATH override → offline-smokeable). Fail-soft.
 */
'use strict';
const newsdb = require('./news_db');

const MAX_ACTIVE = 20;                       // follows stay a working set, not an archive
const EXPIRE_QUIET_MS = 7 * 24 * 3600e3;     // a closed story quiet this long stops being followed

let _schemaReady = false;
function ensureSchema() {
  if (_schemaReady) return;
  newsdb.get().exec(`
    CREATE TABLE IF NOT EXISTS news_story_follow (
      story_id       INTEGER PRIMARY KEY,
      reason         TEXT NOT NULL DEFAULT 'discussed',   -- 'discussed' | 'interest'
      followed_ts    INTEGER NOT NULL,
      last_raised_ts INTEGER,                              -- when she last raised a development to Lucas
      last_seen_ts   INTEGER NOT NULL,                     -- delta baseline: story.last_ts as of follow/raise
      active         INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_news_story_follow_active ON news_story_follow(active, last_seen_ts);
  `);
  _schemaReady = true;
}
function _resetForTest() { _schemaReady = false; }

function _story(storyId) {
  ensureSchema();
  try { return newsdb.get().prepare('SELECT id, title, summary, last_ts, status, outlet_count, report_count FROM news_stories WHERE id = ?').get(Number(storyId) || 0) || null; }
  catch { return null; }
}

// Follow a story. Idempotent upsert; re-following keeps the existing baseline (no delta reset) and
// only upgrades reason toward 'discussed' (a discussed story never demotes to a mere interest match).
// Over the cap, the stalest active follow is retired first — the working set stays bounded.
function follow(storyId, { reason = 'discussed', nowMs = Date.now() } = {}) {
  const s = _story(storyId);
  if (!s) return { followed: false, reason: 'no such story' };
  try {
    const active = newsdb.get().prepare('SELECT COUNT(*) n FROM news_story_follow WHERE active = 1').get().n;
    if (active >= MAX_ACTIVE) {
      newsdb.get().prepare(`UPDATE news_story_follow SET active = 0 WHERE story_id = (
        SELECT story_id FROM news_story_follow WHERE active = 1 AND story_id != ? ORDER BY last_seen_ts ASC LIMIT 1)`).run(s.id);
    }
    const info = newsdb.get().prepare(`
      INSERT INTO news_story_follow (story_id, reason, followed_ts, last_raised_ts, last_seen_ts, active)
      VALUES (@id, @reason, @now, NULL, @seen, 1)
      ON CONFLICT(story_id) DO UPDATE SET
        active = 1,
        reason = CASE WHEN excluded.reason = 'discussed' THEN 'discussed' ELSE news_story_follow.reason END
    `).run({ id: s.id, reason: reason === 'interest' ? 'interest' : 'discussed', now: nowMs, seen: Number(s.last_ts) || nowMs });
    return { followed: true, id: s.id, fresh: info.changes > 0 };
  } catch (e) { console.error('[story_follow] follow failed:', e.message); return { followed: false, reason: e.message }; }
}

// She raised this story's development with Lucas — re-baseline so the SAME development is never
// raised twice. The next manifest line for this story appears only when the story moves again.
function markRaised(storyId, nowMs = Date.now()) {
  ensureSchema();
  try {
    const info = newsdb.get().prepare(`
      UPDATE news_story_follow SET last_raised_ts = ?, last_seen_ts = COALESCE((SELECT last_ts FROM news_stories WHERE id = story_id), last_seen_ts)
      WHERE story_id = ?`).run(nowMs, Number(storyId) || 0);
    return info.changes > 0;
  } catch (e) { console.error('[story_follow] markRaised failed:', e.message); return false; }
}

// Retire follows whose story CLOSED and has been quiet past the window — a wrapped story is not a
// developing one. Returns how many retired.
function tidy({ nowMs = Date.now() } = {}) {
  ensureSchema();
  try {
    return newsdb.get().prepare(`
      UPDATE news_story_follow SET active = 0 WHERE active = 1 AND story_id IN (
        SELECT f.story_id FROM news_story_follow f JOIN news_stories s ON s.id = f.story_id
        WHERE f.active = 1 AND s.status = 'closed' AND s.last_ts < ?)`).run(nowMs - EXPIRE_QUIET_MS).changes;
  } catch (e) { console.error('[story_follow] tidy failed:', e.message); return 0; }
}

// The DELTAS: followed stories that MOVED since their baseline, with what actually changed (the
// update rows since last seen — headline + source, newest first). Empty when nothing moved.
function deltas({ limit = 5, nowMs = Date.now() } = {}) {
  ensureSchema();
  let rows = [];
  try {
    rows = newsdb.get().prepare(`
      SELECT f.story_id, f.reason, f.followed_ts, f.last_raised_ts, f.last_seen_ts,
             s.title, s.summary, s.last_ts, s.status, s.outlet_count, s.report_count
      FROM news_story_follow f JOIN news_stories s ON s.id = f.story_id
      WHERE f.active = 1 AND s.last_ts > f.last_seen_ts
      ORDER BY s.last_ts DESC LIMIT ?`).all(Math.max(1, limit | 0));
  } catch (e) { console.error('[story_follow] deltas failed:', e.message); return []; }
  return rows.map((r) => {
    let updates = [];
    try {
      updates = newsdb.get().prepare(
        'SELECT source, title, ts FROM news_story_updates WHERE story_id = ? AND ts > ? ORDER BY ts DESC LIMIT 3'
      ).all(r.story_id, r.last_seen_ts);
    } catch {}
    let newCount = updates.length;
    try { newCount = newsdb.get().prepare('SELECT COUNT(*) n FROM news_story_updates WHERE story_id = ? AND ts > ?').get(r.story_id, r.last_seen_ts).n; } catch {}
    return {
      storyId: r.story_id, title: r.title || '(untitled)', reason: r.reason,
      newCount, latest: updates.map((u) => ({ source: u.source || '?', title: u.title || '' })),
      lastRaisedTs: r.last_raised_ts || null, lastTs: r.last_ts, status: r.status,
      corroboration: Math.min(Number(r.outlet_count) || 0, Number(r.report_count) || 0),
    };
  }).filter((d) => d.newCount > 0);
}

function _ago(now, ts) {
  if (!ts) return 'never';
  const d = Math.max(0, now - ts);
  if (d < 3600e3) return Math.round(d / 60e3) + 'm ago';
  if (d < 86400e3) return Math.round(d / 3600e3) + 'h ago';
  return Math.round(d / 86400e3) + 'd ago';
}

// Manifest lines (facts only — the licensing language lives in the decision prompt). The [story #N]
// token is the machine handle: an engage about a development sets its target to that token, and the
// driver marks the story raised from it.
function manifestLines({ limit = 5, nowMs = Date.now() } = {}) {
  const ds = deltas({ limit, nowMs });
  return ds.map((d) => {
    const raised = d.lastRaisedTs ? `last raised ${_ago(nowMs, d.lastRaisedTs)}` : 'never raised with him';
    const why = d.reason === 'discussed' ? 'you two discussed this' : 'matches your interests';
    const latest = d.latest.length ? ` Latest: ${d.latest.map((u) => `"${String(u.title).slice(0, 90)}" (${u.source})`).join('; ')}.` : '';
    return `   - [story #${d.storyId}] "${String(d.title).slice(0, 100)}" — ${d.newCount} new report${d.newCount === 1 ? '' : 's'} since you last saw it (${raised}; ${why}).${latest}`;
  });
}

// Auto-follow: fresh + corroborated stories matching her ACTIVE interests. Topics come in as plain
// strings (the caller reads the interests table — sq.db and the news bucket stay uncoupled). Bounded
// per run so a broad interest can't swallow the follow set in one tick.
function autoFollowFromInterests(topics = [], { nowMs = Date.now(), minCorroboration = 2, freshMs = 48 * 3600e3, maxPerRun = 3 } = {}) {
  let followed = 0;
  const lane = require('./news_lane');
  for (const topic of (Array.isArray(topics) ? topics : []).slice(0, 10)) {
    if (followed >= maxPerRun) break;
    let hits = [];
    try { hits = lane.storiesForTopic(String(topic || ''), { k: 2, maxAgeMs: freshMs, now: nowMs }) || []; } catch { hits = []; }
    for (const s of hits) {
      if (followed >= maxPerRun) break;
      if (Math.min(Number(s.outlet_count) || 0, Number(s.report_count) || 0) < minCorroboration) continue;
      try {
        const already = newsdb.get().prepare('SELECT active FROM news_story_follow WHERE story_id = ?').get(s.id);
        if (already && already.active) continue;
        if (follow(s.id, { reason: 'interest', nowMs }).followed) followed++;
      } catch {}
    }
  }
  return { followed };
}

module.exports = {
  MAX_ACTIVE, EXPIRE_QUIET_MS,
  ensureSchema, follow, markRaised, tidy, deltas, manifestLines, autoFollowFromInterests,
  _resetForTest,
};
