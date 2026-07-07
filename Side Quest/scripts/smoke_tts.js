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

// --- prepareText: NEVER voice her private cognition or structural/tool tags (the voice-leak fix) ---
ok(tts.prepareText('<think>secret reasoning</think><say>Hello there</say>') === 'Hello there', 'think dropped, only <say> spoken');
ok(tts.prepareText('<think>plan</think>Hello there') === 'Hello there', 'think block stripped even without <say> tags');
ok(tts.prepareText('<thinking>\nlong plan\n</thinking><say>Hi Lucas</say>') === 'Hi Lucas', 'multiline <thinking> block stripped');
ok(tts.prepareText('<think') === '' && tts.prepareText('Hello there.<think') === 'Hello there.', 'orphan/unclosed <think scrubbed (bare → empty; trailing → real text kept)');
ok(tts.prepareText('Let me look <browse-read/> at that').replace(/\s+/g, ' ').trim() === 'Let me look at that', 'stray tool/action tag scrubbed');
ok(tts.prepareText('<say>one</say> <say>two</say>') === 'one two', 'multiple say blocks joined');
ok(tts.prepareText('<think>only thinking, nothing said</think>') === '', 'a think-only reply → nothing to speak');

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

// --- config kill-switch + voice resolution (env-controlled so the test is deterministic regardless of the
// ambient .env or whether a bundled voice model happens to exist on disk) ---
cfg.ttsConfig();   // trigger config's one-time loadEnv() FIRST, so our env edits below aren't clobbered by it
const _envEnabled = process.env.ZOE_TTS_ENABLED, _envVoice = process.env.ZOE_TTS_VOICE;
delete process.env.ZOE_TTS_ENABLED;
ok(cfg.ttsConfig().enabled === false, 'TTS OFF when ZOE_TTS_ENABLED unset (kill-switch)');
process.env.ZOE_TTS_ENABLED = '1';
ok(cfg.ttsConfig().enabled === true, 'ZOE_TTS_ENABLED=1 → enabled');
process.env.ZOE_TTS_VOICE = '/tmp/x.onnx';
const tc = cfg.ttsConfig();
ok(tc.configured === true && tc.voice === '/tmp/x.onnx' && typeof tc.wallMs === 'number', 'explicit ZOE_TTS_VOICE → configured + sane wallMs');
// restore ambient env so nothing leaks to other assertions
if (_envEnabled === undefined) delete process.env.ZOE_TTS_ENABLED; else process.env.ZOE_TTS_ENABLED = _envEnabled;
if (_envVoice === undefined) delete process.env.ZOE_TTS_VOICE; else process.env.ZOE_TTS_VOICE = _envVoice;

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
