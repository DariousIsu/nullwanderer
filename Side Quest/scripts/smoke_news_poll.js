/* Smoke: lib/news_poll — the RSS collector orchestration (Slice 2). Proves a poll tick fetches →
 * normalizes → dedup-inserts into the real reservoir, aggregator tagging, cross-tick dedup, fail-soft
 * on fetch errors/bad deps, and the start/stop lifecycle. ISOLATED temp DB (SQ_DB_PATH), mocked fetch
 * (no engine/network). Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_poll.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `sq_newspoll_smoke_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.NEWS_DB_PATH = tmp;

const store = require('../lib/news_store');
const poll = require('../lib/news_poll');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// feeds_view-shaped payload (what feeds:fetch → mergeReports returns)
const PAYLOAD = [
  { id: 'g1', title: 'Kyiv attack', link: 'http://bbc/1', summary: 's', source: 'BBC', sourceUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml', publishedMs: 1000 },
  { id: 'g1', title: 'Kyiv attack', link: 'http://cnn/1', summary: 's', source: 'CNN', sourceUrl: 'http://rss.cnn.com/rss/edition.rss', publishedMs: 1000 }, // same guid, diff source
  { id: 'gn1', title: 'Kyiv cluster', link: 'http://news.google/1', summary: '<ol>...</ol>', source: 'Top stories - Google News', sourceUrl: 'https://news.google.com/rss', publishedMs: 1200 },
  { title: 'junk, no id or link' }, // rejected
];
const mkFetch = (items) => async () => ({ ok: true, items });

(async () => {
  // --- classifySourceKind (PURE) ---
  ok(poll.classifySourceKind({ sourceUrl: 'https://news.google.com/rss' }) === 'aggregator', 'Google News → aggregator');
  ok(poll.classifySourceKind({ sourceUrl: 'https://techcrunch.com/feed/' }) === 'rss', 'normal feed → rss');
  ok(poll.classifySourceKind({ source: 'Google News' }) === 'aggregator', 'aggregator detected via source name too');

  // --- tick 1: fetch → dedup-insert ---
  const t1 = await poll.runPollTick({ fetch: mkFetch(PAYLOAD), store });
  ok(t1.ok && t1.fetched === 4 && t1.inserted === 3 && t1.dropped === 1 && t1.duplicates === 0, 'tick1: 4 fetched → 3 inserted, 1 dropped (junk, no dedup key)');
  ok(t1.fetched === t1.inserted + t1.duplicates + t1.rejected + t1.dropped, 'tick accounts for every fetched item');
  ok(store.countItems() === 3, 'reservoir has 3 rows after tick1');
  const gn = store.recentItems({ limit: 50 }).find(r => r.url_or_guid === 'gn1');
  ok(gn && gn.source_kind === 'aggregator', 'Google News item stored as source_kind=aggregator');

  // --- tick 2: same payload → all duplicates, no growth ---
  const t2 = await poll.runPollTick({ fetch: mkFetch(PAYLOAD), store });
  ok(t2.inserted === 0 && t2.duplicates === 3, 'tick2: same payload → 0 inserted, 3 duplicates');
  ok(store.countItems() === 3, 'reservoir unchanged after re-poll (idempotent)');

  // --- a genuinely new item on tick 3 lands ---
  const t3 = await poll.runPollTick({ fetch: mkFetch([{ id: 'new1', title: 'fresh', link: 'http://x/new', source: 'NPR', sourceUrl: 'https://feeds.npr.org/1001/rss.xml', publishedMs: 2000 }]), store });
  ok(t3.inserted === 1 && store.countItems() === 4, 'tick3: a new item lands');

  // --- fail-soft: fetch throws ---
  const tErr = await poll.runPollTick({ fetch: async () => { throw new Error('engine down'); }, store });
  ok(tErr.ok === false && /engine down/.test(tErr.error) && store.countItems() === 4, 'fetch error → ok:false, no throw, reservoir intact');

  // --- fail-soft: missing deps ---
  const tBad = await poll.runPollTick({});
  ok(tBad.ok === false, 'missing deps → ok:false (no throw)');

  // --- fetch returns non-ok / empty items ---
  const tEmpty = await poll.runPollTick({ fetch: async () => ({ ok: true, items: [] }), store });
  ok(tEmpty.ok === true && tEmpty.inserted === 0, 'empty fetch → ok, 0 inserted');

  // --- lifecycle: start/stop ---
  ok(poll.isRunning() === false, 'not running initially');
  const started = poll.start({ fetch: mkFetch([]), store, initialDelayMs: 999999, intervalMs: 999999 });
  ok(started === true && poll.isRunning() === true, 'start() schedules the poller');
  ok(poll.start({ fetch: mkFetch([]), store }) === false, 'double start() is a no-op');
  poll.stop();
  ok(poll.isRunning() === false, 'stop() clears the poller');
  poll.stop(); // idempotent, no throw

  try { fs.unlinkSync(tmp); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
