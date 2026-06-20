/**
 * Knowledge / learning layer for Zoe — the "does she retain + retrieve" engine.
 *
 * Design (settled 2026-06-19, see project memory):
 *  - REFERENCE-NOT-COPY: stores short synthesized notes / references / action
 *    trajectories — never copies of source corpora (Echo stays system-of-record).
 *  - Hybrid retrieval: semantic (bge-small CPU embeddings via transformers.js WASM,
 *    JS cosine) + keyword (FTS5 BM25), fused with reciprocal-rank fusion. K small.
 *  - Pure Node: better-sqlite3 + FTS5 + a WASM embedder. No native extension, no
 *    VRAM (embedder runs on CPU, doesn't contend with the chat model).
 *  - Action-memory: logAction() records what she DID so she's not blind to her own
 *    past actions (the "didn't know she already sent the email" failure).
 *
 * The embedder is lazy-loaded once (first call ~1s incl. model load; ~4ms/embed after).
 */

const db = require('./db');

const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
const MAX_EMBED_CHARS = 2000;

let _extractor = null;
let _loading = null;

async function getExtractor() {
  if (_extractor) return _extractor;
  if (_loading) return _loading;
  _loading = (async () => {
    const { pipeline, env } = await import('@xenova/transformers');
    // Cache models under the app's data dir; allow first-run download.
    // DB_PATH is a FILE path, so resolve its directory before joining 'models'.
    try { const path = require('path'); env.cacheDir = path.join(path.dirname(db.DB_PATH), 'models'); } catch {}
    _extractor = await pipeline('feature-extraction', EMBED_MODEL);
    return _extractor;
  })();
  return _loading;
}

