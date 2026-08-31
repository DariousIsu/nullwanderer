/**
 * studio/char_voices.js — the character-voice store: named Kokoro blend recipes designed in the tuner.
 *
 * "Make Zoe's voice with the tuner" generalizes: tune a blend, name it, save it here, and it becomes a
 * selectable voice for any persona/character — the top-to-bottom persona (custom voice + reference +
 * poses). Synthesis happens through lib/voice_kokoro (the tuner server). Stored at
 * data/studio/character_voices.json.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const STORE = path.join(ROOT, 'data', 'studio', 'character_voices.json');

function _read() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return []; }
}
function _write(list) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(list, null, 1));
}

function list() { return _read(); }

// add({ name, weights, lang, speed }) — weights: {kokoro_voice_id: number}. Returns the stored voice.
function add(spec) {
  const s = spec || {};
  if (!s.weights || typeof s.weights !== 'object' || !Object.keys(s.weights).length) return { ok: false, error: 'weights required' };
  const list = _read();
  const v = {
    id: `cv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: (s.name || 'unnamed voice').slice(0, 60),
    weights: s.weights, lang: s.lang === 'b' ? 'b' : 'a', speed: Number(s.speed) || 1.0,
    createdAt: Date.now(),
  };
  list.push(v); _write(list);
  return { ok: true, voice: v };
}

function get(id) { return _read().find(v => v.id === id) || null; }
function remove(id) { _write(_read().filter(v => v.id !== id)); return { ok: true }; }

module.exports = { list, add, get, remove, STORE };
