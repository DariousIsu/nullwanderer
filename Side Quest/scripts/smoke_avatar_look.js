/* Smoke: THE LOOK WORDS (the wants project, cut 13's gaze half, 09-05): she looks at him when she speaks to him or listens,
 * and away when she thinks. Pure pins on the posture vocabulary (lib/avatar_posture.lookForTurn) and the gaze target
 * (lib/avatar_state.gazeTarget); source pins on the wiring — the 2D face's pupils, the preload bridge, main's broadcast
 * paired with the last camera gaze, the chat page's two events, the companion's look-at honouring the look.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_avatar_look.js
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const AP = require(path.join(ROOT, 'lib', 'avatar_posture'));
const AS = require(path.join(ROOT, 'lib', 'avatar_state'));
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── the vocabulary ─────────────────────────────────────────────────────────────────────────────────────────
ok(AP.LOOK.say === 'at_him' && AP.LOOK.hear === 'at_him' && AP.LOOK.think === 'away', 'the look words: say and hear → at him; think → away');
ok(AP.lookForTurn({ kind: 'say' }).look === 'at_him' && AP.lookForTurn({ kind: 'hear' }).look === 'at_him' && AP.lookForTurn({ kind: 'think' }).look === 'away' && /event:say/.test(AP.lookForTurn({ kind: 'say' }).why), 'lookForTurn reads the event');
ok(AP.lookForTurn({ kind: 'idle' }) === null && AP.lookForTurn(null) === null && AP.lookForTurn({}) === null, 'an idle turn, or none, says nothing about her eyes');
ok(AP.clipForTurn({ kind: 'say', enriched: false }).clip === 'speak' && AP.postureFromTurn({ kind: 'say', missed: true }).clip === 'shake', 'the clip vocabulary is untouched beside the look words');

// ── the gaze target ────────────────────────────────────────────────────────────────────────────────────────
const away = AS.gazeTarget({ look: 'away', now: 10000 });
ok(away && away.gazeX === AS.LOOK_AWAY.x && away.gazeY === AS.LOOK_AWAY.y && /away/.test(away.why) && AS.LOOK_AWAY.x < 0 && AS.LOOK_AWAY.y < 0, 'away is aside and up');
const atFresh = AS.gazeTarget({ look: 'at_him', faceGaze: { x: 0.3, y: -0.1 }, faceAt: 9000, now: 10000 });
ok(atFresh && atFresh.gazeX === 0.3 && atFresh.gazeY === -0.1 && /the camera/.test(atFresh.why), 'at him with a fresh camera face → toward the face');
const atStale = AS.gazeTarget({ look: 'at_him', faceGaze: { x: 0.3, y: -0.1 }, faceAt: 1000, now: 10000 });
ok(atStale && atStale.gazeX === 0 && atStale.gazeY === 0 && /no fresh face/.test(atStale.why), `at him with a stale face (older than ${AS.GAZE_FRESH_MS} ms) → straight ahead`);
ok(AS.gazeTarget({ look: 'at_him', faceGaze: null, now: 10000 }).gazeX === 0 && AS.gazeTarget({ look: 'at_him', faceGaze: { x: 4, y: -4 }, faceAt: 10000, now: 10000 }).gazeX === 1, 'no face → ahead; an out-of-range face is clamped');
ok(AS.gazeTarget({ look: 'elsewhere' }) === null && AS.gazeTarget({}) === null, 'an unknown look is no target');
ok(Object.values(AS.EXPRESSIONS).every((e) => e.gazeX === 0), 'every resting expression looks straight ahead in x');

// ── the wiring ─────────────────────────────────────────────────────────────────────────────────────────────
const avS = fs.readFileSync(path.join(ROOT, 'renderer', 'avatar.js'), 'utf8'), preS = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8'), mainS = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), chatS = fs.readFileSync(path.join(ROOT, 'renderer', 'chat.js'), 'utf8'), compS = fs.readFileSync(path.join(ROOT, 'renderer', 'companion.html'), 'utf8'), rsS = fs.readFileSync(path.join(ROOT, 'scripts', 'run_smokes.js'), 'utf8');
ok(/setLook\(\{ look, gaze = null, at = 0, holdMs = null \} = \{\}\)/.test(avS) && /AS\.gazeTarget\(\{ look, faceGaze: gaze, faceAt: at, now: Date\.now\(\) \}\)/.test(avS) && /'gazeX', 'gazeY'\]/.test(avS) && (avS.match(/ex \+ gazeX/g) || []).length === 2 && /the look releases/.test(avS), 'the 2D face takes a look, slides both pupils, and releases it to the resting gaze');
ok(/avatarLook: \(look\) => ipcRenderer\.send\('avatar:look', look\)/.test(preS) && /onAvatarLook: \(cb\) => ipcRenderer\.on\('avatar:look'/.test(preS), 'the preload carries the look both ways');
ok(/let _lastGaze = null;/.test(mainS) && /_lastGaze = g && Number\.isFinite\(g\.x\)/.test(mainS) && /function _broadcastLook\(look\)/.test(mainS) && /wc\.send\('avatar:look', m\)/.test(mainS) && /ipcMain\.on\('avatar:look', \(_e, look\) => \{ try \{ if \(look === 'at_him' \|\| look === 'away'\) _broadcastLook\(look\)/.test(mainS), 'main keeps the last camera gaze, pairs the look with it, and hands it to every window');
ok(/window\.sq\.avatarLook\('away'\)/.test(chatS) && /window\.sq\.avatarLook\('at_him'\)/.test(chatS) && chatS.indexOf("avatarLook('away')") > chatS.indexOf('window.sq.onMonologueTick((info) => {') && chatS.indexOf("avatarLook('at_him')") > chatS.indexOf('window.sq.onComplete(('), 'the chat page says away on her thought and at him on her say');
ok(/let lookMode = null, lookUntil = 0;/.test(compS) && /const applyLook = \(g\) => \{/.test(compS) && /if \(lookMode === 'away' && Date\.now\(\) < lookUntil\) return; applyLook\(g\);/.test(compS) && /window\.sq\.onAvatarLook\(\(m\) => \{/.test(compS) && /applyLook\(\{ x: -0\.55, y: -0\.35 \}\)/.test(compS), 'the companion\'s look-at honours away for a moment and follows the face again on at him');
ok(/'smoke_avatar_look\.js'/.test(rsS), 'the smoke is registered in the allow-list');
console.log(`\nsmoke_avatar_look: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
