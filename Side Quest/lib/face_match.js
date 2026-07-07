/**
 * lib/face_match.js — Node wrapper over the face-embedding sidecar (sidecar/face_embed.py, insightface/ONNX).
 *
 * PURPOSE (bounded): CONFIRM identity. Given a reference headshot (grabbed at discovery) and a PUBLIC profile
 * photo the caller already found by name/handle, decide "same person?" via ArcFace embedding cosine. This is
 * a disambiguation signal on candidate PUBLIC profiles — NOT a reverse-face-search / de-anonymizer (there is
 * no "search by face" here; the caller supplies the images). Consume-only, verify-before-promote upstream.
 *
 * Fail-soft everywhere: a dead sidecar / missing venv / no-face / timeout all resolve to a safe negative.
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const VENV_PY = IS_WIN
  ? path.join(ROOT, 'sidecar', 'face_venv', 'Scripts', 'python.exe')
  : path.join(ROOT, 'sidecar', 'face_venv', 'bin', 'python');
const RUNNER = path.join(ROOT, 'sidecar', 'face_embed.py');

// ArcFace normed-embedding cosine. Same person typically > 0.45; different < 0.25. We CONFIRM, so bias to
// precision (a false "same" is worse than a miss) → a conservative default. Override per-call if needed.
const SAME_FACE_THRESHOLD = 0.45;

// pure: cosine similarity of two vectors (normed embeddings → this is just the dot product, but be safe).
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}
function isSameFace(a, b, threshold = SAME_FACE_THRESHOLD) { return cosine(a, b) >= threshold; }

// embed a BATCH of images (each { id, path | url }) → { ok, results:[{id, ok, embedding?, reason?}] }.
// Spawns the venv sidecar once per batch (model load is the expensive part). Fail-soft; never throws.
function embedImages(items, { wallMs = 120000, python = VENV_PY } = {}) {
  return new Promise((resolve) => {
    const job = JSON.stringify({ items: items || [] });
    let child;
    try {
      child = spawn(python, [RUNNER], { cwd: ROOT, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + e.message, results: [] }); }

    let out = '', err = '', done = false;
    const finish = (v) => { if (!done) { done = true; try { clearTimeout(timer); } catch {} resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, error: 'timeout', results: [] }); }, wallMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => finish({ ok: false, error: 'child error: ' + e.message, results: [] }));
    child.on('close', (code) => {
      const line = (out.trim().split(/\r?\n/).filter(Boolean).pop()) || '';   // JSON is the last stdout line
      try { finish(JSON.parse(line)); }
      catch { finish({ ok: false, error: code !== 0 ? `exit ${code}: ${err.slice(-200)}` : 'unparseable: ' + out.slice(0, 160), results: [] }); }
    });
    try { child.stdin.write(job); child.stdin.end(); } catch (e) { finish({ ok: false, error: 'stdin failed: ' + e.message, results: [] }); }
  });
}

// convenience: embed a reference + candidates, return each candidate with its similarity + same-person verdict.
async function confirmAgainst(referenceImage, candidateImages, { threshold = SAME_FACE_THRESHOLD, ...opts } = {}) {
  const items = [{ id: '__ref__', ...referenceImage }, ...candidateImages.map((c, i) => ({ id: i, ...c }))];
  const res = await embedImages(items, opts);
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'embed-failed', matches: [] };
  const byId = new Map((res.results || []).map((r) => [String(r.id), r]));
  const ref = byId.get('__ref__');
  if (!ref || !ref.ok) return { ok: false, error: 'reference has no usable face (' + ((ref && ref.reason) || 'missing') + ')', matches: [] };
  const matches = candidateImages.map((c, i) => {
    const r = byId.get(String(i));
    if (!r || !r.ok) return { ...c, ok: false, reason: (r && r.reason) || 'no-result' };
    const sim = cosine(ref.embedding, r.embedding);
    return { ...c, ok: true, similarity: sim, same: sim >= threshold };
  });
  return { ok: true, matches };
}

module.exports = { embedImages, confirmAgainst, cosine, isSameFace, SAME_FACE_THRESHOLD, VENV_PY, RUNNER };
