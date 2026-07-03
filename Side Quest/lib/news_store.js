/**
 * lib/news_store.js — the Data-Stream Lane RESERVOIR (Slice 1).
 *
 * A per-source-isolated short-term buffer for news items. Dumb + deterministic: fetch → normalize →
 * dedup (same-source only) → append. No model, no cognition — the hourly/daily passes (later slices)
 * compress it into layers + Echo `event` objects. Mirrors the doc_store short-term-landing pattern
 * (docs/DATA_STREAM_LANE_DESIGN.md §5) but owns its own schema here (additive `CREATE TABLE IF NOT
 * EXISTS` over the shared better-sqlite3 connection) so the reservoir can be built + smoke-tested in
 * isolation; folding the schema into db.js's canonical MIGRATIONS is a trivial later move.
 *
 * DEDUP CONTRACT (design §"Source integration"): dedup is SAME-SOURCE ONLY — UNIQUE(source,
 * url_or_guid). Two outlets running the same wire story stay two items until Stage-2 clustering; that
 * cross-source corroboration is the value, not noise. `story_id` / `layer_id` are nullable, filled by
 * later slices; they exist now so the table is stable and needs no migration.
 *
 * Offline-testable: scripts/smoke_news_store.js (temp SQ_DB_PATH). Fail-soft on bad input.
 */
'use strict';
const newsdb = require('./news_db');

const clean = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();

let _schemaReady = false;
function ensureSchema() {
  if (_schemaReady) return;
  newsdb.get().exec(`
    CREATE TABLE IF NOT EXISTS news_items (
      id            INTEGER PRIMARY KEY,
      source        TEXT NOT NULL,
      source_kind   TEXT NOT NULL DEFAULT 'rss',   -- 'rss' | 'aggregator' | 'video'
      source_url    TEXT,
      title         TEXT,
      url_or_guid   TEXT NOT NULL,
      ts            INTEGER NOT NULL,              -- published time (ms); falls back to first_seen
      first_seen_ts INTEGER NOT NULL,             -- when WE first collected it (retention key)
      summary       TEXT,
      members       TEXT,                          -- aggregator sub-items [{outlet,headline}] as JSON
      story_id      INTEGER,                        -- filled by Stage-2 clustering (later slice)
      layer_id      INTEGER,                        -- filled by the hourly pass (later slice)
      category      TEXT,                            -- news-tuner topic key (cloud-classified once, cached); NULL = not yet classified
      seen          INTEGER NOT NULL DEFAULT 0,
      UNIQUE(source, url_or_guid)
    );
    CREATE INDEX IF NOT EXISTS idx_news_items_ts ON news_items(ts);
    CREATE INDEX IF NOT EXISTS idx_news_items_first_seen ON news_items(first_seen_ts);
    CREATE INDEX IF NOT EXISTS idx_news_items_story ON news_items(story_id);
    CREATE INDEX IF NOT EXISTS idx_news_items_layer ON news_items(layer_id);
    CREATE INDEX IF NOT EXISTS idx_news_items_category ON news_items(category);
  `);
  // migration: add `category` to a pre-existing news_items table (the tuner's topic key).
  try {
    const cols = newsdb.get().prepare('PRAGMA table_info(news_items)').all().map((c) => c.name);
    if (!cols.includes('category')) newsdb.get().exec('ALTER TABLE news_items ADD COLUMN category TEXT');
  } catch { /* fresh table already has it */ }
  _schemaReady = true;
}

// Insert ONE item into the reservoir with same-source dedup. Returns {inserted, id, duplicate?}.
// Fail-soft: a row missing source or url_or_guid is rejected (not thrown).
function insertItem(it, nowMs = Date.now()) {
  ensureSchema();
  const source = clean(it && it.source);
  const urlOrGuid = clean(it && (it.urlOrGuid != null ? it.urlOrGuid : it.url_or_guid));
  if (!source || !urlOrGuid) return { inserted: false, reason: 'missing source/id' };
  const ts = Number(it.ts) || nowMs;   // no/zero publish time → stamp with collection time
  const info = newsdb.get().prepare(
    `INSERT INTO news_items (source, source_kind, source_url, title, url_or_guid, ts, first_seen_ts, summary, members, seen)
     VALUES (@source, @source_kind, @source_url, @title, @url_or_guid, @ts, @first_seen_ts, @summary, @members, 0)
     ON CONFLICT(source, url_or_guid) DO NOTHING`
  ).run({
    source,
    source_kind: clean(it.sourceKind != null ? it.sourceKind : it.source_kind) || 'rss',
    source_url: clean(it.sourceUrl != null ? it.sourceUrl : it.source_url) || null,
    title: clean(it.title) || null,
    url_or_guid: urlOrGuid,
    ts,
    first_seen_ts: nowMs,
    summary: it.summary != null ? String(it.summary).slice(0, 2000) : null,
    members: it.members ? JSON.stringify(it.members) : null,
  });
  if (info.changes > 0) return { inserted: true, id: info.lastInsertRowid };
  const row = newsdb.get().prepare('SELECT id FROM news_items WHERE source = ? AND url_or_guid = ?').get(source, urlOrGuid);
  return { inserted: false, duplicate: true, id: row ? row.id : null };
}

// Insert MANY (one transaction). Returns {inserted, duplicates, rejected, total}.
function insertItems(items = [], nowMs = Date.now()) {
  ensureSchema();
  let inserted = 0, duplicates = 0, rejected = 0;
  const tx = newsdb.get().transaction((list) => {
    for (const it of list) {
      const r = insertItem(it, nowMs);
      if (r.inserted) inserted++;
      else if (r.duplicate) duplicates++;
      else rejected++;
    }
  });
  tx(Array.isArray(items) ? items : []);
  return { inserted, duplicates, rejected, total: Array.isArray(items) ? items.length : 0 };
}

