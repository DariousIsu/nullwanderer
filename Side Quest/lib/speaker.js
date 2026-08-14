/**
 * lib/speaker.js — Node wrapper over the local speaker-embedding sidecar (sidecar/speaker_verify.py) PLUS the
 * operator voiceprint store + cosine gate policy.
 *
 * PURPOSE (two-way voice — the "is this actually the operator talking?" gate): an always-on mic hears the
 * whole room. STT turns EVERY utterance into text — a video the operator is watching, another person, an
 * announcement — and the old path fed all of it to Zoe's brain as if he'd said it. This module verifies the
 * VOICE: embed the utterance, compare (cosine) against the enrolled operator centroid, admit only above a
 * threshold. The model (sidecar) is dumb (WAV -> 512-d L2-normalized vector); the POLICY lives here so the
 * threshold can be tuned live without touching Python.
 *
 * Transport is the SAME resident-sidecar NDJSON contract as lib/stt.js / lib/tts.js (reusing parseNdjson):
 * a --serve child loads the CAM++ model once and answers id-correlated { id, in } requests. Fail-soft
 * everywhere — a missing venv / dead sidecar / timeout resolves to { ok:false, error } and NEVER throws.
 * Fail-open at the GATE: if verification can't run, we admit the turn (never silently deafen her on a bug).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parseNdjson } = require('./tts');   // reuse the exact NDJSON line framer

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const VENV_PY = IS_WIN
  ? path.join(ROOT, 'sidecar', 'spk_venv', 'Scripts', 'python.exe')
  : path.join(ROOT, 'sidecar', 'spk_venv', 'bin', 'python');
const RUNNER = path.join(ROOT, 'sidecar', 'speaker_verify.py');
const STORE = process.env.ZOE_SPEAKER_STORE || path.join(ROOT, 'data', 'voices', 'operator_voiceprint.json');
const MODEL_ID = path.basename(process.env.ZOE_SPEAKER_MODEL || '3dspeaker_campplus_en.onnx');

// Cosine threshold to admit a voice as the operator. LIVE CALIBRATION 2026-08-14 (the stray-video
// defect): across the day's real traffic Lucas's genuine turns scored 0.609–0.839 (16 turns) and
// impostors — videos playing through his room speakers, other voices — scored 0.129–0.541 (7).
// The original 0.50 sat INSIDE the impostor band: a prerecorded video hit 0.541 and was answered.
// 0.575 = the midpoint of the measured gap. (Bench numbers "different voices ~0.2-0.33" missed
// that speaker-played audio re-recorded through the SAME mic inherits the room's acoustics.)
const DEFAULT_THR = 0.575;
function defaultThreshold() { const v = Number(process.env.ZOE_SPEAKER_THRESHOLD); return Number.isFinite(v) ? v : DEFAULT_THR; }
// Threshold policy in ONE place — priority: explicit opts > ZOE_SPEAKER_THRESHOLD (live tuning) >
// the print's enrolled snapshot > default. The old order let the snapshot beat the env var, so
// "tune live without re-enrolling" was false: the stored 0.50 always won.
function effectiveThreshold(vp, opts) {
  if (opts && Number.isFinite(opts.threshold)) return opts.threshold;
  const env = Number(process.env.ZOE_SPEAKER_THRESHOLD);
  if (Number.isFinite(env)) return env;
  if (vp && Number.isFinite(vp.threshold)) return vp.threshold;
  return DEFAULT_THR;
}
// Master switch. '0' disables the gate entirely (always admit) — for A/B without re-enrolling.
function gateEnabled() { return String(process.env.ZOE_SPEAKER_GATE || '1') !== '0'; }

// ---- resident sidecar service (mirrors createSttService in lib/stt.js) --------------------------------
function createSpeakerService({ python = VENV_PY, runner = RUNNER, idleMs = 300000 } = {}) {
  const st = { child: null, buf: '', pending: new Map(), nextId: 1, ready: false, down: false, idleTimer: null };
  const _failAll = (err) => { for (const [, p] of st.pending) { try { clearTimeout(p.timer); } catch {} p.resolve({ ok: false, error: err }); } st.pending.clear(); };
  const _dropChild = (err) => { st.ready = false; if (st.child) { try { st.child.kill(); } catch {} st.child = null; } _failAll(err); };
  const _armIdle = () => {
    if (!idleMs) return;
    try { clearTimeout(st.idleTimer); } catch {}
    st.idleTimer = setTimeout(() => { if (st.pending.size === 0 && st.child) { try { st.child.stdin.end(); } catch {} try { st.child.kill(); } catch {} st.child = null; st.ready = false; } }, idleMs);
    if (st.idleTimer && st.idleTimer.unref) st.idleTimer.unref();
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
    child.stderr.on('data', () => { /* swallow sherpa/onnx init chatter */ });
    child.on('error', () => _dropChild('sidecar spawn error'));
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
function _service() { if (!_singleton || _singleton._state.down) _singleton = createSpeakerService({ idleMs: _idleMs() }); return _singleton; }
function shutdownSpeaker() { if (_singleton) { _singleton.shutdown(); _singleton = null; } }