async function embed(text) {
  const ex = await getExtractor();
  const out = await ex(String(text == null ? '' : text).slice(0, MAX_EMBED_CHARS), { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

// Embeddings are L2-normalized → dot product IS cosine similarity.
// Guard mismatched lengths: these are 384-dim normalized vectors, so unequal
// lengths mean corrupt/foreign data — return 0 rather than silently truncating
// to the shorter length (which would compare misaligned dimensions).
function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

// Reciprocal-rank fusion of two ranked id-lists. Robust, scale-free, no score
// normalization needed. Returns ids sorted by fused score.
function fuse(semIds, ftsIds, k = 4, C = 60) {
  const score = new Map();
  semIds.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (C + i)));
  ftsIds.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (C + i)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
}

/** Store a piece of knowledge. content should be SHORT synthesis/reference, not a copy. */
async function store({ kind = 'note', content, source = null, importance = 0.5, links = null, embedText = null, provenance = null }) {
  if (!content || !String(content).trim()) return null;
  // embedText lets the caller embed something OTHER than the readable content —
  // e.g. a focus_tombstone stores a readable "Focus \"X\" → resolved: reason" note
  // but should embed the BARE goal X, so the spawn-gate's bare-goal cosine isn't
  // diluted by the wrapper (the dilution pushed real theme-matches under threshold).
  // provenance = reference-not-copy marker(s) for where the raw source data lives.
  let embStr = null;
  try { embStr = JSON.stringify(await embed(embedText || content)); } catch (e) { console.error('[memory] embed failed:', e.message); }
  return db.insertKnowledge({ kind, content: String(content).trim(), embedding: embStr, source, importance, links, provenance });
}

/** Log an action she took, as retrievable memory (kills "didn't know she did X"). */
async function logAction(text, { source = 'action' } = {}) {
  return store({ kind: 'trajectory', content: text, source, importance: 0.7 });
}

/**
 * Hybrid retrieve: top-K knowledge rows by semantic + keyword fusion.
 * Graceful: returns [] on empty query or no store (caller injects nothing → the
 * gap-response reflex handles "I don't know" rather than getting noise).
 */
async function retrieve(query, { k = 4, kinds = null } = {}) {
  if (!query || !String(query).trim()) return [];
  let qv;
  try { qv = await embed(query); } catch { qv = null; }

  // Semantic over all stored embeddings (small N; ms).
  let semIds = [];
  if (qv) {
    const all = db.getAllKnowledgeEmbeddings();
    const scored = [];
    for (const r of all) {
      if (kinds && !kinds.includes(r.kind)) continue;
      let v; try { v = JSON.parse(r.embedding); } catch { continue; }
      scored.push([r.id, cosine(qv, v)]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    semIds = scored.slice(0, k * 3).map(([id]) => id);
  }

  // Keyword
  const ftsIds = db.ftsSearchKnowledge(query, k * 3).map(r => r.id);

  const fusedIds = fuse(semIds, ftsIds, k);
  if (fusedIds.length === 0) return [];

  const rows = db.getKnowledgeByIds(fusedIds);
  const byId = new Map(rows.map(r => [r.id, r]));
  const result = fusedIds.map(id => byId.get(id)).filter(Boolean);
  for (const r of result) { try { db.touchKnowledge(r.id); } catch {} }
  return result;
}

// Min-max normalize a Map's values into [0,1]. Zero range (all equal, incl. a
// single item) → 0.5 for every key, matching Generative Agents' normalize_dict.
function _normalize(map) {
  const vals = [...map.values()];
  if (vals.length === 0) return map;
  const min = Math.min(...vals), max = Math.max(...vals), range = max - min;
  const out = new Map();
  for (const [k, v] of map) out.set(k, range === 0 ? 0.5 : (v - min) / range);
  return out;
}

/**
 * Generative-Agents retrieval: score every candidate by a weighted sum of
 * recency × relevance × importance (each min-max normalized to [0,1] first), and
 * return the top-K. This replaces pure-recency / pure-RRF ordering so high-signal
 * memories outrank idle noticing.
 *
 *   recency    = decayPerHour ^ hours-since-last-touched (exponential)
 *   relevance  = cosine(query, memory) over bge-small embeddings
 *   importance = stored 1–10 poignancy (knowledge.importance; null → neutral)
 *
 * Effective weights mirror the paper (relevance dominates): recency 0.5,
 * relevance 3, importance 2. Falls back gracefully: no query embedding → relevance
 * drops out and ranking is recency+importance.
 */
async function retrieveScored(query, { k = 4, kinds = null, weights = { recency: 0.5, relevance: 3, importance: 2 }, decayPerHour = 0.99 } = {}) {
  const rows = db.getAllKnowledgeEmbeddings();
  if (!rows || rows.length === 0) return [];

  let qv = null;
  if (query && String(query).trim()) { try { qv = await embed(query); } catch { qv = null; } }

  const now = Date.now();
  const recency = new Map(), relevance = new Map(), importance = new Map();
  for (const r of rows) {
    if (kinds && !kinds.includes(r.kind)) continue;
    const last = r.last_used_ts || r.created_ts || now;
    const hours = Math.max(0, (now - last) / 3600000);
    recency.set(r.id, Math.pow(decayPerHour, hours));
    let rel = 0;
    if (qv) { try { rel = cosine(qv, JSON.parse(r.embedding)); } catch { rel = 0; } }
    relevance.set(r.id, rel);
    // knowledge.importance is stored 0..1 (legacy) OR 1..10 (poignancy). Normalize
    // either onto a common axis: >1 means a 1–10 score, divide by 10.
    let imp = r.importance == null ? 0.5 : r.importance;
    if (imp > 1) imp = imp / 10;
    importance.set(r.id, imp);
  }
  if (recency.size === 0) return [];

  const recN = _normalize(recency), relN = _normalize(relevance), impN = _normalize(importance);
  const scored = [];
  for (const id of recN.keys()) {
    const s = weights.recency * recN.get(id) + weights.relevance * relN.get(id) + weights.importance * impN.get(id);
    scored.push([id, s]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const topIds = scored.slice(0, k).map(([id]) => id);

  const fetched = db.getKnowledgeByIds(topIds);
  const byId = new Map(fetched.map(r => [r.id, r]));
  const result = topIds.map(id => byId.get(id)).filter(Boolean);
  for (const r of result) { try { db.touchKnowledge(r.id); } catch {} }
  return result;
}

/** Format retrieved knowledge for prompt injection (the RETRIEVED tail). */
function formatForPrompt(rows, userName = 'them') {
  if (!rows || rows.length === 0) return null;
  const lines = [`From your knowledge — things you've learned or done before that may bear on this (you retrieved these by relevance, not ${userName}):`];
  for (const r of rows) {
    const tag = r.kind === 'trajectory' ? '[did]' : r.kind === 'reference' ? '[ref]' : '[note]';
    lines.push(`  ${tag} ${(r.content || '').slice(0, 400)}`);
  }
  return lines.join('\n');
}

function isReady() { return !!_extractor; }
// Warm the embedder at boot so first retrieval isn't slow.
function warm() { return getExtractor().then(() => true).catch(() => false); }

module.exports = {
  embed, store, logAction, retrieve, retrieveScored, formatForPrompt, warm, isReady,
  cosine, fuse, _normalize  // exported for unit tests
};
