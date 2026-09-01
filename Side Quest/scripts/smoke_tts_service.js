/* Smoke: lib/tts persistent service — the PURE NDJSON framing + the fail-soft process contract of the
 * resident --serve sidecar (voice-avatar-plan V1+). The actual warm synthesis needs the venv + a voice
 * model (proven live, not offline-deterministic), so the gate covers framing + never-throw/never-hang.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_tts_service.js
 */
'use strict';
const tts = require('../lib/tts');
const cfg = require('../lib/config');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- parseNdjson: frame a stdout stream into complete messages + trailing remainder ---
let r = tts.parseNdjson('{"a":1}\n{"b":2}\n');
ok(r.messages.length === 2 && r.messages[0].a === 1 && r.messages[1].b === 2 && r.rest === '', 'two complete lines → 2 msgs, no remainder');
r = tts.parseNdjson('{"a":1}\n{"b":2');
ok(r.messages.length === 1 && r.rest === '{"b":2', 'partial trailing line kept as remainder');
r = tts.parseNdjson('garbage line\n{"ok":true}\n');
ok(r.messages.length === 1 && r.messages[0].ok === true, 'non-JSON line skipped, valid one parsed');
r = tts.parseNdjson('');
ok(r.messages.length === 0 && r.rest === '', 'empty buffer → nothing');
r = tts.parseNdjson(null);
ok(r.messages.length === 0, 'null buffer → nothing, no crash');
// remainder can be reassembled across chunks
const a = tts.parseNdjson('{"x":1}\n{"y":');
const b = tts.parseNdjson(a.rest + '2}\n');
ok(a.messages[0].x === 1 && b.messages[0].y === 2, 'split message reassembles across chunks');

// --- config: idleMs present + sane ---
const tc = cfg.ttsConfig();
ok(typeof tc.idleMs === 'number' && tc.idleMs >= 0, `ttsConfig.idleMs is a number (${tc.idleMs})`);

// --- fail-soft: a service on a dead interpreter → request resolves {ok:false} fast, never hangs ---
(async () => {
  const svc = tts.createPiperService({ python: '/no/such/python', idleMs: 0 });
  const t0 = Date.now();
  const res = await svc.request({ text: 'hello', voice: '/x.onnx', out: '/nope/out.wav' }, 4000);
  const dt = Date.now() - t0;
  ok(res && res.ok === false && typeof res.error === 'string', 'dead-interpreter request → {ok:false}, no throw');
  ok(dt < 4000, `resolved before the wall timeout (${dt}ms) — no hang`);

  // after shutdown, further requests fail soft immediately
  svc.shutdown();
  const after = await svc.request({ text: 'hi', voice: '/x.onnx', out: '/nope/out.wav' }, 2000);
  ok(after && after.ok === false, 'request after shutdown → {ok:false}');

  // the module singleton shutdown is a no-op-safe call
  tts.shutdownTts(); tts.shutdownTts();
  ok(true, 'shutdownTts() is idempotent / safe with no live service');

  // --- ⭐ THE KOKORO CONSOLIDATION (2026-09-01): lib/voice_kokoro.synthesizeDefault speaks through
  // the ONE resident tuner (:8199) in Zoe's own voice — the request carries NO weights, so the
  // tuner defaults to the saved recipe server-side. Deterministic via injected fetchFn.
  const vk = require('../lib/voice_kokoro');
  const os = require('os');
  {
    let captured = null;
    const wav = Buffer.from('RIFFfakewav');
    const fakeFetch = async (url, init) => { captured = { url, body: JSON.parse(init.body) }; return { ok: true, arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) }; };
    const outP = require('path').join(os.tmpdir(), `smoke_vk_${process.pid}.wav`);
    const r1 = await vk.synthesizeDefault('Hello there.', { out: outP, fetchFn: fakeFetch });
    ok(r1.ok === true && r1.out === outP && r1.bytes === wav.length && r1.sampleRate === 24000, 'tuner synth writes the wav and reports bytes + 24kHz');
    ok(captured && /\/synth$/.test(captured.url) && captured.body.text === 'Hello there.' && !('weights' in captured.body), '⭐ the request carries NO weights — Zoe\'s saved recipe is the tuner-side default');
    try { require('fs').unlinkSync(outP); } catch {}
  }
  ok((await vk.synthesizeDefault('', {})).ok === false, 'empty text → {ok:false}, no request');
  ok((await vk.synthesizeDefault('hi', { fetchFn: async () => ({ ok: false, status: 500, text: async () => 'boom' }) })).error.includes('500'), 'an HTTP error surfaces the status, fail-soft');
  ok((await vk.synthesizeDefault('hi', { fetchFn: async () => { throw new Error('ECONNREFUSED'); } })).ok === false, 'a dead tuner → {ok:false}, never a throw');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
