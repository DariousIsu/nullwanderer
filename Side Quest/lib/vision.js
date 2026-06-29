/**
 * Vision — two-way image capability for Zoe.
 *
 *  IN  (see):      describe(image) → a vision model returns what's in the image. Cloud-first
 *                  (Ollama cloud, if it hosts a vision model), automatic LOCAL fallback (Ollama can
 *                  run llava / llama3.2-vision / qwen2.5-vl on the GPU). Same Ollama image API both
 *                  ways — only base+model differ. Model + tier are db-meta configurable so the right
 *                  name can be set once we confirm what the cloud account exposes.
 *  OUT (create):   generate(prompt) → an image. Ollama CANNOT generate images, so this uses a paid
 *                  image API (OpenAI gpt-image-1 by default). KILL-SWITCHED OFF by default (like the
 *                  email send-gate) — enabled only with ZOE_IMAGE_GEN_ENABLED=1 + a provider key.
 *
 * Every external call is dep-injectable and fail-safe (returns {ok:false,reason}, never throws into
 * a turn), so the deterministic logic is fully smoke-testable offline.
 */

const { complete } = require('./ollama');
const models = require('./models');
const db = require('./db');

// ---- config ----
function visionModel() {
  try { const m = db.getMeta('model.vision'); if (m) return m; } catch {}
  return process.env.VISION_MODEL || 'qwen2.5vl';   // configurable; set model.vision once verified
}
function visionTier() { try { return db.getMeta('vision.tier') || 'auto'; } catch { return 'auto'; } }
function generationEnabled() { return process.env.ZOE_IMAGE_GEN_ENABLED === '1'; }

function _stripDataUrl(b64) { return String(b64 || '').replace(/^data:[^;]+;base64,/, '').trim(); }

// auto: cloud if a key is present, else local. Explicit 'cloud'/'local' force a tier.
function _pickSource(tier) {
  const srcs = models.sources() || [];
  const cloud = srcs.find(s => s.tier === 'cloud' && s.token);
  const local = srcs.find(s => s.tier === 'local');
  if (tier === 'cloud') return cloud || null;
  if (tier === 'local') return local || null;
  return cloud || local || null;
}

// ---- IN: see an image ----
const DEFAULT_VISION_PROMPT = 'Look closely at this image and describe exactly what you see — objects, people, any text, layout, colors, and mood. Be concrete and specific; do not guess at things that are not visible.';

async function describe({ imageBase64, prompt = null, model = null, tier = null, completeFn = null, source = null } = {}) {
  const img = _stripDataUrl(imageBase64);
  if (!img) return { ok: false, reason: 'no image data' };
  const src = source || _pickSource(tier || visionTier());
  if (!src) return { ok: false, reason: 'no model source available' };
  const m = model || visionModel();
  const messages = [{ role: 'user', content: prompt || DEFAULT_VISION_PROMPT, images: [img] }];
  const call = completeFn || complete;
  try {
    const text = await call({ model: m, messages, base: src.base, headers: src.token ? { Authorization: `Bearer ${src.token}` } : {}, options: { temperature: 0.2, num_ctx: 8192 }, timeoutMs: 120000 });
    const out = (text || '').trim();
    if (!out) return { ok: false, reason: `vision model '${m}' returned nothing (is it available on the ${src.tier} tier?)`, model: m, tier: src.tier };
    return { ok: true, text: out, model: m, tier: src.tier };
  } catch (e) {
    return { ok: false, reason: `vision call failed (${m} @ ${src.tier}): ${e.message}`, model: m, tier: src.tier };
  }
}

// ---- OUT: create an image ----
const GEN_TAG_RE = /<(?:image-gen|draw|imagine)>([\s\S]*?)<\/(?:image-gen|draw|imagine)>/gi;
function parseGenTags(text) {
  const out = []; let m; GEN_TAG_RE.lastIndex = 0;
  while ((m = GEN_TAG_RE.exec(text || '')) !== null) { const p = (m[1] || '').trim(); if (p) out.push(p); }
  return out;
}
function stripGenTags(text) { return String(text || '').replace(GEN_TAG_RE, '').replace(/[ \t]+/g, ' ').trim(); }

// Default provider: OpenAI Images (gpt-image-1). Pluggable via genFn.
async function _openaiGenerate(prompt, { apiKey, size }) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gpt-image-1', prompt, size: size || '1024x1024', n: 1 })
  });
  if (!res.ok) throw new Error(`image API HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json();
  const b64 = j && j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error('image API returned no image');
  return b64;
}

function _saveToWorkspace(b64, nowTs) {
  const fs = require('fs'), path = require('path');
  const dir = path.join(process.cwd(), 'data', 'zoe_workspace', 'images');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const file = path.join(dir, `gen_${nowTs || Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

// generate → { ok, path, base64 } | { ok:false, disabled?, reason }. genFn/saveFn injectable.
async function generate({ prompt, genFn = null, saveFn = null, size = '1024x1024', nowTs = null } = {}) {
  const p = String(prompt || '').trim();
  if (!p) return { ok: false, reason: 'empty prompt' };
  const apiKey = process.env.OPENAI_API_KEY || process.env.IMAGE_API_KEY;
  if (!genFn) {
    if (!generationEnabled()) return { ok: false, disabled: true, reason: 'image generation is OFF by design — set ZOE_IMAGE_GEN_ENABLED=1 and an image-provider API key to enable it' };
    if (!apiKey) return { ok: false, disabled: true, reason: 'image generation enabled but no provider key (set OPENAI_API_KEY or IMAGE_API_KEY)' };
  }
  let b64;
  try { b64 = genFn ? await genFn(p) : await _openaiGenerate(p, { apiKey, size }); }
  catch (e) { return { ok: false, reason: `image generation failed: ${e.message}` }; }
  if (!b64) return { ok: false, reason: 'no image produced' };
  const save = saveFn || _saveToWorkspace;
  try { const filePath = await save(b64, nowTs); return { ok: true, path: filePath, base64: b64 }; }
  catch (e) { return { ok: true, base64: b64, reason: `image produced but save failed: ${e.message}` }; }
}

module.exports = {
  describe, generate, parseGenTags, stripGenTags,
  visionModel, visionTier, generationEnabled,
  GEN_TAG_RE, DEFAULT_VISION_PROMPT, _stripDataUrl, _pickSource
};
