/**
 * lib/voice_orpheus.js — her voice since 2026-09-05 (Lucas, on the A/B: "the zoe voice is the one, switch her
 * over"). Orpheus 3B (Canopy Labs orpheus-3b-0.1-ft, Q4_K_M) served by the Ollama already on this box on the
 * AMD-native backend, in RAW prompt mode; its <custom_token_N> stream is decoded to 24 kHz PCM by the resident
 * SNAC ONNX decoder (sidecar/orpheus_decoder.py --serve, the face_embed idiom: one child, idle-stop, fail-soft).
 *
 * The same contract as voice_kokoro.synthesize: synthesize(text, { voice, out, timeoutMs }) → { ok, out, bytes,
 * sampleRate } | { ok:false, error }. Never throws. Marks (⟦nv:laugh⟧ …) are mapped to the model's own tags by
 * tts.marksToOrpheus before the text reaches here — this file speaks what it is given.
 *
 * Knobs: meta voice.orpheus_voice (default 'zoe'); env ZOE_OLLAMA_URL (default http://127.0.0.1:11434);
 * env ZOE_ORPHEUS_MODEL (default orpheus-tts). The model stays resident (keep_alive −1) like the floor model.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OLLAMA = process.env.ZOE_OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.ZOE_ORPHEUS_MODEL || 'orpheus-tts';
const VOICES = ['tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe'];
const DECODER_PY = process.platform === 'win32'
  ? path.join(ROOT, 'sidecar', 'face_venv', 'Scripts', 'python.exe')
  : path.join(ROOT, 'sidecar', 'face_venv', 'bin', 'python');
const DECODER_SCRIPT = path.join(ROOT, 'sidecar', 'orpheus_decoder.py');
const IDLE_MS = 5 * 60 * 1000;

function voiceName() {
  try { const v = String(require('./db').getMeta('voice.orpheus_voice') || '').toLowerCase(); if (VOICES.includes(v)) return v; } catch {}
  return 'zoe';
}

/** The raw prompt and request body the reference uses — pure, so a smoke can pin the shape. */
function requestBody(text, voice, { maxTokens = 1200 } = {}) {
  return {
    model: MODEL, raw: true, stream: false, keep_alive: -1,
    prompt: `<|audio|>${voice}: ${String(text).trim()}<|eot_id|>`,
    options: { temperature: 0.6, top_p: 0.9, repeat_penalty: 1.1, num_predict: maxTokens },
  };
}

function _post(urlBase, pathName, body, timeoutMs, { httpMod = http } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const u = new URL(pathName, urlBase);
      const data = Buffer.from(JSON.stringify(body));
      const req = httpMod.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { try { finish({ ok: res.statusCode === 200, status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (e) { finish({ ok: false, error: 'bad json: ' + e.message }); } });
      });
      req.on('error', (e) => finish({ ok: false, error: e.message }));
      req.setTimeout(timeoutMs, () => { try { req.destroy(new Error('timeout')); } catch {} finish({ ok: false, error: 'timeout' }); });
      req.end(data);
    } catch (e) { finish({ ok: false, error: e.message }); }
  });
}

// ── the resident decoder ────────────────────────────────────────────────────────────────────────────
function createDecoder({ python = DECODER_PY, script = DECODER_SCRIPT, idleMs = IDLE_MS, spawnFn = spawn, log = console.log } = {}) {
  let child = null, ready = null, buf = '', seq = 0, idleTimer = null;
  const waiting = new Map();
  function stop() { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; if (child) { try { child.kill(); } catch {} } child = null; ready = null; for (const [, w] of waiting) w({ ok: false, error: 'decoder stopped' }); waiting.clear(); }
  function touch() { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(stop, idleMs); if (idleTimer.unref) idleTimer.unref(); }
  function ensure() {
    if (child && ready) return ready;
    buf = '';
    child = spawnFn(python, [script, '--serve'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    ready = new Promise((resolve) => {
      let settled = false;
      const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.kind === 'ready') { settle(!!msg.ok); if (msg.ok) log(`[voice-orpheus] decoder ready in ${msg.load_s}s`); else log(`[voice-orpheus] decoder failed: ${msg.error}`); continue; }
          const w = waiting.get(msg.id); if (w) { waiting.delete(msg.id); w(msg); }
        }
      });
      child.stderr.on('data', () => {});
      child.on('exit', () => { settle(false); child = null; ready = null; for (const [, w] of waiting) w({ ok: false, error: 'decoder exited' }); waiting.clear(); });
      child.on('error', () => settle(false));
    });
    touch();
    return ready;
  }
  async function decode(text, out, { wallMs = 20000 } = {}) {
    const up = await ensure();
    if (!up || !child) return { ok: false, error: 'decoder not up' };
    touch();
    const id = ++seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: 'decode timeout' }); }, wallMs);
      waiting.set(id, (msg) => { clearTimeout(t); resolve(msg); });
      try { child.stdin.write(JSON.stringify({ id, text, out }) + '\n'); } catch (e) { clearTimeout(t); waiting.delete(id); resolve({ ok: false, error: e.message }); }
    });
  }
  return { decode, stop, alive: () => !!child };
}
let _decoder = null;
function decoder() { if (!_decoder) _decoder = createDecoder({}); return _decoder; }

/** Is the model present in Ollama? (cached 60 s; never throws) */
let _availAt = 0, _avail = null;
async function available({ deps = {} } = {}) {
  const now = Date.now();
  if (_avail !== null && now - _availAt < 60000) return _avail;
  const r = await (deps.get || _get)(OLLAMA, '/api/tags', 3000);
  _avail = !!(r && r.ok && Array.isArray(r.json && r.json.models) && r.json.models.some((m) => String(m.name || '').split(':')[0] === MODEL));
  _availAt = now;
  return _avail;
}
function _get(urlBase, pathName, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const u = new URL(pathName, urlBase);
      const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { try { resolve({ ok: res.statusCode === 200, json: JSON.parse(Buffer.concat(c).toString('utf8')) }); } catch (e) { resolve({ ok: false, error: e.message }); } }); });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} resolve({ ok: false, error: 'timeout' }); });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

/** text → wav at `out`. { ok, out, bytes, sampleRate, seconds, genMs } | { ok:false, error }. Never throws. */
async function synthesize(text, { voice = null, out, timeoutMs = 60000, deps = {} } = {}) {
  const v = voice || voiceName();
  if (!out) return { ok: false, error: 'no out path' };
  const t0 = Date.now();
  const r = await (deps.post || _post)(OLLAMA, '/api/generate', requestBody(text, v), timeoutMs);
  if (!r || !r.ok) return { ok: false, error: 'ollama: ' + ((r && (r.error || r.status)) || 'down') };
  const tokens = String((r.json && r.json.response) || '');
  if (!/<custom_token_\d+>/.test(tokens)) return { ok: false, error: 'no audio tokens in the response' };
  const genMs = Date.now() - t0;
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch {}
  const d = await (deps.decoder || decoder()).decode(tokens, out, { wallMs: Math.max(5000, timeoutMs - genMs) });
  if (!d || !d.ok) return { ok: false, error: 'decode: ' + ((d && d.error) || 'failed') };
  return { ok: true, out: d.out || out, bytes: d.bytes, sampleRate: d.sampleRate || 24000, seconds: d.seconds, genMs, voice: v, frames: d.frames };
}

function shutdown() { if (_decoder) { _decoder.stop(); _decoder = null; } }

module.exports = { synthesize, available, requestBody, voiceName, createDecoder, shutdown, VOICES, MODEL, OLLAMA, DECODER_PY, DECODER_SCRIPT };
