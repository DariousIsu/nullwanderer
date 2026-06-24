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
 * SOURCES: two Ollama-protocol endpoints, merged + tier-tagged —
 *   - LOCAL  : OLLAMA_BASE (localhost) — Zoe's 24B + small models
 *   - CLOUD  : OLLAMA_CLOUD_BASE (+ OLLAMA_CLOUD_KEY bearer) — frontier models
 * Cloud is the priority tier for verification-class workspaces (Lucas); local
 * is the secondary subset. Cloud source is OPTIONAL — absent env → local only,
 * no error. Endpoints/keys come from env (never hardcoded model names or creds).
 *
 * The cloud key resolution mirrors Echo's gateway: it also accepts OLLAMA_API_KEY
 * (Echo's canonical secret-injection var, host https://ollama.com), and defaults
 * the base to ollama.com when a key is present. So injecting the key the standard
 * way (env / OS keychain — same as Echo) lights up Zoe's cloud listing with NO
 * code or secret-in-file change. NOTE: the editorial/cert path (lib/editor_checks)
 * runs cloud THROUGH the owned engine's gateway (which already authenticates via
 * Echo's keystore) and needs no Zoe-side key at all; this var only powers Zoe's
 * own direct model-selector listing.
 */
const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434';
const PREF_PREFIX = 'model.';            // db meta key = `model.<workspace>`
const CONTEXT_TTL_MS = 10 * 60 * 1000;   // cache /api/show context lookups
const _ctxCache = new Map();             // `${base}::${name}` -> { ctx, at }

// The configured model sources, in display priority (cloud frontier first).
function sources() {
  const out = [];
  // Cloud bearer: prefer the explicit OLLAMA_CLOUD_KEY, else Echo's canonical OLLAMA_API_KEY.
  const cloudKey = process.env.OLLAMA_CLOUD_KEY || process.env.OLLAMA_API_KEY || null;
  // Base: explicit OLLAMA_CLOUD_BASE, else default to Ollama Cloud (ollama.com) when a key exists.
  const cloudBase = process.env.OLLAMA_CLOUD_BASE || (cloudKey ? 'https://ollama.com' : null);
  if (cloudBase) out.push({ tier: 'cloud', base: cloudBase, token: cloudKey });
  out.push({ tier: 'local', base: OLLAMA_BASE, token: null });
  return out;
}

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

// Order a merged model list for the selector: configured tier priority first
// (cloud before local), then largest context, then name. Stable, pure.
const TIER_RANK = { cloud: 0, local: 1 };
function orderForSelector(models) {
  return (models || []).slice().sort((a, b) => {
    const ta = TIER_RANK[a.tier] ?? 9, tb = TIER_RANK[b.tier] ?? 9;
    if (ta !== tb) return ta - tb;
    const ca = a.contextLength || 0, cb = b.contextLength || 0;
    if (ca !== cb) return cb - ca;
    return String(a.name).localeCompare(String(b.name));
  });
}

// Pick the best default for a workspace: meets an optional context floor; if
// preferTier is set, a model of that tier wins over any other tier regardless
// of context (verification → preferTier:'cloud'). Within the chosen set, the
// largest context wins; ties keep list order. Returns the model name or null.
function pickDefault(modelsWithCtx, { minContext = 0, preferTier = null } = {}) {
  let eligible = (modelsWithCtx || []).filter(m =>
    m && m.name && (minContext ? (m.contextLength || 0) >= minContext : true));
  if (!eligible.length) return null;
  if (preferTier && eligible.some(m => m.tier === preferTier)) {
    eligible = eligible.filter(m => m.tier === preferTier);
  }
  let best = eligible[0];
  for (const m of eligible) {
    if ((m.contextLength || 0) > (best.contextLength || 0)) best = m;
  }
  return best.name;
}

// ---- I/O: query the live Ollama daemon -----------------------------------

async function _fetchJson(url, { token = null, ...opts } = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const res = await fetch(url, { ...opts, headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// List models from one source, tier/source-tagged. [] if that endpoint is down.
async function listFromSource(src) {
  try {
    const tags = parseTags(await _fetchJson(`${src.base}/api/tags`, { token: src.token }));
    return tags.map(m => ({ ...m, tier: src.tier, base: src.base }));
  } catch {
    return [];
  }
}

// Local-only list (back-compat; the 24B/small pool).
async function listModels() {
  return listFromSource({ tier: 'local', base: OLLAMA_BASE, token: null });
}

// Context length for one model on a given base (cached). Null if unknown/down.
async function modelContext(name, base = OLLAMA_BASE, token = null) {
  if (!name) return null;
  const key = `${base}::${name}`;
  const hit = _ctxCache.get(key);
  if (hit && (Date.now() - hit.at) < CONTEXT_TTL_MS) return hit.ctx;
  let ctx = null;
  try {
    const show = await _fetchJson(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      token,
      body: JSON.stringify({ model: name }),
    });
    ctx = parseContextLength(show);
  } catch {
    ctx = null;
  }
  _ctxCache.set(key, { ctx, at: Date.now() });
  return ctx;
}

// Full merged list (all sources) with context lengths, ordered for the selector
// (cloud frontier first, then by context desc). What the selector tab renders.
async function listModelsDetailed() {
  const srcs = sources();
  const lists = await Promise.all(srcs.map(listFromSource));
  const merged = lists.flat();
  await Promise.all(merged.map(async m => {
    m.contextLength = await modelContext(m.name, m.base, srcs.find(s => s.base === m.base)?.token || null);
  }));
  return orderForSelector(merged);
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
  listFromSource,
  modelContext,
  listModelsDetailed,
  sources,
  getModelFor,
  setModelFor,
  clearModelFor,
  // pure helpers (exported for the smoke)
  parseTags,
  parseContextLength,
  pickDefault,
  orderForSelector,
  prefKey,
  OLLAMA_BASE,
};
