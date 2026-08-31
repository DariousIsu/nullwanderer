/**
 * lib/voice_clone.js — Node wrapper over the F5-TTS zero-shot voice-clone sidecar.
 *
 * The persona-voice engine: synthesize arbitrary text in a target voice given a clean reference clip.
 * Native Windows, CPU torch (a ROCm swap only adds speed) — no WSL, no patch-arounds, per the brief.
 * Mirrors lib/tts.js: fail-soft { ok:false, error } (never throws), and never SAYS without DOING —
 * ok:true means the WAV exists and was probed.
 *
 * available() is a measured presence probe (venv + sidecar + OpenF5 checkpoint on disk) for the
 * capability manifest. A persona whose voice was "built" carries { engine:'f5', refAudio, refText? };
 * synthesize(text, voice) routes here, everything else keeps using Piper (lib/tts.js).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SIDE = path.join(ROOT, 'sidecar', 'voice_clone');
const VENV_PY = path.join(SIDE, 'vc_venv', 'Scripts', 'python.exe');
const RUNNER = path.join(SIDE, 'clone_tts.py');
const OUT_DIR = path.join(ROOT, 'data', 'tts', 'clones');

const HUB = path.join(process.env.USERPROFILE || require('os').homedir(), '.cache', 'huggingface', 'hub');
// Prefer OpenF5 (Apache-2.0) when downloaded; the sidecar falls back to the cached SWivid F5TTS_v1_Base.
function openF5Paths() {
  try {
    const snaps = path.join(HUB, 'models--mrfakename--OpenF5-TTS-Base', 'snapshots');
    const snap = fs.readdirSync(snaps).map(d => path.join(snaps, d)).find(d => fs.existsSync(path.join(d, 'model.pt')));
    if (snap) return { ckpt: path.join(snap, 'model.pt'), vocab: path.join(snap, 'vocab.txt') };
  } catch { /* not downloaded */ }
  return null; // → sidecar uses the cached default checkpoint
}
// Either weights path counts as available: OpenF5, or the SWivid F5-TTS base already in the HF cache.
function weightsPresent() {
  if (openF5Paths()) return true;
  try {
    const snaps = path.join(HUB, 'models--SWivid--F5-TTS', 'snapshots');
    return fs.readdirSync(snaps).some(d => fs.existsSync(path.join(snaps, d, 'F5TTS_v1_Base', 'model_1250000.safetensors')));
  } catch { return false; }
}

function available() {
  try { return fs.existsSync(VENV_PY) && fs.existsSync(RUNNER) && weightsPresent(); }
  catch { return false; }
}

/*
 * synthesize(text, voice, opts) → { ok, out, sampleRate } | { ok:false, error }
 *   voice = { refAudio, refText? }  — the persona's reference clip (its captured timbre)
 */
function synthesize(text, voice, opts = {}) {
  return new Promise((resolve) => {
    try {
      if (!available()) return resolve({ ok: false, error: 'voice-clone sidecar not installed (venv/runner/checkpoint)' });
      const v = voice || {};
      if (!text || !String(text).trim()) return resolve({ ok: false, error: 'empty text' });
      if (!v.refAudio || !fs.existsSync(v.refAudio)) return resolve({ ok: false, error: `ref_audio missing: ${v.refAudio}` });
      const paths = openF5Paths(); // null → sidecar uses the cached SWivid default
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const out = opts.out || path.join(OUT_DIR, `clone_${Date.now()}.wav`);
      const req = JSON.stringify({
        text: String(text), ref_audio: path.resolve(v.refAudio), ref_text: v.refText || '',
        out, ckpt: paths ? paths.ckpt : '', vocab: paths ? paths.vocab : '',
      });
      // F5 auto-transcribes the reference with Whisper, which shells out to `ffmpeg` by name — put our
      // bundled ffmpeg-static on the sidecar's PATH so no system ffmpeg install is needed.
      let ffDir = '';
      try { ffDir = path.dirname(require('ffmpeg-static')); } catch { /* leave PATH as-is */ }
      const env = Object.assign({}, process.env, ffDir ? { PATH: ffDir + path.delimiter + (process.env.PATH || '') } : {});
      execFile(VENV_PY, [RUNNER, req], { timeout: opts.timeoutMs || 600000, maxBuffer: 16 * 1024 * 1024, env }, (err, stdout, stderr) => {
        if (err && !stdout) return resolve({ ok: false, error: `sidecar failed: ${String(stderr || err).slice(-400)}` });
        let parsed = null;
        for (const line of String(stdout).trim().split('\n').reverse()) { try { parsed = JSON.parse(line); break; } catch { /* keep looking */ } }
        if (!parsed) return resolve({ ok: false, error: `no json from sidecar: ${String(stdout).slice(-300)}` });
        if (!parsed.ok) return resolve(parsed);
        if (!fs.existsSync(parsed.out)) return resolve({ ok: false, error: 'sidecar reported ok but no file' });
        resolve(parsed);
      });
    } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
  });
}

module.exports = { synthesize, available, openF5Paths };
