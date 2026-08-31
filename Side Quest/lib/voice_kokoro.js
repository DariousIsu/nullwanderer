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

const BASE = process.env.ZOE_TUNER_URL || 'http://127.0.0.1:8199';
const OUT_DIR = path.join(path.resolve(__dirname, '..'), 'data', 'tts', 'kokoro');

async function available() {
  try { const r = await fetch(BASE + '/voices', { signal: AbortSignal.timeout(2500) }); return r.ok; }
  catch { return false; }
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

module.exports = { available, synthesize, BASE };
