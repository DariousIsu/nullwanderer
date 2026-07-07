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

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
