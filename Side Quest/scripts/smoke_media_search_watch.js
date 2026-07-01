/* Smoke: media_cc search-and-watch (lib/media_cc) — "pull up clips of X on youtube" with no link →
 * search YouTube → pick the top clip → start the caption-follow watch. Deterministic: injected
 * search + start, no network/db. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_media_search_watch.js
 */
'use strict';
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_msw_${Date.now()}.db`);
require('../lib/db').init();
const mc = require('../lib/media_cc');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // --- detection ---
  ok(mc.detectSearchWatch('You can pull up clips of Zoe Barnes from house of cards on youtube if you turn the CC on') !== null,
    'the real failing message is now detected as search-and-watch');
  const q = mc.detectSearchWatch('pull up clips of Zoe Barnes from house of cards on youtube, turn CC on');
  ok(/zoe barnes/i.test(q) && /house of cards/i.test(q), 'extracts the subject ("Zoe Barnes ... house of cards")');
  ok(!/youtube|\bcc\b|turn|pull up/i.test(q), 'strips the verb / youtube / CC filler from the query');
  ok(mc.detectSearchWatch('watch this https://youtube.com/watch?v=abcdef123') === null,
    'a DIRECT link is NOT search-and-watch (normal watch path handles it)');
  ok(mc.detectSearchWatch('what do you think about house of cards?') === null,
    'a plain opinion question is not search-and-watch');
  ok(mc.detectSearchWatch('find me a good recipe') === null, 'non-media find is not search-and-watch');

  // --- pickYouTubeUrl ---
  const results = [
    { title: 'Reddit thread', url: 'https://reddit.com/r/x' },
    { title: 'HoC clip', url: 'https://www.youtube.com/watch?v=Zoe123Barnes' },
    { title: 'another', url: 'https://youtu.be/clip999' },
  ];
  ok(/youtube\.com\/watch\?v=Zoe123Barnes/.test(mc.pickYouTubeUrl(results)), 'picks the first real YouTube watch URL, skipping non-YT');
  ok(mc.pickYouTubeUrl([{ url: 'https://reddit.com/x' }]) === null, 'no YT result → null');

  // --- findAndStart (injected search + start) ---
  let startedUrl = null;
  const search = async (query) => { return /site:youtube/.test(query) ? results : []; };
  const r = await mc.findAndStart({ query: 'Zoe Barnes house of cards', deps: { search, start: (u) => { startedUrl = u; return true; } } });
  ok(r.ok && /youtube\.com\/watch/.test(r.url), 'findAndStart resolves a clip and reports ok');
  ok(startedUrl === r.url, 'findAndStart hands the resolved URL to start()');

  // fallback to the plain "<q> youtube" search when site:youtube returns nothing
  let calls = 0;
  const search2 = async () => { calls++; return calls === 1 ? [] : results; };
  const r2 = await mc.findAndStart({ query: 'x', deps: { search: search2, start: () => true } });
  ok(r2.ok && calls === 2, 'falls back to the second search when the first is empty');

  // REAL return shape: web_search.search resolves { query, results:[...] } (NOT a bare array)
  let startedUrl2 = null;
  const realShapeSearch = async () => ({ query: 'x', results });
  const rShape = await mc.findAndStart({ query: 'Zoe Barnes', deps: { search: realShapeSearch, start: (u) => { startedUrl2 = u; return true; } } });
  ok(rShape.ok && /youtube\.com\/watch/.test(startedUrl2), 'handles web_search\'s real { results:[...] } shape (live-path contract)');

  // --- watching-question detector ("what are you watching" → answer about the video, not identity) ---
  ok(mc.detectWatchingQuestion('What are you watching now?'), '"What are you watching now?" is a watching question');
  ok(mc.detectWatchingQuestion('what are you watching right now?'), '"watching right now" detected');
  ok(mc.detectWatchingQuestion("what's on?"), '"what\'s on?" detected');
  ok(mc.detectWatchingQuestion('what are you seeing'), '"what are you seeing" detected');
  ok(!mc.detectWatchingQuestion('what do you think about it'), 'a generic opinion question is NOT a watching question');
  ok(!mc.detectWatchingQuestion('how are you'), 'small talk is not a watching question');

  // honest failure when nothing is found
  const r3 = await mc.findAndStart({ query: 'x', deps: { search: async () => [{ url: 'https://reddit.com/x' }], start: () => true } });
  ok(!r3.ok && r3.reason === 'no-result', 'no usable clip → ok:false (caller tells Lucas honestly, no fabrication)');

  // --- WATCHED REGISTRY: no autonomous re-watch + it accretes a recap (the "5x Condoleezza Rice" fix) ---
  const now = Date.now();
  ok(mc.wasWatchedRecently('Condoleezza Rice interview', { nowMs: now }) === false, 'not watched yet → wasWatchedRecently false');
  mc.recordWatched('https://www.youtube.com/watch?v=abc123XYZ', 'Condoleezza Rice interview', now);
  ok(mc.wasWatchedRecently('Condoleezza Rice interview', { nowMs: now }) === true, 'after watching → same TOPIC blocked (no autonomous re-pick)');
  ok(mc.wasWatchedRecently('condoleezza rice', { nowMs: now }) === true, 'fuzzy topic match → blocked');
  ok(mc.wasWatchedRecently('https://www.youtube.com/watch?v=abc123XYZ', { nowMs: now }) === true, 'same URL/id → blocked');
  ok(mc.wasWatchedRecently('a totally different documentary', { nowMs: now }) === false, 'a different topic → NOT blocked (she can watch new things)');
  ok(mc.wasWatchedRecently('Condoleezza Rice interview', { nowMs: now + 5 * 24 * 3600 * 1000 }) === false, 'past the 3-day window → re-watch allowed again');
  mc.markRecap('https://www.youtube.com/watch?v=abc123XYZ', 'Rice discussed diplomacy and leadership.');
  const wl = JSON.parse(require('../lib/db').getMeta('media.watched') || '[]');
  ok(wl.length === 1 && /diplomacy/.test(wl[0].recap), 'markRecap: the viewing accretes a recap into the registry');
  // start() records the watch immediately (dedups even before a recap lands)
  mc.reset(); require('../lib/db').setMeta('media.watched', '[]');
  mc.start('https://youtu.be/def456GHI', { topic: 'jazz history' });
  ok(mc.wasWatchedRecently('jazz history') === true, 'start() records the watch immediately → re-pick guarded even mid-watch');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { require('../lib/db').getDb().close(); } catch {}
  try { require('fs').unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
