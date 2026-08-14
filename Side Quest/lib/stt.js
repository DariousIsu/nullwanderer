/**
 * lib/stt.js — Node wrapper over the local faster-whisper speech-to-text sidecar (sidecar/stt_whisper.py).
 *
 * PURPOSE (two-way voice, Slice 1 — the "ears" that mirror lib/tts.js's "mouth"): turn a captured audio
 * file (the renderer's push-to-talk webm/opus) into text, LOCAL + offline (CPU faster-whisper `base` int8;
 * the GPU stays reserved for Kokoro TTS). The transcript is then fed into the EXISTING chat turn exactly
 * as a typed message — there is no second brain path.
 *
 * Transport is the SAME resident-sidecar NDJSON contract as lib/tts.js (reusing its parseNdjson framer):
 * a --serve child loads the model once and answers id-correlated requests, idle-kills after `idleMs`, and
 * respawns lazily. Fail-soft everywhere — a missing venv / dead sidecar / timeout resolves to
 * { ok:false, error }; transcription never throws and never blocks the caller.
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const { parseNdjson } = require('./tts');   // reuse the exact NDJSON line framer the TTS sidecar uses

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const _bin = (venv) => IS_WIN ? path.join(ROOT, 'sidecar', venv, 'Scripts', 'python.exe') : path.join(ROOT, 'sidecar', venv, 'bin', 'python');
// STT engine (ZOE_STT_ENGINE): 'parakeet' (default) = NVIDIA Parakeet-TDT via onnx-asr in its own
// stt_onnx_venv — a transducer that does NOT hallucinate on silence, ~160ms/utterance on CPU. 'whisper' =
// the faster-whisper fallback in the shared tts_kokoro_venv (hallucination-prone; kept as a fallback).
const _ENGINE = String(process.env.ZOE_STT_ENGINE || 'parakeet').toLowerCase();
const VENV_PY = _ENGINE === 'whisper' ? _bin('tts_kokoro_venv') : _bin('stt_onnx_venv');
const RUNNER = path.join(ROOT, 'sidecar', _ENGINE === 'whisper' ? 'stt_whisper.py' : 'stt_parakeet.py');

// Resident STT sidecar service — mirrors createPiperService in lib/tts.js, but the request payload is
// { id, in: <audio path> } and the response is { id, ok, text, ms, lang }. Factory form so tests can point
// it at a bad python and prove fail-soft.
function createSttService({ python = VENV_PY, runner = RUNNER, idleMs = 300000 } = {}) {
  const st = { child: null, buf: '', pending: new Map(), nextId: 1, ready: false, down: false, idleTimer: null };

  const _failAll = (err) => {
    for (const [, p] of st.pending) { try { clearTimeout(p.timer); } catch {} p.resolve({ ok: false, error: err }); }
    st.pending.clear();
  };
  const _dropChild = (err) => { st.ready = false; if (st.child) { try { st.child.kill(); } catch {} st.child = null; } _failAll(err); };
  const _armIdle = () => {
    if (!idleMs) return;
    try { clearTimeout(st.idleTimer); } catch {}
    st.idleTimer = setTimeout(() => { if (st.pending.size === 0 && st.child) { try { st.child.stdin.end(); } catch {} try { st.child.kill(); } catch {} st.child = null; st.ready = false; } }, idleMs);
    if (st.idleTimer && st.idleTimer.unref) st.idleTimer.unref();   // don't hold the event loop open
  };

  const _ensure = () => {
    if (st.down || st.child) return !st.down;
    let child;
    try {
      child = spawn(python, [runner, '--serve'], { cwd: ROOT, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { return false; }
    st.child = child;
    child.stdout.on('data', (d) => {
      st.buf += d.toString();
      const { messages, rest } = parseNdjson(st.buf); st.buf = rest;
      for (const m of messages) {
        if (m && m.ready) { st.ready = true; continue; }
        const p = m && st.pending.get(m.id);
        if (p) { try { clearTimeout(p.timer); } catch {} st.pending.delete(m.id); p.resolve(m); }
      }
    });
    child.stderr.on('data', () => { /* swallow faster-whisper/av init chatter */ });
    child.on('error', () => _dropChild('sidecar spawn error'));   // ENOENT etc → fail pending, allow respawn
    child.on('exit', () => { st.child = null; st.ready = false; _failAll('sidecar exited'); });
    return true;
  };

  const request = ({ in: inPath }, wallMs = 60000) => new Promise((resolve) => {
    if (st.down) return resolve({ ok: false, error: 'service shut down' });
    if (!_ensure() || !st.child) return resolve({ ok: false, error: 'sidecar unavailable' });
    const id = st.nextId++;
    const timer = setTimeout(() => { if (st.pending.has(id)) { st.pending.delete(id); resolve({ ok: false, error: 'timeout' }); } }, wallMs);
    st.pending.set(id, { resolve, timer });
    _armIdle();
    try { st.child.stdin.write(JSON.stringify({ id, in: inPath }) + '\n'); }
    catch (e) { try { clearTimeout(timer); } catch {} st.pending.delete(id); resolve({ ok: false, error: 'stdin failed: ' + e.message }); }
  });

  const shutdown = () => { st.down = true; try { clearTimeout(st.idleTimer); } catch {} _dropChild('service shut down'); };

  return { request, shutdown, _state: st };
}

let _singleton = null;
function _idleMs() { try { const v = require('./config').ttsConfig().idleMs; return Number.isFinite(v) ? v : 300000; } catch { return 300000; } }
function _service() { if (!_singleton || _singleton._state.down) _singleton = createSttService({ idleMs: _idleMs() }); return _singleton; }
// stop the resident sidecar (clean app exit / tests). It respawns lazily on the next transcribe().
function shutdownStt() { if (_singleton) { _singleton.shutdown(); _singleton = null; } }

// Transcribe an audio FILE (any ffmpeg-readable container) → { ok, text, ms, lang } | { ok:false, error }.
// Never throws. opts: { wallMs }.
function transcribe(inPath, opts = {}) {
  return new Promise((resolve) => {
    if (!inPath || typeof inPath !== 'string') return resolve({ ok: false, error: 'no input path' });
    const wallMs = Number.isFinite(opts.wallMs) ? opts.wallMs : 60000;
    _service().request({ in: inPath }, wallMs).then(resolve);
  });
}

module.exports = { transcribe, shutdownStt, createSttService, VENV_PY, RUNNER };