// Embed one audio FILE → { ok, emb:[..], dim, ms, dur, peak } | { ok:false, error }. Never throws.
function embed(inPath, opts = {}) {
  return new Promise((resolve) => {
    if (!inPath || typeof inPath !== 'string') return resolve({ ok: false, error: 'no input path' });
    const wallMs = Number.isFinite(opts.wallMs) ? opts.wallMs : 60000;
    _service().request({ in: inPath }, wallMs).then(resolve);
  });
}

// ---- voiceprint store --------------------------------------------------------------------------------
function _cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb); return d < 1e-9 ? 0 : dot / d;
}
function _centroid(samples) {
  if (!samples || !samples.length) return null;
  const dim = samples[0].emb.length; const c = new Array(dim).fill(0);
  for (const s of samples) for (let i = 0; i < dim; i++) c[i] += s.emb[i];
  let n = 0; for (let i = 0; i < dim; i++) n += c[i] * c[i]; n = Math.sqrt(n);
  if (n < 1e-9) return null;
  for (let i = 0; i < dim; i++) c[i] /= n;
  return c;
}
function _load() {
  try { const j = JSON.parse(fs.readFileSync(STORE, 'utf8')); if (j && Array.isArray(j.samples)) return j; } catch {}
  return null;
}
function _save(vp) {
  try { fs.mkdirSync(path.dirname(STORE), { recursive: true }); } catch {}
  fs.writeFileSync(STORE, JSON.stringify(vp, null, 2));
}
// A stored print is only usable if it matches the CURRENT model (dim + model id) — a model swap invalidates it.
function _usable(vp) {
  return !!(vp && Array.isArray(vp.samples) && vp.samples.length && vp.centroid && vp.model === MODEL_ID);
}

// { enrolled, count, threshold, dim, model, gate, stale } — stale = a print exists but for a different model.
function status() {
  const vp = _load();
  const enrolled = _usable(vp);
  return {
    enrolled,
    count: (vp && vp.samples && vp.samples.length) || 0,
    threshold: effectiveThreshold(vp, null),
    dim: (vp && vp.dim) || 0,
    model: MODEL_ID,
    gate: gateEnabled(),
    stale: !!(vp && vp.samples && vp.samples.length && vp.model !== MODEL_ID),
  };
}

// Add one enrollment sample from an audio file. Returns { ok, count, dur } | { ok:false, error }.
async function enroll(inPath) {
  const r = await embed(inPath);
  if (!r || !r.ok || !Array.isArray(r.emb)) return { ok: false, error: (r && r.error) || 'embed failed' };
  let vp = _load();
  if (!vp || vp.model !== MODEL_ID) vp = { version: 1, model: MODEL_ID, dim: r.dim, threshold: defaultThreshold(), samples: [], createdAt: new Date().toISOString() };
  vp.samples.push({ emb: r.emb, ts: new Date().toISOString(), dur: r.dur, peak: r.peak });
  if (vp.samples.length > 12) vp.samples = vp.samples.slice(-12);   // keep the most recent dozen
  vp.centroid = _centroid(vp.samples);
  vp.dim = r.dim; vp.updatedAt = new Date().toISOString();
  _save(vp);
  return { ok: true, count: vp.samples.length, dur: r.dur };
}

function reset() { try { fs.unlinkSync(STORE); } catch {} return { ok: true }; }

// Verify an utterance file against the enrolled operator. Returns:
//   { ok, enrolled, match, score, threshold, gate }
// match=true (admit) when: gate disabled, OR not enrolled (pass-through until enrolled), OR score>=threshold.
// FAIL-OPEN: if the embedding can't be computed, admit (never deafen her on a sidecar hiccup) but flag it.
async function verify(inPath, opts = {}) {
  const gate = gateEnabled();
  const vp = _load();
  const enrolled = _usable(vp);
  const threshold = effectiveThreshold(vp, opts);
  if (!gate || !enrolled) return { ok: true, enrolled, match: true, score: null, threshold, gate };
  const r = await embed(inPath, opts);
  if (!r || !r.ok || !Array.isArray(r.emb)) return { ok: false, enrolled, match: true, score: null, threshold, gate, error: (r && r.error) || 'embed failed', failOpen: true };
  const score = _cosine(vp.centroid, r.emb);
  return { ok: true, enrolled, match: score >= threshold, score: Math.round(score * 1000) / 1000, threshold, gate, dur: r.dur, peak: r.peak };
}

module.exports = { embed, enroll, verify, status, reset, shutdownSpeaker, createSpeakerService, effectiveThreshold, defaultThreshold, DEFAULT_THR, _cosine, _centroid, VENV_PY, RUNNER, STORE, MODEL_ID };
