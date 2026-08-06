/**
 * Vision — two-way image capability for Zoe.
 *
 *  IN  (see):      describe(image) → a vision model returns what's in the image. Cloud-first
 *                  (Ollama cloud, if it hosts a vision model), automatic LOCAL fallback (Ollama can
 *                  run llava / llama3.2-vision / qwen2.5-vl on the GPU). Same Ollama image API both
 *                  ways — only base+model differ. Model + tier are db-meta configurable so the right
 *                  name can be set once we confirm what the cloud account exposes.
 *  OUT (create):   generate(prompt) → an image. LIVE (2026-08-04): default provider is LOCAL ComfyUI
 *                  (SDXL on the GPU, on-device, no key, no cost) — ZOE_IMAGE_GEN_ENABLED=1 is set and the
 *                  ComfyUI server is app-supervised. Ollama can't generate images; the cloud OpenAI path
 *                  (gpt-image-1) is a fallback only. Supports text-to-image AND image-to-image (initImage).
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
  return process.env.VISION_MODEL || 'gemma4:31b-cloud';   // configurable via model.vision meta; the hardcoded fallback must be a model that ACTUALLY EXISTS on the cloud AND carry the -cloud/:cloud SUFFIX (a bare name is looked up LOCALLY and 404s if not installed — 'gemma4:31b' without the suffix hit exactly this, and 'qwen2.5vl' 404'd, both silently killing vision when the meta was absent). gemma4:31b-cloud is live-verified (10/10 on the OCR probe). Live db-meta model.vision points at the frontier model (minimax-m3:cloud after gemini-3-flash-preview retired).
}
function visionTier() { try { return db.getMeta('vision.tier') || 'auto'; } catch { return 'auto'; } }
// A dedicated, top-tier model for a specific vision PURPOSE (e.g. 'excavate' — forensic browsing needs the
// best vision+logic we can get, and shouldn't share screen-see's model). Falls back to the global vision
// model/tier when no purpose-specific override is set. Returns { model, tier }.
function visionModelFor(purpose) {
  let model = null, tier = null;
  try { model = db.getMeta(`model.vision.${purpose}`) || null; } catch {}
  try { tier = db.getMeta(`vision.tier.${purpose}`) || null; } catch {}
  return { model: model || visionModel(), tier: tier || visionTier() };
}
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
    // CLOUD tier: window sized to the model — an image alone can be thousands of tokens, so 8192
    // could truncate prompt+image silently. LOCAL keeps 8192 (the warm-load rule). Fail-safe: 8192.
    let numCtx = 8192;
    if (src.tier === 'cloud') { try { numCtx = (await require('./cloud_window').resolve({ model: m, base: src.base, token: src.token })).num_ctx; } catch {} }
    const text = await call({ model: m, messages, base: src.base, headers: src.token ? { Authorization: `Bearer ${src.token}` } : {}, options: { temperature: 0.2, num_ctx: numCtx }, timeoutMs: 120000 });
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

// ---- LOCAL provider: ComfyUI (SDXL/FLUX on the GPU, 100% on-device) --------------------------------
// Talks to a local ComfyUI server (default 127.0.0.1:8188). Builds a standard SDXL API graph, submits it,
// polls /history for the result, and fetches the PNG via /view → base64. Supports text-to-image AND
// image-to-image ("take this image and do X" — initImage is uploaded, denoise < 1 preserves structure).
// Nothing leaves the machine: prompt, source image, and output all stay local.
function comfyBase() { return String(process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/+$/, ''); }
function comfyCheckpoint() {
  try { const m = db.getMeta('image.checkpoint'); if (m) return m; } catch {}
  return process.env.COMFYUI_CKPT || 'sd_xl_base_1.0.safetensors';
}
// provider: db meta image.provider → env ZOE_IMAGE_PROVIDER → default 'comfyui' (local). 'openai' forces cloud.
function imageProvider() {
  let p = null; try { p = db.getMeta('image.provider'); } catch {}
  return String(p || process.env.ZOE_IMAGE_PROVIDER || 'comfyui').toLowerCase();
}
function _parseSize(size) {
  const m = String(size || '1024x1024').match(/(\d+)\s*[x×]\s*(\d+)/);
  let w = m ? parseInt(m[1], 10) : 1024, h = m ? parseInt(m[2], 10) : 1024;
  // clamp to sane SDXL bounds (multiples of 8)
  w = Math.max(512, Math.min(1536, Math.round(w / 8) * 8));
  h = Math.max(512, Math.min(1536, Math.round(h / 8) * 8));
  return [w, h];
}
// Standard SDXL ComfyUI API graph. initImageName set → image-to-image (LoadImage→VAEEncode, denoise<1).
function _sdxlWorkflow({ prompt, negative, width, height, steps, cfg, seed, ckpt, initImageName, denoise }) {
  const g = {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: negative || 'lowres, blurry, watermark, text, deformed', clip: ['4', 1] } },
    '3': { class_type: 'KSampler', inputs: { seed, steps, cfg, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: initImageName ? (denoise == null ? 0.6 : denoise) : 1.0, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'zoe', images: ['8', 0] } },
  };
  if (initImageName) {
    g['10'] = { class_type: 'LoadImage', inputs: { image: initImageName } };
    g['5'] = { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } };
  } else {
    g['5'] = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
  }
  return g;
}
// Upload a base64/dataURI image to ComfyUI's input dir (for image-to-image). Returns the stored filename.
async function _comfyUpload(base64, name) {
  const base = comfyBase();
  const buf = Buffer.from(_stripDataUrl(base64), 'base64');
  const fd = new FormData();
  fd.append('image', new Blob([buf], { type: 'image/png' }), name);
  fd.append('overwrite', 'true');
  const r = await fetch(`${base}/upload/image`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`comfy /upload HTTP ${r.status}`);
  const j = await r.json();
  return j.name || name;
}
async function _comfyGenerate(prompt, { negative = null, size = '1024x1024', initImage = null, denoise = null, steps = 28, cfg = 7.0, seed = null, nowTs = null, timeoutMs = 240000 } = {}) {
  const base = comfyBase();
  const [width, height] = _parseSize(size);
  let initImageName = null;
  if (initImage) initImageName = await _comfyUpload(initImage, `zoe_init_${nowTs || Date.now()}.png`);
  const useSeed = (seed == null) ? Math.floor(Math.random() * 1e15) : seed;
  const workflow = _sdxlWorkflow({ prompt, negative, width, height, steps, cfg, seed: useSeed, ckpt: comfyCheckpoint(), initImageName, denoise });
  const client_id = `zoe_${nowTs || Date.now()}`;
  const sub = await fetch(`${base}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id }) });
  if (!sub.ok) throw new Error(`comfy /prompt HTTP ${sub.status}: ${(await sub.text().catch(() => '')).slice(0, 200)}`);
  const { prompt_id } = await sub.json();
  if (!prompt_id) throw new Error('comfy returned no prompt_id');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((s) => setTimeout(s, 1500));
    let entry = null;
    try { const h = await (await fetch(`${base}/history/${prompt_id}`)).json(); entry = h && h[prompt_id]; } catch {}
    if (!entry) continue;
    if (entry.status && entry.status.status_str === 'error') throw new Error('comfy execution error (check the workflow / VRAM)');
    const outs = entry.outputs || {};
    for (const nid of Object.keys(outs)) {
      const imgs = outs[nid].images;
      if (imgs && imgs.length) {
        const im = imgs[0];
        const q = `filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || '')}&type=${encodeURIComponent(im.type || 'output')}`;
        const buf = await (await fetch(`${base}/view?${q}`)).arrayBuffer();
        return Buffer.from(buf).toString('base64');
      }
    }
  }
  throw new Error(`comfy generation timed out after ${Math.round(timeoutMs / 1000)}s`);
}
// Is a local ComfyUI reachable right now? (used to fail-fast with a clear message)
async function comfyReachable() {
  try { const r = await fetch(`${comfyBase()}/system_stats`, { signal: AbortSignal.timeout(2500) }); return r.ok; } catch { return false; }
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
// Provider: LOCAL ComfyUI (default, on-device SDXL/FLUX) or cloud OpenAI. Supports image-to-image via
// `initImage` (base64/dataURI) + `denoise` (<1 keeps structure) — the "take this image and do X" path.
async function generate({ prompt, genFn = null, saveFn = null, size = '1024x1024', negative = null, initImage = null, denoise = null, nowTs = null } = {}) {
  const p = String(prompt || '').trim();
  if (!p) return { ok: false, reason: 'empty prompt' };
  let b64;
  if (genFn) {
    try { b64 = await genFn(p); } catch (e) { return { ok: false, reason: `image generation failed: ${e.message}` }; }
  } else {
    if (!generationEnabled()) return { ok: false, disabled: true, reason: 'image generation is OFF by design — set ZOE_IMAGE_GEN_ENABLED=1 to enable it' };
    const provider = imageProvider();
    if (provider === 'comfyui') {
      if (!(await comfyReachable())) return { ok: false, disabled: true, reason: `local image server (ComfyUI) isn't reachable at ${comfyBase()} — it may still be starting` };
      try { b64 = await _comfyGenerate(p, { negative, size, initImage, denoise, nowTs }); }
      catch (e) { return { ok: false, reason: `local image gen (ComfyUI) failed: ${e.message}` }; }
    } else {
      const apiKey = process.env.OPENAI_API_KEY || process.env.IMAGE_API_KEY;
      if (!apiKey) return { ok: false, disabled: true, reason: 'cloud image provider selected but no key (set OPENAI_API_KEY/IMAGE_API_KEY, or set image.provider=comfyui for local)' };
      try { b64 = await _openaiGenerate(p, { apiKey, size }); } catch (e) { return { ok: false, reason: `image generation failed: ${e.message}` }; }
    }
  }
  if (!b64) return { ok: false, reason: 'no image produced' };
  const save = saveFn || _saveToWorkspace;
  try { const filePath = await save(b64, nowTs); return { ok: true, path: filePath, base64: b64 }; }
  catch (e) { return { ok: true, base64: b64, reason: `image produced but save failed: ${e.message}` }; }
}

module.exports = {
  describe, generate, parseGenTags, stripGenTags,
  visionModel, visionTier, visionModelFor, generationEnabled,
  imageProvider, comfyBase, comfyReachable, comfyCheckpoint,
  GEN_TAG_RE, DEFAULT_VISION_PROMPT, _stripDataUrl, _pickSource
};
