/* Smoke: lib/tts — the PURE text-prep / voice-resolution + fail-soft spawn (voice-avatar-plan V1).
 * The Piper synthesis itself needs the venv + a voice model (proven live, not offline-deterministic), so the
 * gate covers text normalization, voice resolution, and the never-throw contract.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_tts.js
 */
'use strict';
const tts = require('../lib/tts');
const cfg = require('../lib/config');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- prepareText: markdown scaffolding stripped, whitespace collapsed ---
ok(tts.prepareText('# Hello **world**') === 'Hello world', 'strips heading + bold emphasis');
ok(tts.prepareText('see `code` and _italics_') === 'see code and italics', 'strips inline code + italics');
ok(tts.prepareText('a [label](http://x.com) link') === 'a label link', 'keeps link label, drops url');
ok(tts.prepareText('line1\n\n   line2\t line3') === 'line1 line2 line3', 'collapses newlines/tabs/runs of space');
ok(tts.prepareText('- one\n- two') === 'one two', 'strips list bullets');
ok(tts.prepareText('a ```\ncode block\n``` b').indexOf('code block') === -1, 'drops fenced code blocks');
ok(tts.prepareText('') === '' && tts.prepareText(null) === '' && tts.prepareText(42) === '', 'empty/null/non-string → "", no crash');
const long = 'word. '.repeat(400);                       // ~2400 chars, many sentence boundaries
const capped = tts.prepareText(long, { maxChars: 200 });
ok(capped.length <= 200 && !/\s$/.test(capped) && capped.endsWith('.'), `caps at boundary (${capped.length} chars, ends clean)`);

// --- resolveVoice: explicit opts win, then config, else null ---
ok(tts.resolveVoice({ voice: '/models/en.onnx' }) === '/models/en.onnx', 'explicit opts.voice wins');
ok(tts.resolveVoice({}, { voice: '/cfg/voice.onnx' }) === '/cfg/voice.onnx', 'falls back to config voice');
ok(tts.resolveVoice({}) === null && tts.resolveVoice({ voice: '  ' }) === null, 'no/blank voice → null');

// --- config kill-switch: OFF by default, no voice ⇒ not configured ---
const tc = cfg.ttsConfig();
ok(tc && tc.enabled === false, 'TTS is OFF by default (kill-switch)');
ok(tc.configured === false && typeof tc.wallMs === 'number', 'unconfigured (no ZOE_TTS_VOICE) + sane wallMs');

// --- fail-soft: empty text / no voice / dead interpreter → {ok:false}, never throws or hangs ---
(async () => {
  const empty = await tts.synthesize('   ', { voice: '/x.onnx' });
  ok(empty && empty.ok === false && /empty/.test(empty.error), 'empty text → {ok:false, empty}');

  const noVoice = await tts.synthesize('hello there', {});
  ok(noVoice && noVoice.ok === false && /voice/.test(noVoice.error), 'no voice model → {ok:false}');

  const dead = await tts.synthesize('hello there', { voice: '/models/en.onnx', out: '/nope/out.wav', python: '/no/such/python', wallMs: 4000 });
  ok(dead && dead.ok === false && typeof dead.error === 'string', 'dead interpreter → {ok:false}, no throw');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
