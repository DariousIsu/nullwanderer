/**
 * lib/tts.js — Node wrapper over the local Piper text-to-speech sidecar (sidecar/tts_piper.py).
 *
 * PURPOSE (voice-avatar-plan V1 — the reduced-cost voice "guts"): turn text into a WAV using a LOCAL,
 * offline Piper voice model (~$0/call). This is the reusable seam: meeting speech (V4), desktop read-aloud,
 * and the avatar's lip-sync amplitude (V2) all consume the wav this produces. No network, no cloud TTS.
 *
 * Fail-soft everywhere, mirroring lib/face_match: a missing venv / missing voice model / dead sidecar /
 * timeout all resolve to { ok:false, error } — synthesis never throws and never blocks the caller. The
 * feature is kill-switched OFF by default (config.ttsConfig().enabled) so a fresh clone never spawns a
 * sidecar it doesn't have; callers should check cfg.ttsConfig().enabled before wiring speech into a lane.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const VENV_PY = IS_WIN
  ? path.join(ROOT, 'sidecar', 'tts_venv', 'Scripts', 'python.exe')
  : path.join(ROOT, 'sidecar', 'tts_venv', 'bin', 'python');
const RUNNER = path.join(ROOT, 'sidecar', 'tts_piper.py');
const OUT_DIR = path.join(ROOT, 'data', 'tts');

// pure: normalize model/markdown text into something a TTS engine should actually SAY. Strips markdown
// scaffolding (emphasis, code ticks, link syntax, headings, list bullets), collapses whitespace, and caps
// length (very long single utterances are slow + unnatural — the caller should chunk; we hard-cap as a
// backstop). Returns '' for empty/non-string input. Deterministic → safe to unit-test offline.
function prepareText(text, { maxChars = 1000 } = {}) {
  if (typeof text !== 'string') return '';
  let t = text;
  t = t.replace(/```[\s\S]*?```/g, ' ');            // fenced code blocks — don't read code aloud
  t = t.replace(/`([^`]*)`/g, '$1');                // inline code ticks
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');  // links/images → keep the label text
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');         // heading markers
  t = t.replace(/^\s{0,3}[-*+]\s+/gm, '');          // list bullets
  t = t.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1'); // bold/italic/strike emphasis
  t = t.replace(/^\s{0,3}>\s?/gm, '');              // blockquote markers
  t = t.replace(/\s+/g, ' ').trim();                // collapse all whitespace/newlines
  if (t.length > maxChars) {
    // cut at the last sentence/word boundary before the cap so we don't slice a word in half
    const slice = t.slice(0, maxChars);
    const cut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '), slice.lastIndexOf(' '));
    t = (cut > maxChars * 0.5 ? slice.slice(0, cut + 1) : slice).trim();
  }
  return t;
}

// pure: resolve which voice model file to use. Explicit opts.voice wins, else the configured ZOE_TTS_VOICE.
// Returns null when none is set (caller treats that as "not configured" → fail-soft, no synthesis).
function resolveVoice(opts = {}, cfg = null) {
  const v = (opts && opts.voice) || (cfg && cfg.voice) || '';
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// Synthesize `text` → a WAV file. Returns { ok, out, bytes, sampleRate } or { ok:false, error }. Never throws.
//   opts: { voice, speaker, out, wallMs, python, maxChars }
function synthesize(text, opts = {}) {
  return new Promise((resolve) => {
    const clean = prepareText(text, { maxChars: opts.maxChars });
    if (!clean) return resolve({ ok: false, error: 'empty text' });
    const voice = resolveVoice(opts);
    if (!voice) return resolve({ ok: false, error: 'no voice model configured' });

    let out = opts.out;
    if (!out) {
      try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch {}
      out = path.join(OUT_DIR, `tts_${Date.now()}_${process.pid}.wav`);
    }
    const python = opts.python || VENV_PY;
    const wallMs = Number.isFinite(opts.wallMs) ? opts.wallMs : 60000;
    const speaker = (opts.speaker === 0 || opts.speaker) ? opts.speaker : null;
    const job = JSON.stringify({ text: clean, voice, out, speaker });

    let child;
    try {
      child = spawn(python, [RUNNER], { cwd: ROOT, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + e.message }); }

    let o = '', err = '', done = false, timer = null;
    const finish = (v) => { if (!done) { done = true; try { clearTimeout(timer); } catch {} resolve(v); } };
    timer = setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, error: 'timeout' }); }, wallMs);
    child.stdout.on('data', (d) => { o += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => finish({ ok: false, error: 'child error: ' + e.message }));
    child.on('close', (code) => {
      const line = (o.trim().split(/\r?\n/).filter(Boolean).pop()) || '';   // JSON is the last stdout line
      try { finish(JSON.parse(line)); }
      catch { finish({ ok: false, error: code !== 0 ? `exit ${code}: ${err.slice(-200)}` : 'unparseable: ' + o.slice(0, 160) }); }
    });
    try { child.stdin.write(job); child.stdin.end(); } catch (e) { finish({ ok: false, error: 'stdin failed: ' + e.message }); }
  });
}

// convenience: synthesize + play through the OS default output. For DESKTOP use (V1 demo / read-aloud). The
// meeting path (V3) does NOT use this — it feeds the wav into a MediaStream instead. Fail-soft; never throws.
async function speak(text, opts = {}) {
  const res = await synthesize(text, opts);
  if (!res.ok) return res;
  try {
    await new Promise((resolve) => {
      if (IS_WIN) {
        // PowerShell SoundPlayer plays a wav synchronously without a visible window
        const ps = `(New-Object Media.SoundPlayer '${res.out.replace(/'/g, "''")}').PlaySync();`;
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], () => resolve());
      } else {
        execFile('aplay', [res.out], (e) => { if (e) execFile('afplay', [res.out], () => resolve()); else resolve(); });
      }
    });
  } catch { /* playback is best-effort */ }
  return res;
}

module.exports = { synthesize, speak, prepareText, resolveVoice, VENV_PY, RUNNER, OUT_DIR };
