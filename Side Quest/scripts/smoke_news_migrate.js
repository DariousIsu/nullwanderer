/* Smoke: news_store MIGRATION path — an EXISTING bucket with the pre-tuner schema (no `category` column)
 * must migrate cleanly. Regression guard for the bug where a `CREATE INDEX ON news_items(category)` sat
 * inside the initial CREATE block and threw ("no such column: category") on old DBs, aborting ensureSchema
 * and stalling collection. The normal smoke uses a FRESH db (table built WITH category) so it can't catch
 * this — we must pre-create the OLD schema. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_migrate.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const tmp = path.join(os.tmpdir(), `sq_newsmig_smoke_${process.pid}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.NEWS_DB_PATH = tmp;

// Pre-create the OLD (pre-tuner) news_items schema — no `category` column, no category index.
const raw = new Database(tmp);
raw.exec(`CREATE TABLE news_items (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_kind TEXT NOT NULL DEFAULT 'rss', source_url TEXT,
  title TEXT, url_or_guid TEXT NOT NULL, ts INTEGER NOT NULL, first_seen_ts INTEGER NOT NULL, summary TEXT,
  members TEXT, story_id INTEGER, layer_id INTEGER, seen INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source, url_or_guid));`);
raw.prepare('INSERT INTO news_items (source, url_or_guid, ts, first_seen_ts) VALUES (?,?,?,?)').run('BBC', 'g1', 1000, 1000);
raw.close();

const store = require('../lib/news_store');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

let threw = null;
try { ok(store.countItems() === 1, 'ensureSchema migrates an OLD-schema table (no category) WITHOUT throwing'); }
catch (e) { threw = e.message; ok(false, 'ensureSchema threw on the old schema: ' + e.message); }

if (!threw) {
  ok(store.uncategorizedItems({ limit: 5 }).length === 1, 'uncategorizedItems works post-migration (item has NULL category)');
  ok(store.setCategories({ 1: 'world' }) === 1, 'setCategories writes post-migration');
  ok(store.categoriesByGuid(['g1'])['g1'] === 'world', 'categoriesByGuid reads back the migrated category');
  const cols = require('../lib/news_db').get().prepare('PRAGMA table_info(news_items)').all().map((c) => c.name);
  ok(cols.includes('category'), 'category column present after migration');
}

try { fs.unlinkSync(tmp); } catch {}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
