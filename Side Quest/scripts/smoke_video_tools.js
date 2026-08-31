/* Smoke: lib/video_compose + lib/talking_head — the tiktok-avatar tool doors (Doors 1+2).
 * The renders themselves need ffmpeg + the SadTalker venv/weights (proven live at the gates, not
 * offline-deterministic), so the gate covers the caption math, the never-throw fail-soft contract on
 * both doors, and that the capability-manifest registration is PRESENT (probes exist; whether they
 * pass depends on what this clone has installed — fail-absent is the manifest's own law).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_video_tools.js
 */
'use strict';
const vc = require('../lib/video_compose');
const th = require('../lib/talking_head');
const cm = require('../lib/capability_manifest');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  // --- scriptToCaptions: authored-timing estimate (v1 caption source) ---
  const caps = vc.scriptToCaptions('one two three four five six seven eight nine ten eleven', 10);
  ok(caps.length === 3, 'eleven words → three cards of ≤5 words');
  ok(caps.every(c => c.text.split(' ').length <= 5), 'no card exceeds 5 words');
  ok(caps[0].start === 0 && Math.abs(caps[caps.length - 1].end - 10) < 0.01, 'cards span the full duration');
  ok(caps.every((c, i) => i === 0 || Math.abs(c.start - caps[i - 1].end) < 0.01), 'cards are contiguous, no overlap/gap');
  ok(vc.scriptToCaptions('', 10).length === 0 && vc.scriptToCaptions('hi', 0).length === 0, 'empty script or zero duration → no cards, no crash');

  // --- compose: fail-soft contract (never throws, honest errors) ---
  const noVisual = await vc.compose({ wav: 'nope.wav' });
  ok(noVisual.ok === false && /visual input missing/.test(noVisual.error), 'no visual input → {ok:false}, no throw');
  const noWav = await vc.compose({ image: __filename.replace(/\.js$/, '.js') });
  ok(noWav.ok === false && /requires a wav/.test(noWav.error), 'image mode without wav → {ok:false}, no throw');
  ok((await vc.probe('data/definitely_not_here.mp4')) === null, 'probe of a missing file → null, never a guess');

  // --- assemble (the cutting room): fail-soft contract ---
  const noSegs = await vc.assemble({ segments: [], out: 'x.mp4' });
  ok(noSegs.ok === false && /no segments/.test(noSegs.error), 'empty timeline → {ok:false}, no throw');
  const noOut = await vc.assemble({ segments: [{ color: '0x000000', durSec: 1 }] });
  ok(noOut.ok === false && /out required/.test(noOut.error), 'timeline without out → {ok:false}');
  const badSeg = await vc.assemble({ segments: [{ video: 'data/nope.mp4', wav: 'data/nope.wav' }], out: 'x.mp4' });
  ok(badSeg.ok === false && /segment 0/.test(badSeg.error), 'missing segment media → {ok:false} naming the segment');

  // --- talking_head: fail-soft contract ---
  ok(typeof th.available() === 'boolean', 'available() answers boolean (measured, never throws)');
  const noAudio = await th.render({ wav: 'data/definitely_not_here.wav', timeoutMs: 5000 });
  ok(noAudio.ok === false && typeof noAudio.error === 'string', 'render without a real wav → {ok:false}, no throw');

  // --- registration: both doors are IN the manifest's probe list (pass/fail is the clone's business) ---
  const names = cm._PROBES.map(p => p.name);
  ok(names.includes('talking-head video'), 'talking-head door registered in capability manifest');
  ok(names.includes('vertical video compose'), 'compose door registered in capability manifest');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