function hydrate(r) {
  if (r && r.members) { try { r.members = JSON.parse(r.members); } catch { r.members = null; } }
  return r;
}

// Newest-first items published at/after sinceMs (the snapshot / "dam" window read).
function recentItems({ sinceMs = 0, limit = 200 } = {}) {
  ensureSchema();
  return newsdb.get().prepare('SELECT * FROM news_items WHERE ts >= ? ORDER BY ts DESC LIMIT ?').all(sinceMs, limit).map(hydrate);
}

// Items in [startMs, endMs) oldest-first (the hourly pass reads one hour).
function itemsInWindow(startMs, endMs) {
  ensureSchema();
  return newsdb.get().prepare('SELECT * FROM news_items WHERE ts >= ? AND ts < ? ORDER BY ts ASC').all(startMs, endMs).map(hydrate);
}

// UN-CLUSTERED items in [startMs, endMs] oldest-first — the compression orchestrator's input. The
// story_id IS NULL guard makes the compression idempotent: whether it's triggered on the hour OR
// on-demand by a snapshot, an item is clustered at most once (the other run sees it already claimed).
function unclusteredInWindow(startMs, endMs) {
  ensureSchema();
  return newsdb.get().prepare('SELECT * FROM news_items WHERE story_id IS NULL AND ts >= ? AND ts <= ? ORDER BY ts ASC').all(startMs, endMs).map(hydrate);
}

// Retention: drop items first collected before cutoffMs. Returns rows removed. (Uses first_seen_ts,
// not ts — a late-arriving item with an old publish date shouldn't be pruned the instant we see it.)
function pruneOlderThan(cutoffMs) {
  ensureSchema();
  return newsdb.get().prepare('DELETE FROM news_items WHERE first_seen_ts < ?').run(cutoffMs).changes;
}

function countItems() {
  ensureSchema();
  return newsdb.get().prepare('SELECT COUNT(*) AS n FROM news_items').get().n;
}

// --- News-tuner topic classification (cloud-on-everything, classify-once, cached) ---
// The un-classified NEWEST-first items the collector's topic pass should label (feed shows recent first, so
// classify recent first). Excludes dropped (story_id = -1). Limited per call → paced backfill of the backlog.
function uncategorizedItems({ limit = 40 } = {}) {
  ensureSchema();
  return newsdb.get().prepare('SELECT * FROM news_items WHERE category IS NULL AND (story_id IS NULL OR story_id <> -1) ORDER BY first_seen_ts DESC LIMIT ?').all(limit).map(hydrate);
}
// Write category verdicts back. `verdict` = { [itemId]: 'topicKey' }. Cached forever (never re-classified).
function setCategories(verdict = {}) {
  ensureSchema();
  const entries = Object.entries(verdict || {}).filter(([, c]) => c);
  if (!entries.length) return 0;
  const stmt = newsdb.get().prepare('UPDATE news_items SET category = ? WHERE id = ?');
  const tx = newsdb.get().transaction((list) => { let n = 0; for (const [id, cat] of list) n += stmt.run(String(cat), Number(id)).changes; return n; });
  return tx(entries);
}
// Look up cached categories for a set of dedup keys (feed enrichment): { [url_or_guid]: category }.
function categoriesByGuid(guids = []) {
  ensureSchema();
  const list = (Array.isArray(guids) ? guids : []).filter(Boolean).map(String);
  if (!list.length) return {};
  const out = {};
  const stmt = newsdb.get().prepare('SELECT url_or_guid, category FROM news_items WHERE url_or_guid = ? AND category IS NOT NULL LIMIT 1');
  for (const g of list) { const r = stmt.get(g); if (r && r.category) out[g] = r.category; }
  return out;
}

// Mark items as PROCESSED-BUT-DROPPED (story_id = -1 sentinel): excluded from clustering and from
// unclusteredInWindow's `story_id IS NULL` guard, so they're never re-fetched. Used by the compression
// ad-filter to retire advertisement video segments without deleting them (auditable). Returns count.
function markDropped(ids = []) {
  ensureSchema();
  const list = (Array.isArray(ids) ? ids : []).filter((x) => x != null);
  if (!list.length) return 0;
  const stmt = newsdb.get().prepare('UPDATE news_items SET story_id = -1 WHERE id = ? AND story_id IS NULL');
  const tx = newsdb.get().transaction((l) => { let n = 0; for (const id of l) n += stmt.run(id).changes; return n; });
  return tx(list);
}

// PURE: a studio/feeds_view merged item {id,title,link,summary,source,sourceUrl,publishedMs} →
// an insertItem() shape. `id` there is already guid||link||"feed|title" (a stable dedup key). null on junk.
function fromFeedItem(fi, { sourceKind = 'rss' } = {}) {
  if (!fi) return null;
  const urlOrGuid = clean(fi.id || fi.link);
  if (!urlOrGuid) return null;
  return {
    source: clean(fi.source) || 'rss',
    sourceKind,
    sourceUrl: clean(fi.sourceUrl) || null,
    title: clean(fi.title) || null,
    urlOrGuid,
    ts: Number(fi.publishedMs) || 0,   // 0 → insertItem stamps collection time
    summary: fi.summary != null ? String(fi.summary) : null,
    members: Array.isArray(fi.members) ? fi.members : undefined,   // aggregator sub-items, if upstream provided them
  };
}

module.exports = {
  ensureSchema, insertItem, insertItems, recentItems, itemsInWindow, unclusteredInWindow, pruneOlderThan, countItems, markDropped, fromFeedItem,
  uncategorizedItems, setCategories, categoriesByGuid,
};
