/**
 * lib/news_db.js — the Data-Stream Lane's OWN database (the raw bucket + working stores).
 *
 * Decision (Lucas, 2026-07-02): the raw news bucket must be PHYSICALLY SEPARATE from the memory DB
 * (sq.db). Raw items are high-volume and must never pollute the memory store — only CLEANED, VALIDATED
 * news objects (post-compression) promote into short-term memory (doc_store) and then long-term (Echo).
 * Keeping the bucket in its own file also lets collection run live WITHOUT writing prod sq.db.
 *
 * Holds: news_items, news_captions, news_stories, news_story_updates, news_layers, news_watch.
 * The daily-pass PROMOTION (news_lane.runDailyPass) is the only thing that crosses out of here — into
 * sq.db (doc_store) + Echo — and it does so through injected deps, not this handle.
 *
 * Path: NEWS_DB_PATH env override (smokes/tests use a temp file) else data/news_bucket.db. Lazy-opened.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.NEWS_DB_PATH || path.join(__dirname, '..', 'data', 'news_bucket.db');
let _db = null;

function get() {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  return _db;
}
function close() { if (_db) { try { _db.close(); } catch {} _db = null; } }

module.exports = { get, close, DB_PATH };
