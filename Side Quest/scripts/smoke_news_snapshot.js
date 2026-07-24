/* Smoke: the ONE compression path (lane.runCompression) shared by the hourly cadence + the on-demand
 * SNAPSHOT ("dam"). Proves: compression clusters un-clustered reservoir items + optionally writes a
 * layer; idempotency (story_id-NULL guard → no double-processing); snapshot triggers a FRESH compression
 * and returns a briefing WITHOUT writing a layer; and the "since <time>" window. ISOLATED temp DB. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_snapshot.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `sq_newssnap_smoke_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.NEWS_DB_PATH = tmp;

const store = require('../lib/news_store');
const lane = require('../lib/news_lane');
lane.ensureSchema();

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const T = 1_700_000_000_000;
const NOW = T + 60 * 1000;

// seed the reservoir (3 unclustered RSS items: a Kyiv pair that should merge + an unrelated story)
store.insertItem({ source: 'BBC', urlOrGuid: 'bbc1', title: "At least 18 killed in 'most massive' Russian attack on Kyiv", summary: 'mourning', ts: T });
store.insertItem({ source: 'CNN', urlOrGuid: 'cnn1', title: 'At least 18 killed in most massive Russian attack on Kyiv city', summary: 'same attack', ts: T + 1000 });
store.insertItem({ source: 'US News', urlOrGuid: 'goog1', title: 'Google loses fight over record $4.7 billion EU antitrust fine', summary: 'android', ts: T + 2000 });

(async () => {
  // --- hourly-style compression: clusters + writes a layer ---
  const c1 = await lane.runCompression({ store, startMs: T - 1000, endMs: NOW, now: NOW, writeLayer: true });
  ok(c1.items === 3, 'compression reads the 3 un-clustered items');
  ok(c1.created === 2 && c1.attached === 1, 'clusters into 2 stories (Kyiv pair merges via S≥.60, Google separate)');
  ok(c1.layerId && lane.recentLayers(5).length === 1, 'writeLayer:true persists an hourly layer');
  ok(/\(2 outlets\)/.test(c1.briefing), 'briefing labels the corroborated Kyiv story (outlets)');
  ok(store.unclusteredInWindow(T - 1000, NOW).length === 0, 'all items now clustered (story_id set)');

  // --- idempotency: re-running finds nothing to cluster ---
  const c2 = await lane.runCompression({ store, startMs: T - 1000, endMs: NOW, now: NOW, writeLayer: true });
  ok(c2.items === 0 && c2.created === 0 && c2.attached === 0, 'second compression: 0 un-clustered items → no double-processing');
  ok(lane.allStories().length === 2, 'story count unchanged (still 2)');

  // --- snapshot triggers a FRESH compression on a newly-arrived item, no layer written ---
  const layersBefore = lane.recentLayers(50).length;
  store.insertItem({ source: 'NPR', urlOrGuid: 'npr1', title: 'Breaking development in the Russian attack on Kyiv', summary: 'update', ts: NOW });
  const snap = await lane.snapshot({ store, now: NOW + 1000 });
  ok(snap.freshItems === 1, 'snapshot compresses the 1 newly-arrived un-clustered item (fresh)');
  ok(store.unclusteredInWindow(T - 1000, NOW + 1000).length === 0, 'snapshot left nothing un-clustered');
  ok(lane.recentLayers(50).length === layersBefore, 'snapshot does NOT write a layer (writeLayer:false)');
  ok(typeof snap.briefing === 'string' && snap.briefing.length > 0, 'snapshot returns a briefing');
  ok(snap.since === lane.startOfDayMs(NOW + 1000), 'snapshot default window = start of today');

  // --- "update since <time>" window ---
  const snap2 = await lane.snapshot({ store, sinceMs: T + 1500, now: NOW + 2000 });
  ok(snap2.since === T + 1500, 'snapshot honors an explicit sinceMs window');
  ok(snap2.freshItems === 0, 'snapshot since<t> with nothing new → 0 fresh items (idempotent), still returns a briefing');

  try { fs.unlinkSync(tmp); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
