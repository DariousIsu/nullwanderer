/* Compress the REAL live-collected bucket (a copy, set via NEWS_DB_PATH) into stories + a brief.
 * Proves the full pipeline on genuinely-collected data. Read the bucket, cluster, show confirmation +
 * the deterministic brief. Run against a COPY so it never contends with the running collector:
 *   NEWS_DB_PATH=<copy> ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/news_live_test.js
 */
'use strict';
const store = require('../lib/news_store');
const lane = require('../lib/news_lane');
const brief = require('../lib/news_brief');

const NOW = Date.now();
(async () => {
  const items = store.unclusteredInWindow(0, NOW + 1);
  await lane.clusterItems(items, { now: NOW, maxAgeMs: 72 * 3600 * 1000 });   // generous window across the collected span
  const stories = lane.storiesActiveInWindow(0);
  console.log(`\n=== LIVE BUCKET: ${items.length} collected items → ${stories.length} stories ===\n`);
  const ranked = stories.slice().sort((a, b) => (b.outlet_count - a.outlet_count) || (b.update_count - a.update_count));
  for (const s of ranked.slice(0, 18)) {
    const c = lane.storyConfirmation(s);
    console.log(`• [${c.outletCount} outlet(s) · ${c.tier}${s.update_count > 1 ? ' · DEVELOPING' : ''}${c.redaction ? ' · ⚠REDACTION' : ''}] ${s.title}`);
  }
  const deltas = {}; for (const s of stories) deltas[s.id] = lane.storyDeltas(s.id);
  const input = brief.briefInput(stories, { deltasByStory: deltas });
  console.log('\n=== DETERMINISTIC BRIEF (from live-collected data) ===\n');
  console.log(brief.renderBrief(brief.fallbackBrief(input), input, { windowLabel: 'the last few hours (LIVE bucket)', nowIso: new Date(NOW).toISOString() }));
})();
