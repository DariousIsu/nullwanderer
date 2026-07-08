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
 *
 * PERSISTENT by default (V1+): synthesize() routes to a resident --serve sidecar that loads the voice model
 * once and streams utterances (call 1 pays ~1.5-2s load; calls 2+ are ~model-free). It idle-kills itself
 * after ttsConfig().idleMs and respawns lazily. opts.oneShot / opts.python force a one-shot spawn instead.
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
  // FIRST, never voice her private cognition or structural/tool tags. Her stream is <think>…</think>
  // <say>…</say> (+ action tags); the renderer files <think> to the sheep panel and shows only <say>.
  // TTS must match: drop think blocks, keep only <say> content, and scrub any stray/unclosed tags
  // (e.g. a bare "<think" or "<browse-read/>") so nothing internal is ever spoken aloud.
  t = t.replace(/<(think|thinking|thought|thoughts)\b[\s\S]*?<\/\1>/gi, ' ');   // whole think blocks (all 4 spellings the parser tolerates)
  const say = [...t.matchAll(/<say>([\s\S]*?)<\/say>/gi)].map((m) => m[1]);
  if (say.length) t = say.join(' ');                                    // if she used <say>, speak only that
  t = t.replace(/<\/?[a-z][\w-]*\b[^>]*>?/gi, ' ');                     // any remaining tags, incl. unclosed
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

// pure: split a stdout buffer into complete NDJSON messages + the trailing incomplete remainder. The
// persistent sidecar emits one JSON object per line; this frames the stream (garbage lines are skipped).
function parseNdjson(buf) {
  const parts = String(buf || '').split('\n');
  const rest = parts.pop();                 // last element is the incomplete tail (or '' after a clean \n)
  const messages = [];
  for (const line of parts) {
    const s = line.trim();
    if (!s) continue;
    try { messages.push(JSON.parse(s)); } catch { /* skip non-JSON noise */ }
  }
  return { messages, rest };
}

let _outSeq = 0;
function _resolveOut(opts) {
  if (opts.out) return opts.out;
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch {}
  return path.join(OUT_DIR, `tts_${Date.now()}_${process.pid}_${_outSeq++}.wav`);
}

// ONE-SHOT backend: spawn the sidecar, synthesize once, exit. Used for explicit python overrides / tests
// (opts.python) and opts.oneShot. Pays the ~1.5-2s model load every call — the persistent path avoids that.
function synthesizeOneShot({ text, voice, out, speaker, python, wallMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python || VENV_PY, [RUNNER], { cwd: ROOT, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    try { child.stdin.write(JSON.stringify({ text, voice, out, speaker })); child.stdin.end(); } catch (e) { finish({ ok: false, error: 'stdin failed: ' + e.message }); }
  });
}

// PERSISTENT backend: a resident sidecar (--serve) that loads the voice model ONCE and answers newline-
// delimited requests, so every call after the first skips the model reload. Requests are correlated to
// responses by an incrementing id. Fail-soft: a crashed/absent sidecar fails the in-flight calls and lets
// the next call respawn lazily. After `idleMs` with nothing pending the child is killed (frees the ~63MB
// model); it respawns on demand. Factory form (not just a singleton) so tests can point it at a bad python.
function createPiperService({ python = VENV_PY, idleMs = 300000 } = {}) {
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
      child = spawn(python, [RUNNER, '--serve'], { cwd: ROOT, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    child.stderr.on('data', () => { /* swallow piper init chatter */ });
    child.on('error', () => _dropChild('sidecar spawn error'));   // ENOENT etc → fail pending, allow respawn
    child.on('exit', () => { st.child = null; st.ready = false; _failAll('sidecar exited'); });
    return true;
  };

  const request = ({ text, voice, out, speaker }, wallMs = 60000) => new Promise((resolve) => {
    if (st.down) return resolve({ ok: false, error: 'service shut down' });
    if (!_ensure() || !st.child) return resolve({ ok: false, error: 'sidecar unavailable' });
    const id = st.nextId++;
    const timer = setTimeout(() => { if (st.pending.has(id)) { st.pending.delete(id); resolve({ ok: false, error: 'timeout' }); } }, wallMs);
    st.pending.set(id, { resolve, timer });
    _armIdle();
    try { st.child.stdin.write(JSON.stringify({ id, text, voice, out, speaker }) + '\n'); }
    catch (e) { try { clearTimeout(timer); } catch {} st.pending.delete(id); resolve({ ok: false, error: 'stdin failed: ' + e.message }); }
  });

  const shutdown = () => { st.down = true; try { clearTimeout(st.idleTimer); } catch {} _dropChild('service shut down'); };

  return { request, shutdown, _state: st };
}

let _singleton = null;
function _idleMs() { try { return require('./config').ttsConfig().idleMs; } catch { return 300000; } }
function _service() { if (!_singleton || _singleton._state.down) _singleton = createPiperService({ idleMs: _idleMs() }); return _singleton; }
// stop the resident sidecar (clean app exit / tests). It respawns lazily on the next synthesize().
function shutdownTts() { if (_singleton) { _singleton.shutdown(); _singleton = null; } }

// Synthesize `text` → a WAV file. Returns { ok, out, bytes, sampleRate } or { ok:false, error }. Never throws.
// Routes to the PERSISTENT sidecar by default (warm, no per-call reload); opts.oneShot or an explicit
// opts.python forces a one-shot spawn.  opts: { voice, speaker, out, wallMs, python, oneShot, maxChars }
function synthesize(text, opts = {}) {
  return new Promise((resolve) => {
    const clean = prepareText(text, { maxChars: opts.maxChars });
    if (!clean) return resolve({ ok: false, error: 'empty text' });
    const voice = resolveVoice(opts);
    if (!voice) return resolve({ ok: false, error: 'no voice model configured' });
    const out = _resolveOut(opts);
    const speaker = (opts.speaker === 0 || opts.speaker) ? opts.speaker : null;
    const wallMs = Number.isFinite(opts.wallMs) ? opts.wallMs : 60000;
    if (opts.oneShot || opts.python) {
      synthesizeOneShot({ text: clean, voice, out, speaker, python: opts.python, wallMs }).then(resolve);
    } else {
      _service().request({ text: clean, voice, out, speaker }, wallMs).then(resolve);
    }
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

module.exports = { synthesize, speak, shutdownTts, createPiperService, parseNdjson, prepareText, resolveVoice, VENV_PY, RUNNER, OUT_DIR };
