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

/**
 * The raw prompt and request body — pure, so a smoke can pin the shape. SAMPLING (his ear on the live app,
 * 09-05 ~11:50: "rough and not Zoe's voice … slow mo"): the eval spoke long lines at the reference's 0.6 and
 * held one voice; live she speaks short sentences, each a fresh sample, and the pitch swung 162–261 Hz across
 * them (the reel: 169–175). A lower temperature holds the voice; the speech manager also groups her sentences
 * into one request. meta voice.orpheus_temp / env ZOE_ORPHEUS_TEMP override.
 */
function temperature() {
  const env = parseFloat(process.env.ZOE_ORPHEUS_TEMP || '');
  if (Number.isFinite(env) && env > 0 && env <= 1.5) return env;
  try { const m = parseFloat(require('./db').getMeta('voice.orpheus_temp') || ''); if (Number.isFinite(m) && m > 0 && m <= 1.5) return m; } catch {}
  return 0.4;
}
/**
 * THE PREFIX FOLLOWS THE MODEL (09-05 15:40, measured in the fine-tune's tokenizer.json): <|audio|> is id 156939,
 * the LAST token of the Orpheus vocab, while the reference fine-tune format opens the human turn with 128259 =
 * <custom_token_3>. The base model tolerates the community prompt (WER 0.31); HER fine-tune (a model name with
 * "zoe") was trained on exactly [BOS][128259] text [128009] (sidecar/orpheus_finetune.py), so it is prompted with
 * the same ids — Ollama prepends BOS itself in raw mode and <custom_token_3> is one token (prompt_eval_count 2
 * for that string alone, both models). Mirrors sidecar/orpheus_eval.py prefix_for. ZOE_ORPHEUS_PREFIX overrides.
 */
function prefixFor(model) {
  const env = String(process.env.ZOE_ORPHEUS_PREFIX || '').trim();
  if (env) return env;
  return /zoe/i.test(String(model || '')) ? '<custom_token_3>' : '<|audio|>';
}
function requestBody(text, voice, { maxTokens = 2400 } = {}) {
  return {
    model: MODEL, raw: true, stream: false, keep_alive: -1,
    prompt: `${prefixFor(MODEL)}${voice}: ${String(text).trim()}<|eot_id|>`,
    // stop at end_of_speech (<custom_token_2>): her fine-tuned voice ends a line there and would run on without it
    options: { temperature: temperature(), top_p: 0.9, repeat_penalty: 1.1, num_predict: maxTokens, stop: ['<custom_token_2>'] },
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
  const streamIds = new Set();
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
          // a whole-line request has ONE reply (the waiter goes); a stream has many (its waiter stays until done)
          const w = waiting.get(msg.id); if (w) { if (!streamIds.has(msg.id)) waiting.delete(msg.id); w(msg); }
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
  /** A stream: append raw token text as it arrives; PCM frames come back through onChunk; done() flushes. */
  async function openStream({ onChunk, onDone }) {
    const up = await ensure();
    if (!up || !child) return null;
    touch();
    const id = ++seq;
    let closed = false;
    streamIds.add(id);
    waiting.set(id, (msg) => {
      if (msg.pcm) { try { onChunk({ seq: msg.seq, pcm: Buffer.from(msg.pcm, 'base64'), samples: msg.samples }); } catch {} return; }
      if (msg.done) { waiting.delete(id); streamIds.delete(id); closed = true; try { onDone(msg); } catch {} }
    });
    const send = (o) => { try { child.stdin.write(JSON.stringify({ id, stream: true, ...o }) + '\n'); return true; } catch { return false; } };
    return {
      id,
      append: (text) => { if (!closed) { touch(); send({ append: text }); } },
      done: () => { if (!closed) send({ done: true }); },
      abort: () => { if (!closed) { closed = true; waiting.delete(id); streamIds.delete(id); send({ abort: true }); } },
    };
  }
  return { decode, openStream, stop, alive: () => !!child };
}

/**
 * STREAMING (his word: "streaming"): a raw completion with stream:true; every Ollama chunk's text goes to the
 * decoder's stream, which answers with 2048-sample PCM frames as soon as a frame has its context (≈ 28 tokens
 * ≈ 0.2 s of generation). onChunk({ seq, pcm, samples }) fires per frame; the promise resolves at the end with
 * { ok, frames, samples, seconds, firstChunkMs, genMs } or { ok:false, error }. abort() stops both ends.
 */
function synthesizeStream(text, { voice = null, onChunk, timeoutMs = 90000, deps = {} } = {}) {
  const v = voice || voiceName();
  const t0 = Date.now();
  let firstChunkMs = null, aborted = false, req = null, stream = null;
  const p = new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const killer = setTimeout(() => { try { if (req) req.destroy(new Error('timeout')); } catch {} try { if (stream) stream.abort(); } catch {} finish({ ok: false, error: 'timeout' }); }, timeoutMs);
    (async () => {
      const dec = deps.decoder || decoder();
      stream = await dec.openStream({
        onChunk: (c) => { if (firstChunkMs === null) firstChunkMs = Date.now() - t0; try { onChunk && onChunk(c); } catch {} },
        onDone: (m) => { clearTimeout(killer); finish(m.ok === false ? { ok: false, error: m.error || 'decoder' } : { ok: true, frames: m.frames, samples: m.samples, seconds: +((m.samples || 0) / 24000).toFixed(2), firstChunkMs, genMs: Date.now() - t0, voice: v }); },
      });
      if (!stream) { clearTimeout(killer); return finish({ ok: false, error: 'decoder not up' }); }
      const body = { ...requestBody(text, v), stream: true };
      const httpMod = deps.http || http;
      let sawToken = false;
      try {
        const u = new URL('/api/generate', OLLAMA);
        const data = Buffer.from(JSON.stringify(body));
        req = httpMod.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
          if (res.statusCode !== 200) { clearTimeout(killer); stream.abort(); return finish({ ok: false, error: 'ollama: ' + res.statusCode }); }
          let buf = '';
          res.on('data', (d) => {
            if (aborted) return;
            buf += d.toString('utf8');
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
              if (!line) continue;
              let o; try { o = JSON.parse(line); } catch { continue; }
              if (o.response) { if (/<custom_token_\d+>/.test(o.response)) sawToken = true; stream.append(o.response); }
              if (o.done) { if (!sawToken) { clearTimeout(killer); stream.abort(); return finish({ ok: false, error: 'no audio tokens in the response' }); } stream.done(); }
            }
          });
          res.on('end', () => { if (!aborted && !sawToken) { clearTimeout(killer); stream.abort(); finish({ ok: false, error: 'no audio tokens in the response' }); } });
          res.on('error', (e) => { clearTimeout(killer); stream.abort(); finish({ ok: false, error: e.message }); });
        });
        req.on('error', (e) => { clearTimeout(killer); if (stream) stream.abort(); finish({ ok: false, error: 'ollama: ' + e.message }); });
        req.end(data);
      } catch (e) { clearTimeout(killer); if (stream) stream.abort(); finish({ ok: false, error: e.message }); }
    })();
  });
  p.abort = () => { aborted = true; try { if (req) req.destroy(new Error('aborted')); } catch {} try { if (stream) stream.abort(); } catch {} };
  return p;
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

module.exports = { synthesize, synthesizeStream, available, requestBody, voiceName, createDecoder, decoder, shutdown, VOICES, MODEL, OLLAMA, DECODER_PY, DECODER_SCRIPT, prefixFor };
