/**
 * lib/voice_kokoro.js — synthesize a tuned Kokoro voice via the voice-tuner server (:8199).
 *
 * The voice tuner (sidecar/kokoro_tuner_server.py) loads Kokoro on the GPU and exposes /synth
 * (weights + lang + speed → wav). That same server doubles as the synth engine for a "character voice"
 * — a saved blend recipe. So a persona/character with a tuned voice speaks through the tuner.
 *
 * Fail-soft: if the tuner isn't running, available() is false and synthesize returns { ok:false } so the
 * caller degrades to the default program voice — the render never blocks on the tuner being up.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.ZOE_TUNER_URL || 'http://127.0.0.1:8199';
const OUT_DIR = path.join(ROOT, 'data', 'tts', 'kokoro');
const TUNER_PY = process.platform === 'win32'
  ? path.join(ROOT, 'sidecar', 'tts_kokoro_venv', 'Scripts', 'python.exe')
  : path.join(ROOT, 'sidecar', 'tts_kokoro_venv', 'bin', 'python');
const TUNER_SCRIPT = path.join(ROOT, 'sidecar', 'kokoro_tuner_server.py');

async function available() {
  try { const r = await fetch(BASE + '/voices', { signal: AbortSignal.timeout(2500) }); return r.ok; }
  catch { return false; }
}

// THE CONSOLIDATION (2026-09-01, RAM lever 3): the tuner is the ONE resident Kokoro. If it isn't up,
// spawn it FROM THE SAME RECIPE it is always born with (venv python + script + the GPU/MIOpen env pins
// that tts_kokoro.py documents), DETACHED — it deliberately survives app cycles, keeping the voice warm
// across reboots (observed live: the 08-31 tuner served p215 AND p216). Polls /status until the HTTP
// server binds (the model itself stays lazy — first synth loads it). Fail-soft: false, never throws.
let _spawnedOnce = false;
async function ensureUp({ spawnFn = spawn, timeoutMs = 20000 } = {}) {
  if (await available()) return true;
  if (!_spawnedOnce) {
    _spawnedOnce = true;   // one spawn attempt per process — a broken venv must not fork-bomb
    try {
      const child = spawnFn(TUNER_PY, [TUNER_SCRIPT], {
        cwd: ROOT,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          HIP_VISIBLE_DEVICES: process.env.HIP_VISIBLE_DEVICES || '1',
          MIOPEN_FIND_MODE: process.env.MIOPEN_FIND_MODE || '2',
          MIOPEN_USER_DB_PATH: process.env.MIOPEN_USER_DB_PATH || path.join(require('os').homedir(), '.miopen_cache'),
          MIOPEN_CUSTOM_CACHE_DIR: process.env.MIOPEN_CUSTOM_CACHE_DIR || path.join(require('os').homedir(), '.miopen_cache'),
          KMP_DUPLICATE_LIB_OK: 'TRUE',
        },
        detached: true, stdio: 'ignore',
      });
      if (child && child.unref) child.unref();
    } catch { return false; }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await available()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/*
 * synthesizeDefault(text, opts) → { ok, out, bytes, sampleRate } | { ok:false, error }
 * Speaks in ZOE'S OWN voice: no weights in the request, so the tuner falls back to the saved
 * recipe (data/voices/zoe_voice.json) server-side. opts: { out, timeoutMs, fetchFn }.
 */
async function synthesizeDefault(text, opts = {}) {
  try {
    if (!text || !String(text).trim()) return { ok: false, error: 'empty text' };
    const doFetch = opts.fetchFn || fetch;
    const r = await doFetch(BASE + '/synth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text) }),
      signal: AbortSignal.timeout(opts.timeoutMs || 120000),
    });
    if (!r.ok) return { ok: false, error: `tuner /synth HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` };
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = opts.out || path.join(OUT_DIR, `kok_${Date.now()}.wav`);
    fs.writeFileSync(out, buf);
    return { ok: true, out, bytes: buf.length, sampleRate: 24000 };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

/*
 * synthesize(text, recipe, opts) → { ok, out } | { ok:false, error }
 *   recipe = { weights:{voice_id:number}, lang:'a'|'b', speed:number }  — a tuner blend recipe
 */
async function synthesize(text, recipe, opts = {}) {
  try {
    const rc = recipe || {};
    if (!text || !String(text).trim()) return { ok: false, error: 'empty text' };
    if (!rc.weights || !Object.keys(rc.weights).length) return { ok: false, error: 'recipe has no voice weights' };
    const r = await fetch(BASE + '/synth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text), weights: rc.weights, lang: rc.lang || 'a', speed: rc.speed || 1.0 }),
      signal: AbortSignal.timeout(opts.timeoutMs || 120000),
    });
    if (!r.ok) return { ok: false, error: `tuner /synth HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` };
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = opts.out || path.join(OUT_DIR, `kok_${Date.now()}.wav`);
    fs.writeFileSync(out, buf);
    return { ok: true, out, bytes: buf.length };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

module.exports = { available, ensureUp, synthesize, synthesizeDefault, BASE };
