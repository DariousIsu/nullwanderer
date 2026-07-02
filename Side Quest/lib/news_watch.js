/**
 * lib/news_watch.js — the Data-Stream Lane WATCHLIST + deterministic matcher (design §"Mode 1 — WATCH").
 *
 * The continuous, MODEL-FREE relevance tier: a keyword/phrase/concept watchlist, matched against each
 * reservoir item's title+summary. A hit is what surfaces a source-grounded pointer (the surfacing itself
 * is the later main.js wiring). The hourly thinking pass FEEDS this list (missed-trigger → feedTerm), so
 * the deterministic tier learns over time. Owns its own `news_watch` table (self-schema; fold into db.js
 * MIGRATIONS at integration). Pure matcher (`termMatches`) is exported + unit-tested.
 *
 * Match semantics (deterministic, no embeddings):
 *   keyword — whole-word match of the term (word boundaries), case-insensitive.
 *   phrase  — normalized contiguous substring.
 *   concept — ALL of the term's significant words (>=3 chars) present as whole words, order-independent.
 */
'use strict';
const newsdb = require('./news_db');

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A normalized dedup key for a term so "Mike Lee" / "mike  lee" collapse to one row.
const termKey = (t) => norm(t).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// PURE: does `term` (of `kind`) occur in `text`? Deterministic.
function termMatches(term, kind, text) {
  const t = norm(text); const q = norm(term);
  if (!t || !q) return false;
  if (kind === 'phrase') return t.includes(q);
  if (kind === 'concept') {
    const words = q.split(' ').filter((w) => w.length >= 3);
    return words.length > 0 && words.every((w) => new RegExp(`\\b${escapeRe(w)}\\b`).test(t));
  }
  return new RegExp(`\\b${escapeRe(q)}\\b`).test(t);   // keyword (default)
}

let _schemaReady = false;
function ensureSchema() {
  if (_schemaReady) return;
  newsdb.get().exec(`
    CREATE TABLE IF NOT EXISTS news_watch (
      id           INTEGER PRIMARY KEY,
      term         TEXT NOT NULL,
      term_key     TEXT NOT NULL UNIQUE,
      kind         TEXT NOT NULL DEFAULT 'keyword',   -- 'keyword' | 'phrase' | 'concept'
      origin       TEXT NOT NULL DEFAULT 'manual',    -- 'conversation' | 'hourly' | 'manual'
      weight       REAL NOT NULL DEFAULT 1.0,
      hits         INTEGER NOT NULL DEFAULT 0,
      last_hit_ts  INTEGER,
      created_at   INTEGER NOT NULL,
      active       INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_news_watch_active ON news_watch(active);
  `);
  _schemaReady = true;
}

// Add (or reactivate) a watch term. Idempotent on the normalized term_key. Returns {added, existed, id}.
// Existence is checked explicitly (not via ON CONFLICT) so added/existed are unambiguous.
function addTerm({ term, kind = 'keyword', origin = 'manual', weight = 1.0 } = {}, nowMs = Date.now()) {
  ensureSchema();
  const key = termKey(term);
  if (!key) return { added: false, reason: 'empty term' };
  const existing = newsdb.get().prepare('SELECT id, active FROM news_watch WHERE term_key = ?').get(key);
  if (existing) {
    if (!existing.active) newsdb.get().prepare('UPDATE news_watch SET active = 1 WHERE id = ?').run(existing.id);  // re-seeing reactivates
    return { added: false, existed: true, id: existing.id };
  }
  const info = newsdb.get().prepare(
    'INSERT INTO news_watch (term, term_key, kind, origin, weight, created_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)'
  ).run(norm(term), key, kind, origin, weight, nowMs);
  return { added: true, existed: false, id: info.lastInsertRowid };
}

// The hourly pass's missed-trigger → watchlist feed (origin 'hourly'). Thin wrapper for intent clarity.
function feedTerm(term, { kind = 'concept' } = {}, nowMs = Date.now()) {
  return addTerm({ term, kind, origin: 'hourly' }, nowMs);
}

function deactivate(term) {
  ensureSchema();
  return newsdb.get().prepare('UPDATE news_watch SET active = 0 WHERE term_key = ?').run(termKey(term)).changes > 0;
}

function activeTerms() {
  ensureSchema();
  return newsdb.get().prepare('SELECT * FROM news_watch WHERE active = 1 ORDER BY weight DESC, id ASC').all();
}

function recordHit(id, nowMs = Date.now()) {
  ensureSchema();
  newsdb.get().prepare('UPDATE news_watch SET hits = hits + 1, last_hit_ts = ? WHERE id = ?').run(nowMs, id);
}

// Match ONE item (title + summary) against the active watchlist. Returns the matched terms
// [{id, term, kind, weight}]; bumps their hit counters unless {record:false}. Deterministic.
function matchItem(item, { terms = null, record = true, nowMs = Date.now() } = {}) {
  ensureSchema();
  const text = `${(item && item.title) || ''} ${(item && item.summary) || ''}`;
  const list = terms || activeTerms();
  const hits = [];
  for (const w of list) {
    if (termMatches(w.term, w.kind, text)) {
      hits.push({ id: w.id, term: w.term, kind: w.kind, weight: w.weight });
      if (record && w.id != null) recordHit(w.id, nowMs);
    }
  }
  return hits;
}

module.exports = {
  termMatches, ensureSchema, addTerm, feedTerm, deactivate, activeTerms, recordHit, matchItem, termKey,
};
