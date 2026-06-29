/* Smoke: audio listening via Echo (lib/listen) — detection + start/stop flow + transcript shaping.
 * Deterministic: injected echo dispatch (no engine), temp DB. Mirrors the verified Echo contract:
 * capture_start → {session_id}, capture_stop, segments → {segments:[{speaker,text}]}.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_listen.js
 */
'use strict';
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_listen_${Date.now()}.db`);
require('../lib/db').init();
const L = require('../lib/listen');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // --- detection ---
  ok(L.detectStart('listen to me for a sec').source === 'mic', '"listen to me" → mic capture');
  ok(L.detectStart('transcribe this call').source === 'loopback', '"transcribe this call" → loopback (system audio)');
  ok(L.detectStart('take notes on this meeting').source === 'loopback', '"take notes on this meeting" → loopback');
  ok(L.detectStart('what do you think') === null, 'non-listen message → no start');
  ok(L.detectStop('ok stop listening') === true, '"stop listening" detected');
  ok(L.detectStop('keep going') === false, 'non-stop message → no stop');

  // --- start: parses session_id from a {text: JSON} echo result (the real shape) ---
  const calls = [];
  const dispatch = async (t) => {
    calls.push(t.name);
    if (t.name === 'transcription_capture_start') return { ok: true, text: JSON.stringify({ ok: true, session_id: 42, recording: true }) };
    if (t.name === 'transcription_capture_stop') return { ok: true, text: JSON.stringify({ ok: true }) };
    if (t.name === 'transcription_segments') return { ok: true, text: JSON.stringify({ ok: true, segments: [{ idx: 0, speaker: 'Lucas', text: 'test the audio listening' }, { idx: 1, speaker: 'Lucas', text: 'one two three' }] }) };
    return { ok: false };
  };
  const s = await L.start({ source: 'mic', deps: { dispatch } });
  ok(s.ok && s.sessionId === 42, 'start parses session_id from the {text:JSON} echo result');
  ok(L.active() === true && L.sessionId() === 42, 'capture state persisted (active + session id)');

  // --- stop: stops, polls segments, returns a clean transcript ---
  const r = await L.stop({ deps: { dispatch, delay: async () => {}, maxPolls: 2 } });
  ok(r.ok && r.ready, 'stop returns ready with segments');
  ok(/Lucas: test the audio listening/.test(r.transcript) && /one two three/.test(r.transcript), 'transcript formatted speaker:text');
  ok(calls.includes('transcription_capture_stop') && calls.includes('transcription_segments'), 'stop calls capture_stop then segments');
  ok(L.active() === false, 'capture marked inactive after stop');

  // --- fail-safe: no echo dispatch → honest failure, no crash ---
  const noEcho = await L.start({ source: 'mic', deps: {} });
  ok(!noEcho.ok && noEcho.reason === 'no-echo', 'no echo dispatch → ok:false (honest, no fabrication)');

  // --- stop with transcription still pending (empty segments) → not ready, no fake transcript ---
  await L.start({ source: 'mic', deps: { dispatch } });
  const pendingDispatch = async (t) => (t.name === 'transcription_segments') ? { text: JSON.stringify({ ok: true, segments: [] }) } : { text: '{"ok":true}' };
  const r2 = await L.stop({ deps: { dispatch: pendingDispatch, delay: async () => {}, maxPolls: 2 } });
  ok(r2.ok && !r2.ready && r2.transcript === '', 'still-transcribing → ready:false, empty transcript (caller says "processing")');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { require('../lib/db').getDb().close(); } catch {}
  try { require('fs').unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
