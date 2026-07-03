/* Smoke: lib/news_store — the Data-Stream Lane RESERVOIR (Slice 1). Proves per-source-dedup insertion,
 * the ts fallback, window/recent queries, retention prune, aggregator members round-trip, and the
 * feeds_view→item bridge. ISOLATED temp DB (SQ_DB_PATH). Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_store.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// isolated throwaway DB BEFORE requiring db
const tmp = path.join(os.tmpdir(), `sq_newsstore_smoke_${process.pid}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.NEWS_DB_PATH = tmp;

const store = require('../lib/news_store');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const T0 = 1_000_000_000_000;   // fixed base ms for deterministic ts

// --- insert + same-source dedup ---
const a = store.insertItem({ source: 'BBC', urlOrGuid: 'g1', title: 'Kyiv attack', ts: T0, summary: 's' });
ok(a.inserted === true && a.id, 'new item inserts');
const a2 = store.insertItem({ source: 'BBC', urlOrGuid: 'g1', title: 'Kyiv attack (updated)', ts: T0 + 5 });
ok(a2.inserted === false && a2.duplicate === true && a2.id === a.id, 'same source+guid → deduped to same id (not re-inserted)');
const a3 = store.insertItem({ source: 'CNN', urlOrGuid: 'g1', title: 'Kyiv attack', ts: T0 });
ok(a3.inserted === true && a3.id !== a.id, 'SAME guid, DIFFERENT source → inserted (dedup is same-source only — wire stories stay separate)');
ok(store.countItems() === 2, 'countItems reflects 2 distinct (source,guid) rows');

// --- rejection of junk ---
ok(store.insertItem({ urlOrGuid: 'x' }).inserted === false, 'missing source → rejected (no throw)');
ok(store.insertItem({ source: 'X' }).inserted === false, 'missing url_or_guid → rejected (no throw)');

// --- ts fallback to collection time ---
const now = T0 + 999;
const b = store.insertItem({ source: 'NPR', urlOrGuid: 'n1', title: 'no date' }, now);
const bRow = store.recentItems({ sinceMs: 0, limit: 50 }).find(r => r.id === b.id);
ok(bRow && bRow.ts === now, 'item with no publish time is stamped with collection time');

// --- batch insert with a dup inside it ---
const batch = store.insertItems([
  { source: 'Verge', urlOrGuid: 'v1', title: 'A', ts: T0 + 10 },
  { source: 'Verge', urlOrGuid: 'v1', title: 'A dup', ts: T0 + 11 },   // dup in-batch
  { source: 'Verge', urlOrGuid: 'v2', title: 'B', ts: T0 + 12 },
  { source: '', urlOrGuid: 'v3' },                                     // rejected
]);
ok(batch.inserted === 2 && batch.duplicates === 1 && batch.rejected === 1 && batch.total === 4, 'insertItems tallies inserted/duplicates/rejected');

// --- recentItems: sinceMs filter + newest-first ordering ---
const recent = store.recentItems({ sinceMs: T0 + 10, limit: 50 });
ok(recent.length >= 2 && recent[0].ts >= recent[recent.length - 1].ts, 'recentItems is newest-first');
ok(recent.every(r => r.ts >= T0 + 10), 'recentItems honors sinceMs');

// --- itemsInWindow: [start,end) bounds oldest-first ---
const win = store.itemsInWindow(T0, T0 + 12);   // excludes T0+12
const winGuids = win.map(r => r.url_or_guid);
ok(winGuids.includes('v1') && !winGuids.includes('v2'), 'itemsInWindow is half-open [start,end)');
ok(win.every((r, i) => i === 0 || r.ts >= win[i - 1].ts), 'itemsInWindow is oldest-first');

// --- aggregator members round-trip (JSON) ---
const agg = store.insertItem({ source: 'Google News', sourceKind: 'aggregator', urlOrGuid: 'gn1', title: 'Kyiv cluster', ts: T0 + 20, members: [{ outlet: 'NBC', headline: 'x' }, { outlet: 'NYT', headline: 'y' }] });
const aggRow = store.recentItems({ limit: 100 }).find(r => r.id === agg.id);
ok(aggRow && aggRow.source_kind === 'aggregator' && Array.isArray(aggRow.members) && aggRow.members.length === 2 && aggRow.members[0].outlet === 'NBC', 'aggregator members round-trip as parsed JSON');

// --- retention prune by first_seen_ts ---
const before = store.countItems();
store.insertItem({ source: 'Old', urlOrGuid: 'o1', title: 'ancient', ts: T0 }, T0 - 100000);   // first_seen far in the past
const pruned = store.pruneOlderThan(T0 - 50000);
ok(pruned === 1 && store.countItems() === before, 'pruneOlderThan drops rows by first_seen_ts, keeps fresh ones');

// --- fromFeedItem: feeds_view merged item → insert shape ---
const fv = store.fromFeedItem({ id: 'guid-123', title: '  Hello   world ', link: 'http://x/y', summary: '<b>hi</b>', source: 'Reuters', sourceUrl: 'http://reuters/rss', publishedMs: T0 + 55 });
ok(fv && fv.urlOrGuid === 'guid-123' && fv.ts === T0 + 55 && fv.source === 'Reuters' && fv.title === 'Hello world', 'fromFeedItem maps id→urlOrGuid, publishedMs→ts, cleans title');
ok(store.fromFeedItem({ title: 'no id or link' }) === null, 'fromFeedItem returns null when no dedup key');
const fv2 = store.fromFeedItem({ link: 'http://only/link', title: 't', source: 'S' });
ok(fv2 && fv2.urlOrGuid === 'http://only/link' && fv2.ts === 0, 'fromFeedItem falls back to link when no guid; ts 0 → store stamps now');
const fvm = store.fromFeedItem({ id: 'agg1', title: 'X', source: 'Google News', publishedMs: 5, members: [{ outlet: 'NBC' }, { outlet: 'NYT' }] });
ok(fvm && Array.isArray(fvm.members) && fvm.members.length === 2, 'fromFeedItem carries aggregator members through to the store');

// --- news-tuner category: classify-once + cache (uncategorizedItems / setCategories / categoriesByGuid) ---
const c1 = store.insertItem({ source: 'ESPN', urlOrGuid: 'cat-1', title: 'World Cup result', ts: T0 + 200 });
const c2 = store.insertItem({ source: 'NWS', urlOrGuid: 'cat-2', title: 'Hurricane nears coast', ts: T0 + 201 });
const uncat = store.uncategorizedItems({ limit: 100 });
ok(uncat.some(r => r.id === c1.id) && uncat.some(r => r.id === c2.id), 'uncategorizedItems returns items with NULL category');
const wrote = store.setCategories({ [c1.id]: 'sports', [c2.id]: 'weather' });
ok(wrote === 2, 'setCategories writes both verdicts');
const after = store.uncategorizedItems({ limit: 100 }).map(r => r.id);
ok(!after.includes(c1.id) && !after.includes(c2.id), 'classified items drop out of uncategorizedItems (cached, never re-classified)');
const byGuid = store.categoriesByGuid(['cat-1', 'cat-2', 'nope']);
ok(byGuid['cat-1'] === 'sports' && byGuid['cat-2'] === 'weather' && byGuid['nope'] === undefined, 'categoriesByGuid returns cached categories by dedup key');
const droppedItem = store.insertItem({ source: 'X', urlOrGuid: 'cat-drop', title: 'ad' });
store.markDropped([droppedItem.id]);
ok(!store.uncategorizedItems({ limit: 100 }).some(r => r.id === droppedItem.id), 'uncategorizedItems excludes dropped (story_id=-1) items');

// --- video reconstruction helpers: updateItemText (clean headline) + absorbItems (fold flushes) ---
const rep = store.insertItem({ source: 'CNN', sourceKind: 'video', urlOrGuid: 'vid-rep', title: 'RAW ALL CAPS FRAGMENT', summary: 'raw', ts: T0 + 300 });
const mem = store.insertItem({ source: 'CNN', sourceKind: 'video', urlOrGuid: 'vid-mem', title: 'another fragment', ts: T0 + 301 });
ok(store.updateItemText(rep.id, { title: 'US-Iran tensions rise over Strait of Hormuz', summary: 'clean', entities: ['Iran', 'Strait of Hormuz'] }) === true, 'updateItemText overwrites a garbled caption with a clean headline');
const cleaned = store.recentItems({ limit: 200 }).find(r => r.id === rep.id);
ok(cleaned && /Hormuz/.test(cleaned.title) && cleaned.summary === 'clean', 'updateItemText persisted the reconstructed title + summary');
ok(cleaned && JSON.parse(cleaned.entities || '[]').includes('Iran'), 'updateItemText persisted the canonical entities (JSON) for the bridge');
ok(store.absorbItems([mem.id]) === 1, 'absorbItems folds a non-representative flush (story_id=-2)');
ok(!store.unclusteredInWindow(T0, T0 + 1000).some(r => r.id === mem.id), 'absorbed item is excluded from clustering (unclusteredInWindow)');
ok(store.unclusteredInWindow(T0, T0 + 1000).some(r => r.id === rep.id), 'the representative still clusters');

try { fs.unlinkSync(tmp); } catch {}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
