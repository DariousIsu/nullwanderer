/* Smoke: lib/video_capture — the video-caption capture core (pure poll state machine + [music] cue
 * detection + edge-triggered screenshot + segment shaping + captures store). ISOLATED temp bucket. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_video_capture.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const tmp = path.join(os.tmpdir(), `sq_vidcap_smoke_${process.pid}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.NEWS_DB_PATH = tmp;

const vc = require('../lib/video_capture');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const feed = { url: 'https://www.youtube.com/watch?v=abcdEFGHijk', title: 'Yahoo Finance Live' };
const T = 1_700_000_000_000;

// ===== cue detection =====
ok(vc.isNonSpeechCue('[Music]') === 'music', 'isNonSpeechCue: [Music] → music');
ok(vc.isNonSpeechCue('(applause)') === 'applause', 'isNonSpeechCue: (applause) → applause');
ok(vc.isNonSpeechCue('♪♪') === 'music', 'isNonSpeechCue: ♪♪ → music');
ok(vc.isNonSpeechCue('[LAUGHTER]') === 'laughter', 'isNonSpeechCue: case-insensitive');
ok(vc.isNonSpeechCue('The Dow is up 300 points') === null, 'isNonSpeechCue: real speech → null');
ok(vc.isNonSpeechCue('[Music] the market opened') === null, 'isNonSpeechCue: cue + speech is NOT a pure cue');
ok(vc.cueOf(['[Music]']) === 'music' && vc.cueOf(['[Music]', '[Applause]']) === 'music', 'cueOf: all-cue lines → cue');
ok(vc.cueOf(['[MUSIC] [MUSIC] [MUSIC]']) === 'music', 'cueOf: a REPEATED [MUSIC] run is a pure cue (the live bug)');
ok(vc.cueOf(['[Music]', 'stocks rallied']) === null && vc.cueOf([]) === null, 'cueOf: mixed / empty → null');

// ===== segment shaping =====
ok(vc.deriveTitle('Federal Reserve holds rates steady. More after the break.') === 'Federal Reserve holds rates steady', 'deriveTitle: first sentence');
const item = vc.buildSegmentItem(feed, ['Wall Street rallied today', 'Wall Street rallied today as tech', 'Wall Street rallied today as tech stocks surged'], { firstTs: T, now: T + 5000 });
ok(item.sourceKind === 'video' && item.source === 'Yahoo Finance Live', 'buildSegmentItem: source_kind=video + channel source');
ok(/^video:yahoo-finance-live:/.test(item.urlOrGuid), 'buildSegmentItem: stable per-segment video key');
ok(item.summary === 'Wall Street rallied today as tech stocks surged', 'buildSegmentItem: growing captions collapsed to the settled line');
ok(vc.buildSegmentItem(feed, ['visit shopcinch.com for 30% off'], { firstTs: T, now: T }) === null, 'buildSegmentItem: an ad-only buffer yields no item');
const vitem = vc.buildVisionItem(feed, 'S&P 500 up 1.2% at 5,430; Nasdaq down 0.3%. Chart trending up on the 1-day view.', T);
ok(vitem.sourceKind === 'video' && /S&P 500/.test(vitem.summary) && /^video:screen:/.test(vitem.urlOrGuid), 'buildVisionItem: a vision-read → a video reservoir item (on-screen market data)');
ok(vc.buildVisionItem(feed, '', T) === null, 'buildVisionItem: empty vision text → no item');

// ===== poll state machine =====
const st = vc.newFeedState(feed);
let r = vc.processPoll(st, { captionText: 'Breaking news from Washington', now: T }); ok(r.actions.length === 0 && !r.inCue, 'poll: speech buffers, no action yet');
vc.processPoll(st, { captionText: 'Breaking news from Washington tonight', now: T + 3000 });
r = vc.processPoll(st, { captionText: '[Music]', now: T + 6000 });
const shot = r.actions.find(a => a.type === 'screenshot'); const seg = r.actions.find(a => a.type === 'segment');
ok(shot && shot.cue === 'music', 'poll: [Music] on its own fires a SCREENSHOT (cue edge)');
ok(shot.context && /Washington/.test(shot.context), 'poll: the screenshot carries the last speech as context');
ok(seg && seg.item.sourceKind === 'video' && /Washington/.test(seg.item.summary), 'poll: the cue also FLUSHES the buffered speech as a segment');
r = vc.processPoll(st, { captionText: '[Music]', now: T + 9000 }); ok(r.actions.length === 0 && r.inCue, 'poll: within the ~30s sample window a persisting cue does NOT re-shoot');
r = vc.processPoll(st, { captionText: '[Music]', now: T + 6000 + 31000 }); ok(r.actions.some(a => a.type === 'screenshot') && r.inCue, 'poll: a SUSTAINED cue re-shoots after the sample interval (periodic chart sampling)');
r = vc.processPoll(st, { captionText: 'And we are back with markets', now: T + 6000 + 34000 }); ok(!r.inCue, 'poll: the next spoken word CLOSES the visual stretch');

// size-cap flush (a long talky stretch with no [music] still segments)
const st2 = vc.newFeedState(feed); let segments = 0;
for (let i = 0; i < 40; i++) { const rr = vc.processPoll(st2, { captionText: `sentence number ${i} with enough words to accumulate characters over time`, now: T + i * 1000 }); segments += rr.actions.filter(a => a.type === 'segment').length; }
ok(segments >= 1, 'poll: a long caption run flushes on the size cap (no cue needed)');

// ===== captures store =====
const capId = vc.recordCapture({ source: 'Yahoo Finance Live', sourceUrl: feed.url, ts: T, cue: 'music', imagePath: '/x/shot.png', context: 'markets ahead' });
ok(capId > 0, 'recordCapture inserts a screenshot row');
vc.setCaptureDescription(capId, 'A candlestick chart of the S&P 500 trending up');
const caps = vc.recentCaptures({ sinceMs: T - 1 });
ok(caps.length === 1 && caps[0].cue === 'music' && /candlestick/.test(caps[0].description), 'recentCaptures returns the row incl. the vision description');

// ===== captures retention (prune old rows + their PNG files) =====
const capDir = path.join(os.tmpdir(), `sq_vidcap_png_${process.pid}`);
try { fs.mkdirSync(capDir, { recursive: true }); } catch {}
const oldPng = path.join(capDir, 'old.png'), newPng = path.join(capDir, 'new.png');
fs.writeFileSync(oldPng, 'x'); fs.writeFileSync(newPng, 'y');
const DAY = 86400000;
vc.recordCapture({ source: 'S', ts: T - 10 * DAY, cue: 'music', imagePath: oldPng });   // stale
vc.recordCapture({ source: 'S', ts: T - 1 * DAY, cue: 'music', imagePath: newPng });    // fresh
const pr = vc.pruneCapturesOlderThan(T - 7 * DAY);
ok(pr.rows === 1 && pr.files === 1, 'pruneCapturesOlderThan drops the stale row + its PNG file');
ok(!fs.existsSync(oldPng) && fs.existsSync(newPng), 'the stale PNG is deleted; the fresh one is kept');
ok(vc.recentCaptures({ sinceMs: 0, limit: 50 }).some((c) => c.image_path === newPng) && !vc.recentCaptures({ sinceMs: 0, limit: 50 }).some((c) => c.image_path === oldPng), 'only the fresh capture row remains');
try { fs.rmSync(capDir, { recursive: true, force: true }); } catch {}

// ===== url helpers =====
ok(vc.videoId('https://www.youtube.com/watch?v=abcdEFGHijk') === 'abcdEFGHijk' && vc.videoId('https://youtu.be/abcdEFGHijk') === 'abcdEFGHijk', 'videoId parses watch + short URLs');

try { fs.unlinkSync(tmp); } catch {}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
