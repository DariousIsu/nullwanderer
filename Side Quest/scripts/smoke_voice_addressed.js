/* Smoke: the ADDRESSED-TO-HER gate (campaign §22 — dictation/nearby speech landed as her user
 * turns; the speaker gate passed because it WAS him). Pure verdict cases + the wiring pins.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_voice_addressed.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const va = require('../lib/voice_addressed');

let pass = 0, fail = 0;
const ok = (c, t, d = '') => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t, d ? `— ${d}` : ''); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const v = (o) => va.verdict(o);

// --- addressed: these MUST reach her brain ---
ok(v({ text: 'Zoe, what came in overnight?', appFocused: false }).reason === 'named', 'her name addresses her from anywhere (even unfocused)');
ok(v({ text: 'hey zoe pull up the anti china report' , appFocused: false }).turn === true, 'named, unfocused, cold → still a turn');
ok(v({ text: 'sounds good, do that', inExchangeWindow: true, appFocused: false }).reason === 'exchange-window', 'inside a live exchange everything flows (follow-ups need no name)');
ok(v({ text: 'can you check the calendar for tomorrow', appFocused: true }).reason === 'ask-shape', 'a cold ask at her fronted window passes (interrogative lead)');
ok(v({ text: 'okay so pull the parish roster up', appFocused: true }).turn === true, 'discourse particles then a command verb → ask-shape');
ok(v({ text: 'that Womack thing was strange', appFocused: true }).reason === 'benefit-of-doubt', 'short statement at her fronted window → fail open toward conversation');

// --- ambient: these MUST NOT become turns ---
ok(v({ text: 'can you send me the file by Friday', appFocused: false }).reason === 'unfocused-cold', '⭐ THE DICTATION SPECIMEN: unfocused + no name → ambient (dictation types into the focused app)');
ok(v({ text: 'Dear Mark, following up on the contract we discussed last week regarding the delivery schedule and the revised terms', appFocused: false }).turn === false, 'dictated prose, unfocused → ambient');
ok(v({ text: 'The committee voted seven to two in favor of the amendment after a long debate over the fiscal note attached', appFocused: true }).reason === 'dictation-shaped', 'long declarative prose with nothing aimed at her → ambient even fronted');
ok(v({ text: 'yeah exactly', appFocused: true }).reason === 'fragment', 'a sub-4-word fragment cold → a conversation she is not in');
ok(v({ text: '', appFocused: true }).reason === 'empty', 'empty never turns');

// --- namesHer ---
ok(va.namesHer('okay Zoe do it', 'zoe') && !va.namesHer('zoetrope history', 'zoe'), 'name matches per token, never substring');
ok(va.namesHer('hey lane, you up?', 'zoe lane'), 'multi-word chosen name: any token ≥3ch counts');

// --- the wiring pins ---
const main = read('main.js');
ok(/sttOpts && sttOpts\.handsFree/.test(main), 'the gate arms on the HANDS-FREE lane only (push-to-talk never gated)');
ok(/!\(spkr && spkr\.match === false\)/.test(main), 'the addressed gate runs only on speech the speaker gate passed');
ok(/\[ambient, his voice\]/.test(main), 'a dropped utterance shelves on room.overheard (awareness survives)');
ok(/addressed gate errored \(fail-open, turn proceeds\)/.test(main), 'a gate error fails OPEN — she never goes deaf to a bug');
ok(/mainWindow\.isFocused\(\)/.test(main), 'focus comes from the real window (the dictation discriminator)');
const chat = read('renderer/chat.js');
ok(/sttTranscribe\(ab, \{ handsFree: true \}\)/.test(chat), 'the hands-free path declares itself');
ok(/res\.addressed && res\.addressed\.turn === false/.test(chat), 'the renderer drops a non-addressed utterance at the same seam as the speaker gate');
ok(/sttTranscribe: \(audioBuf, opts\)/.test(read('preload.js')), 'preload passes the lane marker through');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
