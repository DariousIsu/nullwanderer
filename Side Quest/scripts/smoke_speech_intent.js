/* Smoke: intent.detectSpeechQuery — routes "what did X say" / "X's speech" / transcript asks to the
 * TRANSCRIPT path (grounded), and stays quiet on fixed phrases + recall-of-self. Fully offline.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_speech_intent.js
 */
'use strict';
const intent = require('../lib/intent');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// ---- POSITIVES (must detect) — with expected speaker (null = unspecified) ----
const yes = [
  ['what did trump say in his speech', 'Trump'],
  ['what do you know about Trump\'s speech from last night', 'Trump'],
  ['what did President Trump say last night', null],            // "president" lowercases through; subject grabbed loosely
  ['pull up the transcript of the speech', null],
  ['what did they say in the address', null],
  ['what did Biden say in his remarks', 'Biden'],
  ['can you get me the transcript of Zelensky\'s address', 'Zelensky'],
  ['what did the governor say in her speech', null],
  ['Trump\'s address to Congress — what were the highlights', 'Trump'],
  ['what did he say in his keynote', null],
];
for (const [msg, spk] of yes) {
  const r = intent.detectSpeechQuery(msg);
  ok(!!r, `DETECT: "${msg}"`);
  if (r && spk) ok(new RegExp(spk, 'i').test(r.speaker || ''), `  speaker≈"${spk}" (got "${r && r.speaker}")`);
}

// ---- NEGATIVES (must NOT detect) ----
const no = [
  'freedom of speech is under attack',
  'she needs speech therapy',
  'what are the parts of speech',
  'what did you say earlier',           // recall-of-self → isRecallQuery, not this
  'what did I say about the budget',    // recall-of-self
  'how are you doing today',
  'let\'s find a speechwriter for the campaign',
  'give me a rundown on the economy',   // topical, no speech
];
for (const msg of no) ok(!intent.detectSpeechQuery(msg), `SKIP: "${msg}"`);

// ---- recall-of-self must still be caught by the RIGHT detector (no overlap regression) ----
ok(intent.isRecallQuery('what did you say earlier') && !intent.detectSpeechQuery('what did you say earlier'),
  'recall-of-self stays with isRecallQuery, not speech');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
