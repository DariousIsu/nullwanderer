/**
 * models — available-model discovery + per-workspace model preference.
 *
 * Shared infrastructure for every workbench: instead of hardcoding a model name
 * (the stale `cloud_model = "…llama-3.1-70b…"` pattern), each workspace picks
 * from whatever Ollama actually serves, and the choice persists. Different
 * workspaces have different needs — the Editor's verification context balloons,
 * so it wants a high-context model; chat/monologue stay on the local 24B.
 *
 * Pure parsing/selection helpers are separated from I/O so they're unit-testable
 * offline (smoke_models.js); the preference store is a thin layer over db meta.
 *
 * NB: this lists Zoe's LOCAL Ollama pool (/api/tags). The cloud-tier pool
 * (Echo's gateway / Ollama Cloud) is merged in at the Editor-wiring step — this
 * module stays the local-discovery + preference core.
 */
const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434';
const PREF_PREFIX = 'model.';            // db meta key = `model.<workspace>`
const CONTEXT_TTL_MS = 10 * 60 * 1000;   // cache /api/show context lookups
const _ctxCache = new Map();             // name -> { ctx, at }

// ---- pure helpers (no I/O — unit-tested) --------------------------------

function prefKey(workspace) {
  return PREF_PREFIX + String(workspace || '').trim().toLowerCase();
}

// /api/tags -> normalized [{ name, sizeGB, paramSize, quant, family }]
function parseTags(json) {
  const models = (json && Array.isArray(json.models)) ? json.models : [];
  return models.map(m => {
    const d = m.details || {};
    return {
      name: m.name,
      sizeGB: m.size ? +(m.size / 1e9).toFixed(1) : null,
      paramSize: d.parameter_size || null,
      quant: d.quantization_level || null,
      family: d.family || null,
    };
  }).filter(m => m.name);
}

// /api/show -> max context length. The field is arch-prefixed in model_info
// (e.g. "llama.context_length", "qwen2.context_length"); find any *.context_length.
function parseContextLength(showJson) {
  const info = (showJson && showJson.model_info) || {};
  for (const [k, v] of Object.entries(info)) {
    if (k.endsWith('.context_length') && Number.isFinite(+v)) return +v;
  }
  // some builds expose it under parameters as "num_ctx"
  const params = (showJson && showJson.parameters) || '';
  const m = typeof params === 'string' && params.match(/num_ctx\s+(\d+)/);
  if (m) return +m[1];
  return null;
}

// Pick the best default for a workspace: the largest-context model meeting an
// optional floor. Ties keep list order (stable). Returns the model name or null.
function pickDefault(modelsWithCtx, { minContext = 0 } = {}) {
  const eligible = (modelsWithCtx || []).filter(m =>
    m && m.name && (minContext ? (m.contextLength || 0) >= minContext : true));
  if (!eligible.length) return null;
  let best = eligible[0];
  for (const m of eligible) {
    if ((m.contextLength || 0) > (best.contextLength || 0)) best = m;
  }
  return best.name;
}

// ---- I/O: query the live Ollama daemon -----------------------------------

async function _fetchJson(url, opts = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// List installed models (names + sizes). Returns [] if Ollama is down.
async function listModels() {
  try {
    return parseTags(await _fetchJson(`${OLLAMA_BASE}/api/tags`));
  } catch {
    return [];
  }
}

// Context length for one model (cached). Null if unknown / Ollama down.
async function modelContext(name) {
  if (!name) return null;
  const hit = _ctxCache.get(name);
  if (hit && (Date.now() - hit.at) < CONTEXT_TTL_MS) return hit.ctx;
  let ctx = null;
  try {
    const show = await _fetchJson(`${OLLAMA_BASE}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
    });
    ctx = parseContextLength(show);
  } catch {
    ctx = null;
  }
  _ctxCache.set(name, { ctx, at: Date.now() });
  return ctx;
}

// Full list with context lengths — what the selector tab renders.
async function listModelsDetailed() {
  const models = await listModels();
  await Promise.all(models.map(async m => { m.contextLength = await modelContext(m.name); }));
  return models;
}

// ---- per-workspace preference (db meta) ----------------------------------

// Stored model for a workspace, or `fallback` if none set. NO hardcoded default
// here — callers pass a sensible fallback (or resolve one via pickDefault).
function getModelFor(workspace, fallback = null) {
  try {
    const v = require('./db').getMeta(prefKey(workspace));
    return (v && v.trim()) ? v : fallback;
  } catch {
    return fallback;
  }
}

function setModelFor(workspace, name) {
  require('./db').setMeta(prefKey(workspace), String(name || ''));
  return getModelFor(workspace);
}

function clearModelFor(workspace) {
  try { require('./db').setMeta(prefKey(workspace), ''); } catch {}
}

module.exports = {
  listModels,
  modelContext,
  listModelsDetailed,
  getModelFor,
  setModelFor,
  clearModelFor,
  // pure helpers (exported for the smoke)
  parseTags,
  parseContextLength,
  pickDefault,
  prefKey,
  OLLAMA_BASE,
};
