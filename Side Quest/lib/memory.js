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
async function store({ kind = 'note', content, source = null, importance = 0.5, links = null }) {
  if (!content || !String(content).trim()) return null;
  let embStr = null;
  try { embStr = JSON.stringify(await embed(content)); } catch (e) { console.error('[memory] embed failed:', e.message); }
  return db.insertKnowledge({ kind, content: String(content).trim(), embedding: embStr, source, importance, links });
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
  embed, store, logAction, retrieve, formatForPrompt, warm, isReady,
  cosine, fuse  // exported for unit tests
};
