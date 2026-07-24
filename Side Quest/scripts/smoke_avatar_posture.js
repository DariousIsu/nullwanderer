'use strict';
/*
 * Gate for the SHARED posture map — the one main-side cognition and the kg3d renderer both run.
 *
 * Two things are being protected. (1) The mapping itself: where an answer came from must pick the body
 * language, and an honest miss must read as a miss. (2) That the RENDERER actually consumes it — this lifts
 * the real `animOnActivity` out of renderer/kg3d.js and EXECUTES it against a stub player, because a wiring
 * test that greps for a call proves nothing about whether the call does anything (the same lesson
 * smoke_activity_coverage learned the hard way).
 */
const fs = require('fs');
const path = require('path');
const P = require('../lib/avatar_posture');

let fail = 0;
const ok = (cond, label, extra) => { if (!cond) { console.log('FAIL:', label, extra == null ? '' : JSON.stringify(extra)); fail++; } };

const CLIPS = ['idle', 'listen', 'speak', 'think', 'idle_settle', 'listen_lean',
               'speak_soft', 'speak_emphatic', 'think_deep', 'nod', 'shake', 'perk'];
const has = (n) => CLIPS.includes(n);

// ---- the map itself
ok(P.postureFromTurn({ kind: 'say', missed: true }).decisive === true, 'a miss is decisive');
ok(P.postureFromTurn({ kind: 'say', missed: true }).clip === 'shake', 'a miss shakes her head');
ok(P.postureFromTurn({ kind: 'say', enriched: true, enrichSource: 'forecast' }).clip === 'speak_emphatic', 'her own model → emphatic');
ok(P.postureFromTurn({ kind: 'say', enriched: true, enrichSource: 'excavate' }).clip === 'speak_soft', 'dug for it → soft');
ok(P.postureFromTurn({ kind: 'say', enriched: false, enrichSource: null }).clip === 'speak', 'already in hand → settled');
ok(P.postureFromTurn({ kind: 'say', enriched: true, enrichSource: 'martian' }) === null, 'unknown source → null, not invented certainty');
for (const s of Object.keys(P.SOURCE_POSTURE)) ok(has(P.SOURCE_POSTURE[s]), 'posture is a real clip: ' + s, P.SOURCE_POSTURE[s]);
for (const k of Object.keys(P.FALLBACK)) ok(has(P.FALLBACK[k]), 'fallback is a real clip: ' + k, P.FALLBACK[k]);

// ---- clipForTurn never hands back a clip the player does not own
ok(P.clipForTurn({ kind: 'say', missed: true }, () => false) === null, 'empty menu yields nothing');
ok(P.clipForTurn({ kind: 'say', missed: true }, (n) => n !== 'shake').clip === 'speak', 'missing clip falls through to the event map');
ok(P.clipForTurn({ kind: 'hear' }, has).clip === 'listen', 'hear has no posture → event map');
ok(P.clipForTurn(null, has) === null, 'no turn at all → nothing');

/* ---- THE WIRING. Lift the real animOnActivity out of the renderer and run it. ---- */
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'kg3d.js'), 'utf8');
const start = src.indexOf('function animOnActivity');
ok(start > 0, 'found animOnActivity in the renderer');
// brace-match so this survives the body changing
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
ok(end > start, 'brace-matched the function');

const played = [];
const ANIM_CLIPS = {}; for (const c of CLIPS) ANIM_CLIPS[c] = true;
const animPlay = (name, hold) => { played.push({ name, hold }); return true; };
const win = { AvatarPosture: P };
// eslint-disable-next-line no-new-func
const make = new Function('ANIM_CLIPS', 'animPlay', 'window', src.slice(start, end) + '; return animOnActivity;');
const animOnActivity = make(ANIM_CLIPS, animPlay, win);

const last = () => played[played.length - 1];
animOnActivity({ kind: 'say', missed: true, tried: ['graph', 'web'] });
ok(last() && last().name === 'shake', 'RENDERER: a searched-miss shakes her head', last());
animOnActivity({ kind: 'say', enriched: true, enrichSource: 'web' });
ok(last().name === 'speak_soft', 'RENDERER: a web pull is carried softly', last());
animOnActivity({ kind: 'say', enriched: true, enrichSource: 'forecast' });
ok(last().name === 'speak_emphatic', 'RENDERER: her own forecast is emphatic', last());

// ---- the old contract must still hold: a bare kind, and an event with no verdict, behave as before
const n0 = played.length;
animOnActivity({ kind: 'hear' });
ok(last().name === 'listen' && last().hold === 4, 'RENDERER: plain hear unchanged', last());
animOnActivity({ kind: 'think' });
ok(last().name === 'think', 'RENDERER: plain think unchanged', last());
animOnActivity('say');
ok(last().name === 'speak', 'RENDERER: a bare kind string still works', last());
ok(played.length === n0 + 3, 'each call played exactly once', played.length - n0);

// ---- unknown kinds must stay silent, and nothing may throw
const n1 = played.length;
for (const junk of [null, undefined, {}, { kind: 'observe' }, { kind: 'doc.land' }, 'nope', 42]) {
  let threw = false;
  try { animOnActivity(junk); } catch (e) { threw = true; }
  ok(!threw, 'never throws', junk);
}
ok(played.length === n1, 'unknown kinds play nothing', played.length - n1);

// ---- with the shared lib ABSENT (script tag missing / load order), it must degrade to the old map
const bare = make(ANIM_CLIPS, animPlay, {});
bare({ kind: 'say', missed: true });
ok(last().name === 'speak', 'no AvatarPosture on window → old event map, no crash', last());

console.log(fail ? `\n${fail} FAILURES` : '\nPASS — posture map shared, and the RENDERER really plays it (miss→shake, web→soft, forecast→emphatic), degrading to the old map when absent');
process.exit(fail ? 1 : 0);
