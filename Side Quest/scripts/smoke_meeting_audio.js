/* Smoke: lib/meeting_audio — Echo transcription of the meeting audio (Lucas's virtual-cable path). Proves
 * the config gate (OFF by default), the capture start (source/device passed to Echo), and stop→diarized
 * transcript. Isolated temp DB (SQ_DB_PATH) + env config + a mock Echo dispatch (no network).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_meeting_audio.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `sq_meetaudio_smoke_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.SQ_DB_PATH = tmp;
// clear any inherited config
delete process.env.ZOE_MEETING_AUDIO; delete process.env.ZOE_MEETING_AUDIO_SOURCE; delete process.env.ZOE_MEETING_AUDIO_DEVICE_INDEX;

const db = require('../lib/db'); db.init();
const ma = require('../lib/meeting_audio');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const calls = [];
const mkDispatch = (over = {}) => async ({ name, args }) => {
  calls.push({ name, args });
  if (name === 'transcription_capture_start') return over.start || { text: JSON.stringify({ ok: true, session_id: 77, recording: true }) };
  if (name === 'transcription_capture_stop') return { text: JSON.stringify({ ok: true }) };
  if (name === 'transcription_segments') return over.segments || { text: JSON.stringify({ ok: true, segments: [{ idx: 0, speaker: 'Sean', text: 'I will pull the polling data.' }, { idx: 1, speaker: 'Lucas', text: 'Draft Louisiana content.' }] }) };
  return { text: '{}' };
};
const fastDeps = { delay: async () => {}, maxPolls: 2, pollMs: 0 };

(async () => {
  // --- disabled by default (no env) → start refuses, no Echo call ---
  const off = await ma.start({ dispatch: mkDispatch() });
  ok(off.ok === false && off.reason === 'disabled', 'OFF by default → start refuses (captions stand in)');
  ok(calls.length === 0, 'disabled → no Echo dispatch made');

  // --- enabled → capture starts on the configured source/device ---
  process.env.ZOE_MEETING_AUDIO = '1';
  process.env.ZOE_MEETING_AUDIO_SOURCE = 'loopback';
  process.env.ZOE_MEETING_AUDIO_DEVICE_INDEX = '5';
  const on = await ma.start({ dispatch: mkDispatch() });
  ok(on.ok === true && on.sessionId === 77, 'enabled → capture starts, session captured');
  const startCall = calls.find(c => c.name === 'transcription_capture_start');
  ok(startCall && startCall.args.source_type === 'loopback' && startCall.args.device_index === 5 && startCall.args.diarize === true, 'capture args carry source=loopback + device_index=5 + diarize');
  ok(ma.active() === true && ma.sessionId() === 77, 'meeting-audio state set (active + session)');

  // --- stop → diarized transcript ---
  const r = await ma.stop({ dispatch: mkDispatch(), deps: fastDeps });
  ok(r.ok === true && r.ready === true && r.segments.length === 2, 'stop → diarized segments fetched');
  ok(/Sean: I will pull the polling data\./.test(r.transcript) && /Lucas: Draft Louisiana content\./.test(r.transcript), 'transcript formatted diarized');
  ok(ma.active() === false && ma.sessionId() === null, 'state cleared after stop');

  // --- mic source, no device ---
  process.env.ZOE_MEETING_AUDIO_SOURCE = 'mic';
  delete process.env.ZOE_MEETING_AUDIO_DEVICE_INDEX;
  calls.length = 0;
  const micRes = await ma.start({ dispatch: mkDispatch() });
  const micCall = calls.find(c => c.name === 'transcription_capture_start');
  ok(micCall.args.source_type === 'mic' && micCall.args.device_index === undefined, 'mic source → no device_index');
  ok(micRes.isolated === false, 'unresolved device → isolated=false (default mix, footgun-flagged)');

  // --- default capture device = VB-CABLE "CABLE Input" (standalone, no Voicemeeter app) ---
  delete process.env.ZOE_MEETING_AUDIO_DEVICE; delete process.env.ZOE_MEETING_AUDIO_DEVICE_INDEX;
  ok(require('../lib/config').meetingAudioConfig().deviceName === 'CABLE Input', 'default capture device = "CABLE Input" (VB-CABLE, no app to run)');

  // --- device NAME resolution (indices shift; names don't) ---
  delete process.env.ZOE_MEETING_AUDIO_DEVICE_INDEX;
  process.env.ZOE_MEETING_AUDIO_SOURCE = 'loopback';
  process.env.ZOE_MEETING_AUDIO_DEVICE = 'CABLE Input';
  calls.length = 0;
  const nameDispatch = async ({ name, args }) => {
    calls.push({ name, args });
    if (name === 'transcription_list_devices') return { text: JSON.stringify({ ok: true, mic: [], loopback: [{ index: 108, name: 'CABLE Input (VB-Audio Virtual Cable) [Loopback]' }, { index: 99, name: 'Hi-Fi Cable Input [Loopback]' }] }) };
    if (name === 'transcription_capture_start') return { text: JSON.stringify({ ok: true, session_id: 5, recording: true }) };
    return { text: '{}' };
  };
  const byName = await ma.start({ dispatch: nameDispatch });
  ok(byName.ok === true && byName.deviceIndex === 108, 'device NAME "CABLE Input" resolves → current loopback index 108');
  ok(byName.isolated === true, 'a resolved device → isolated capture (parallel-meeting safe)');
  const sc = calls.find(c => c.name === 'transcription_capture_start');
  ok(sc.args.device_index === 108, 'resolved index passed to capture');
  await ma.stop({ dispatch: nameDispatch, deps: fastDeps });
  delete process.env.ZOE_MEETING_AUDIO_DEVICE;

  // --- fail-safe: no dispatch ---
  const nod = await ma.start({ dispatch: null });
  ok(nod.ok === false && nod.reason === 'no-echo', 'no dispatch → {ok:false} (no throw)');

  try { fs.unlinkSync(tmp); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
