/* Smoke: lib/story_follow — developing stories she follows (memory slice 1B). Deterministic: a temp
 * NEWS_DB_PATH bucket seeded directly; no model/network/prod stores.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_story_follow.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// MUST precede any lib require — news_db reads the env at module load.
const TMP = path.join(os.tmpdir(), `zoe-smoke-story-follow-${process.pid}.db`);
process.env.NEWS_DB_PATH = TMP;

const newsdb = require('../lib/news_db');
const lane = require('../lib/news_lane');
const sf = require('../lib/story_follow');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const NOW = Date.UTC(2026, 6, 22, 16, 0);
const HOUR = 3600e3;

function seedStory({ id, title, entities = [], outlets = 2, reports = 2, lastTs = NOW - 2 * HOUR, status = 'open' }) {
  newsdb.get().prepare(`INSERT INTO news_stories (id, cluster_key, title, entity_set, source_set, source_count, update_count,
      outlet_set, outlet_count, report_set, report_count, first_ts, last_ts, summary, status, created_at)
    VALUES (?, ?, ?, ?, '[]', 1, 1, '[]', ?, '[]', ?, ?, ?, ?, ?, ?)`)
    .run(id, `k${id}`, title, JSON.stringify(entities), outlets, reports, lastTs - HOUR, lastTs, `${title} summary`, status, lastTs - HOUR);
}
function moveStory(id, ts, { source = 'AP', title = 'a new development' } = {}) {
  newsdb.get().prepare('UPDATE news_stories SET last_ts = ?, update_count = update_count + 1 WHERE id = ?').run(ts, id);
  newsdb.get().prepare('INSERT INTO news_story_updates (story_id, ts, kind, source, title, summary, outlets, signal) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)')
    .run(id, ts, 'update', source, title, `${title} summary`, JSON.stringify([source]));
}

(async () => {
  lane.ensureSchema();
  sf.ensureSchema();
  seedStory({ id: 1, title: 'Fed signals a rate pause', entities: ['fed', 'rates'] });
  seedStory({ id: 2, title: 'Hurricane track shifts east', entities: ['hurricane'] });

  // --- follow baseline: the story's PAST is not a development ---
  const f1 = sf.follow(1, { reason: 'discussed', nowMs: NOW });
  ok(f1.followed === true, 'a discussed story is followed');
  ok(sf.deltas({ nowMs: NOW }).length === 0, 'following starts the clock at last_ts — no instant "delta" from its past');

  // --- movement surfaces as a delta with WHAT changed ---
  moveStory(1, NOW + HOUR, { source: 'Reuters', title: 'Fed chair confirms pause through September' });
  const d1 = sf.deltas({ nowMs: NOW + 2 * HOUR });
  ok(d1.length === 1 && d1[0].storyId === 1 && d1[0].newCount === 1, 'a new report on a followed story surfaces as a delta');
  ok(d1[0].latest[0].source === 'Reuters' && /confirms pause/.test(d1[0].latest[0].title), 'the delta carries WHAT changed (headline + source)');

  const lines = sf.manifestLines({ nowMs: NOW + 2 * HOUR });
  ok(lines.length === 1 && /\[story #1\]/.test(lines[0]), 'manifest line carries the [story #N] machine handle');
  ok(/never raised with him/.test(lines[0]) && /you two discussed this/.test(lines[0]), 'line states raise-state + why she follows it');
  ok(/Reuters/.test(lines[0]), 'line carries the latest headline source');

  // --- markRaised re-baselines: one development is raised ONCE ---
  ok(sf.markRaised(1, NOW + 3 * HOUR) === true, 'markRaised acknowledges the raise');
  ok(sf.deltas({ nowMs: NOW + 3 * HOUR }).length === 0, 'after raising, the same development never re-surfaces');
  moveStory(1, NOW + 5 * HOUR, { source: 'AP', title: 'Markets react to the pause' });
  const lines2 = sf.manifestLines({ nowMs: NOW + 6 * HOUR });
  ok(lines2.length === 1 && /last raised 3h ago/.test(lines2[0]), 'a NEW development surfaces, with when she last raised it');

  // --- re-follow keeps the baseline; reason only upgrades toward discussed ---
  sf.follow(1, { reason: 'interest', nowMs: NOW + 6 * HOUR });
  ok(sf.deltas({ nowMs: NOW + 6 * HOUR })[0].reason === 'discussed', 're-follow never demotes discussed → interest, never resets the baseline');
  sf.follow(2, { reason: 'interest', nowMs: NOW });
  moveStory(2, NOW + HOUR, { source: 'NHC', title: 'Landfall now expected near Tampa' });
  const l2 = sf.manifestLines({ nowMs: NOW + 2 * HOUR }).find((l) => /\[story #2\]/.test(l));
  ok(!!l2 && /matches your interests/.test(l2), 'an interest-followed story states its reason honestly');

  // --- tidy retires wrapped stories ---
  newsdb.get().prepare("UPDATE news_stories SET status = 'closed', last_ts = ? WHERE id = 2").run(NOW - 10 * 24 * HOUR);
  ok(sf.tidy({ nowMs: NOW }) === 1, 'a closed story quiet past the window is retired');
  ok(!sf.manifestLines({ nowMs: NOW + 2 * HOUR }).some((l) => /\[story #2\]/.test(l)), 'a retired follow never surfaces');

  // --- the active cap retires the stalest first ---
  for (let i = 10; i < 10 + sf.MAX_ACTIVE; i++) { seedStory({ id: i, title: `Filler story ${i}` }); sf.follow(i, { nowMs: NOW + i }); }
  const active = newsdb.get().prepare('SELECT COUNT(*) n FROM news_story_follow WHERE active = 1').get().n;
  ok(active <= sf.MAX_ACTIVE, `follows stay a bounded working set (≤${sf.MAX_ACTIVE})`);
  ok(newsdb.get().prepare('SELECT active FROM news_story_follow WHERE story_id = 1').get().active === 1
    && newsdb.get().prepare('SELECT active FROM news_story_follow WHERE story_id = 10').get().active === 0,
    'eviction retires the least-recently-seen filler — the discussed, still-moving story survives the cap');

  // --- auto-follow from interests: fresh + corroborated only ---
  seedStory({ id: 90, title: 'Neuromorphic chips hit a milestone', entities: ['neuromorphic', 'chips'], outlets: 3, reports: 3, lastTs: NOW - HOUR });
  seedStory({ id: 91, title: 'Neuromorphic single-source rumor', entities: ['neuromorphic'], outlets: 1, reports: 1, lastTs: NOW - HOUR });
  const af = sf.autoFollowFromInterests(['neuromorphic computing'], { nowMs: NOW });
  const f90 = newsdb.get().prepare('SELECT reason, active FROM news_story_follow WHERE story_id = 90').get();
  const f91 = newsdb.get().prepare('SELECT * FROM news_story_follow WHERE story_id = 91').get();
  ok(af.followed >= 1 && f90 && f90.active === 1 && f90.reason === 'interest', 'a fresh corroborated interest match is auto-followed');
  ok(!f91 || !f91.active, 'a single-source story is NOT auto-followed (corroboration floor holds)');

  newsdb.close();
  try { fs.unlinkSync(TMP); } catch {}
  try { fs.unlinkSync(TMP + '-wal'); fs.unlinkSync(TMP + '-shm'); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
