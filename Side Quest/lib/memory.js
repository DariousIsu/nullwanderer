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

// Embeddings are DETERMINISTIC for a given (text, model), and the WASM extractor runs IN-PROCESS on the
// MAIN THREAD — each ex() call blocks the event loop for its whole compute. Hot callers re-embed the SAME
// strings constantly (the heartbeat's self-repeat guard alone embeds recentThoughts/recentSaids ~3×/tick,
// and those sets overlap tick-to-tick), which measured as a recurring 2-3s main-thread stall (2026-08-04,
// idle CPU — not starvation, pure redundant compute). A bounded LRU cache keyed by the exact embedded text
// eliminates the redundant WASM work everywhere embed() is called. Safe because the function is pure.
const _EMBED_CACHE = new Map();          // key(truncated text) → vector
const _EMBED_CACHE_MAX = 1024;

// OFF-THREAD EMBEDDING (2026-08-04) — the WASM pipeline runs in a WORKER (lib/embed_worker) so its compute
// never blocks the MAIN event loop. The recurring multi-second main-thread stalls were embed BURSTS in the
// decompose / heartbeat / reflection lanes (transformers.js is synchronous WASM; each embed froze the loop
// 40-60ms, and 40+/burst = seconds of frozen typing/IPC/Echo-heartbeat). Now embed() posts the truncated
// text to the worker and awaits a small vector; the LRU cache above short-circuits repeats with no round-trip.
// If the worker can't spawn or errors, we fall back to the ORIGINAL in-process path — embeddings never break;
// this only changes WHERE the compute happens.
const _worker = require('worker_threads');
let _embWorker = null, _embSeq = 0, _embWorkerDead = false;
const _embPending = new Map();

function _getEmbWorker() {
  if (_embWorkerDead) return null;
  if (_embWorker) return _embWorker;
  try {
    const path = require('path');
    const cacheDir = path.join(path.dirname(db.DB_PATH), 'models');
    const w = new _worker.Worker(path.join(__dirname, 'embed_worker.js'), { workerData: { cacheDir, model: EMBED_MODEL } });
    w.on('message', (m) => { const p = _embPending.get(m && m.id); if (!p) return; _embPending.delete(m.id); if (m.error) p.reject(new Error(m.error)); else p.resolve(m.vector); });
    w.on('error', (e) => { _embWorkerDead = true; _embWorker = null; for (const p of _embPending.values()) { try { p.reject(e); } catch {} } _embPending.clear(); console.error('[embed] worker error → in-process fallback:', e && e.message); });
    w.on('exit', () => { _embWorker = null; });
    // SMOKE KEEP-ALIVE (2026-08-12 gate-audit wave 3c): in a bare electron-as-node smoke shell the
    // unref()'d worker is the ONLY thing on the event loop during `await embed(...)` — the loop
    // empties mid-await and the process exits 0 SILENTLY (measured: smoke_episodic_recall printed
    // NOTHING; smoke_lanes died mid-suite at its first embed). ZOE_EMBED_REF=1 (set by those
    // suites) keeps the worker ref'd so the REAL embedder is testable — far better than stubbing
    // the very organ under test. The app never sets it, so runtime behavior is unchanged.
    if (process.env.ZOE_EMBED_REF !== '1') w.unref();   // never keep the APP alive just for the embedder
    _embWorker = w;
  } catch (e) { _embWorkerDead = true; console.error('[embed] worker spawn failed → in-process:', e && e.message); return null; }
  return _embWorker;
}

async function _embedInProcess(key) {   // fallback = the original in-process path
  const ex = await getExtractor();
  const out = await ex(key, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

async function embed(text) {
  const key = String(text == null ? '' : text).slice(0, MAX_EMBED_CHARS);
  const hit = _EMBED_CACHE.get(key);
  if (hit) { _EMBED_CACHE.delete(key); _EMBED_CACHE.set(key, hit); return hit.slice(); }  // LRU touch; copy so callers can't mutate the cached vector
  let vec = null;
  const w = _getEmbWorker();
  if (w) {
    try {
      vec = await new Promise((resolve, reject) => {
        const id = ++_embSeq;
        _embPending.set(id, { resolve, reject });
        try { w.postMessage({ id, text: key }); } catch (e) { _embPending.delete(id); reject(e); }
      });
    } catch { vec = null; }   // worker hiccup → fall through to in-process (never break embeddings)
  }
  if (!vec) vec = await _embedInProcess(key);   // throws on total failure, matching the original contract (callers catch)
  _EMBED_CACHE.set(key, vec);
  if (_EMBED_CACHE.size > _EMBED_CACHE_MAX) { const oldest = _EMBED_CACHE.keys().next().value; _EMBED_CACHE.delete(oldest); }
  return vec.slice();
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

// ── THE VECTOR CACHE (freeze cut 11, 2026-09-03) ─────────────────────────────────────────────────
// The stall profiler's second live answer (boot_p262, a 2.1s block): `28% all · 21% Statement · 13% get ·
// 13% (garbage collector) · 9% _storeDedupedInner` — db.getAllKnowledgeEmbeddings() re-read and JSON.parsed
// ALL 7,342 embeddings (59MB of JSON, 2.8M floats) on every call, and four readers call it: the dedup bank
// (every fact), recall, scored retrieval (the CHAT path), and reflection's nearest-note link. The parsed
// vectors change only when a stored embedding is set, cleared or deleted (db.js bumps a version then);
// everything else about a row — last_used_ts drives recency — is read fresh each call from the light rows.
// New ids are fetched once, by id. Float64Array keeps the JSON doubles exactly, so every cosine is the
// same number the old path computed.
let _kv = { version: -1, vec: new Map(), fetched: 0, rebuilds: 0 };
function knowledgeVectors() {
  const light = typeof db.getKnowledgeVectorRows === 'function' && typeof db.knowledgeVectorsVersion === 'function' && typeof db.getKnowledgeEmbeddingsByIds === 'function';
  if (!light) {   // a store without the doors (a mock db in a test) → the old shape, parsed per call
    const out = [];
    for (const r of db.getAllKnowledgeEmbeddings()) { let v = null; try { v = JSON.parse(r.embedding); } catch {} if (Array.isArray(v)) out.push({ ...r, vec: v }); }
    return out;
  }
  const ver = db.knowledgeVectorsVersion();
  if (ver !== _kv.version) _kv = { version: ver, vec: new Map(), fetched: _kv.fetched, rebuilds: _kv.rebuilds + (_kv.version >= 0 ? 1 : 0) };
  const rows = db.getKnowledgeVectorRows();
  const missing = rows.filter((r) => !_kv.vec.has(r.id)).map((r) => r.id);
  if (missing.length) {
    for (const e of db.getKnowledgeEmbeddingsByIds(missing)) {
      try { const v = JSON.parse(e.embedding); if (Array.isArray(v)) { _kv.vec.set(e.id, Float64Array.from(v)); _kv.fetched++; } } catch {}
    }
  }
  const out = [];
  for (const r of rows) { const vec = _kv.vec.get(r.id); if (vec) out.push({ ...r, vec }); }
  return out;
}
function _knowledgeVectorsStats() { return { version: _kv.version, cached: _kv.vec.size, fetched: _kv.fetched, rebuilds: _kv.rebuilds }; }

// Reciprocal-rank fusion of two ranked id-lists. Robust, scale-free, no score
// normalization needed. Returns ids sorted by fused score.
function fuse(semIds, ftsIds, k = 4, C = 60) {
  const score = new Map();
  semIds.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (C + i)));
  ftsIds.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (C + i)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
}

/** Store a piece of knowledge. content should be SHORT synthesis/reference, not a copy. */
async function store({ kind = 'note', content, source = null, importance = 0.5, links = null, embedText = null, provenance = null, level = 'fact', parentId = null }) {
  if (!content || !String(content).trim()) return null;
  // embedText lets the caller embed something OTHER than the readable content —
  // e.g. a focus_tombstone stores a readable "Focus \"X\" → resolved: reason" note
  // but should embed the BARE goal X, so the spawn-gate's bare-goal cosine isn't
  // diluted by the wrapper (the dilution pushed real theme-matches under threshold).
  // provenance = reference-not-copy marker(s) for where the raw source data lives.
  let embStr = null;
  try { embStr = JSON.stringify(await embed(embedText || content)); } catch (e) { console.error('[memory] embed failed:', e.message); }
  return db.insertKnowledge({ kind, content: String(content).trim(), embedding: embStr, source, importance, links, provenance, level, parentId });
}

// Mem0-style WRITE-TIME DEDUP for the capability track. Before adding a knowledge
// note, find the semantically-nearest existing one; if an LLM confirms it states the
// same fact/procedure (a paraphrase with no new info), NOOP — touch the existing row
// instead of piling up a near-duplicate. Otherwise ADD, linked to its nearest
// neighbour. This is what keeps the store from exploding (critical once Echo's tool-
// knowledge flows in). decideFn injectable for offline tests.
// SERIALIZED (audit S30): storeDeduped reads the whole embedding store, then awaits (embed +
// relate/sameFact model calls) BEFORE inserting — so two concurrent fire-and-forget banks of the
// SAME fact (e.g. the inbox poll + the reply path both banking one inbound email) each read the
// pre-insert store and both insert a near-duplicate. open_threads was serialized for exactly this
// race; mirror its _extractChain here so same-fact banks queue instead of colliding.
let _storeChain = Promise.resolve();
async function storeDeduped(args) {
  const prev = _storeChain;
  let release;
  _storeChain = new Promise((r) => { release = r; });
  try { await prev; } catch {}
  try { return await _storeDedupedInner(args || {}); } finally { release(); }
}
async function _storeDedupedInner({ kind = 'note', content, source = null, importance = 0.5, provenance = null, prefilter = 0.82, decideFn = null, relateFn = null, mergeFn = null }) {
  const text = String(content || '').trim();
  if (text.length < 8) return { action: 'skip-empty' };
  let emb = null;
  try { emb = await embed(text); } catch {}
  let link = null;
  let parentId = null;   // Phase 3: the 'topic' this new fact sits under (nearest topic note)
  if (emb) {
    let best = null, bestSim = 0;
    let bestTopic = null, bestTopicSim = 0;
    for (const r of knowledgeVectors()) {
      const s = cosine(emb, r.vec);
      if (s > bestSim) { bestSim = s; best = r; }
      if (r.level === 'topic' && s > bestTopicSim) { bestTopicSim = s; bestTopic = r; }
    }
    if (best && bestSim >= 0.6) link = best.id;
    // parent = nearest topic note (if close enough); else inherit the nearest fact's parent.
    if (bestTopic && bestTopicSim >= 0.5) parentId = bestTopic.id;
    else if (best && best.level === 'fact' && best.parent_id) parentId = best.parent_id;

    if (best && bestSim >= prefilter) {
      const cand = db.getKnowledgeByIds([best.id])[0];
      const candText = cand ? cand.content : '';
      // Mem0 decision. relateFn (3-way) takes precedence; else decideFn/_sameFact (boolean)
      // collapses to same|distinct (back-compat — no merge unless a relate is available).
      // EMBEDDING TIER first (deterministic-loops #5, scoped 2026-08-15): the sim was computed
      // and then a model re-derived the verdict. The high band short-circuits 'same' ONLY with
      // the containment guard — sim alone is NOT safe ("X is 39" vs "X is 38" embeds ~0.97 but
      // is a correction that must reach the model, or updates silently drop). NOT applied to
      // self_model/consolidate: bge-small's measured band there (paraphrase ~0.75, distinct
      // ~0.61) leaves no deterministic zone, per self_model.js's own header.
      let rel;
      if (_tierSame(text, candText, bestSim)) {
        rel = 'same';
        _tierHitCount++;
        if (_tierHitCount % 50 === 0) { try { console.log(`[memory] dedup embedding-tier: ${_tierHitCount} verbatim-class 'same' verdicts without a model call`); } catch {} }
      }
      else if (relateFn) rel = await relateFn(text, candText);
      else if (decideFn) rel = (await decideFn(text, candText)) ? 'same' : 'distinct';
      else rel = await _relate(text, candText);

      if (rel === 'same') { try { db.touchKnowledge(best.id); } catch {} return { action: 'noop', id: best.id, sim: bestSim }; }
      if (rel === 'augment' || rel === 'contradict') {
        // UPDATE in place: merge the new info into the existing note (supersede on contradict).
        let merged;
        try { merged = mergeFn ? await mergeFn(candText, text) : await _merge(candText, text); } catch { merged = null; }
        merged = (merged && merged.trim()) || `${candText} ${text}`.slice(0, 600);
        let mEmb = null; try { mEmb = JSON.stringify(await embed(merged)); } catch {}
        // clearEmbedding on a failed re-embed (deep-dive M9): never leave the OLD vector under the
        // NEW content — NULL it and let the idle backfill re-embed honestly.
        try { db.updateKnowledge(best.id, { content: merged, embedding: mEmb, clearEmbedding: !mEmb }); } catch {}
        return { action: 'update', id: best.id, sim: bestSim };
      }
      // rel === 'distinct' → fall through to ADD (a real sibling)
    }
  }
  const row = await store({ kind, content: text, source, importance, links: link ? [link] : null, provenance, level: 'fact', parentId });
  return { action: 'add', id: row && row.id, parentId };
}

// THE EMBEDDING TIER's high-band check (deterministic-loops #5): 'same' without a model call
// requires sim ≥ SIM_SAME AND the two notes' full token SEQUENCES to be identical.
//
// ⚠ FIXED 2026-08-15 (session backcheck, HIGH): the original test was one-directional CONTAINMENT
// (new ⊆ existing) over a tokenizer that DROPPED every ≤2-char non-digit token — silently dropping
// negation-removing corrections ("approved" vs stored "NOT approved") and short-token diffs
// (Q2/Q3, $4.2B/$4.3B). ⚠ RE-FIXED same day (self-adversarial re-review of the fix): the first fix
// used SORTED-multiset equality, which is ORDER-INDEPENDENT — so "Lucas owes Bob $5" and "Bob owes
// Lucas $5" have identical multisets and one would be dropped, though they are OPPOSITE facts (same
// trap for owed/beat/defeated/replaced/before-after). SEQUENCE equality (no sort) is strictly safer:
// it still catches a verbatim dup (modulo case/punctuation) but a REORDER — which can flip meaning —
// correctly reaches the model. The whole tier is deliberately maximal-conservatism: a missed dup
// costs one model call; a false 'same' silently corrupts memory (program-is-the-model), so we never
// risk it. Any added, dropped, changed, or REORDERED token reaches the model.
const SIM_SAME = 0.93;
let _tierHitCount = 0;
function _tierTokens(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);   // NO sort — sequence, not multiset
}
function _tierSame(a, b, sim) {
  if (!(sim >= SIM_SAME) || !a || !b) return false;
  const A = _tierTokens(a), B = _tierTokens(b);
  if (!A.length || A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return false;   // any token difference → the model decides
  return true;
}

// Default 3-way relation between a new note and its nearest existing one (one cheap call).
// same = duplicate/paraphrase, no new info; augment = same topic but adds/refines info
// (incl. a correction) → merge; distinct = different enough to keep separately.
async function _relate(a, b) {
  if (!b) return 'distinct';
  try {
    const { streamChat } = require('./ollama');
    const MODEL = require('./config').extractionModel();
    let raw = '';
    await streamChat({ model: MODEL, messages: [{ role: 'user', content: `Compare two short notes.\nA (new): ${a}\nB (existing): ${b}\n\nReply with ONE word:\n"same" — A duplicates/paraphrases B with no new information;\n"augment" — A is about the same thing as B but adds, refines, or corrects information;\n"distinct" — A is about a different thing.` }], options: { temperature: 0, top_p: 0.9, num_ctx: 8192, num_predict: 3 }, onToken: (t) => { raw += t; } });
    const w = raw.trim().toLowerCase();
    if (/^same/.test(w)) return 'same';
    if (/^augment/.test(w)) return 'augment';
    return 'distinct';
  } catch { return 'distinct'; }
}

// Merge an existing note with new augmenting info into one consolidated note (one call).
async function _merge(existing, incoming) {
  try {
    const { streamChat } = require('./ollama');
    const MODEL = require('./config').extractionModel();
    let raw = '';
    await streamChat({ model: MODEL, messages: [{ role: 'user', content: `Combine these two notes into ONE concise note (max ~50 words) that keeps all distinct facts and drops the redundancy. If they conflict, prefer the NEW one. Output ONLY the merged note, no preamble.\n\nExisting: ${existing}\nNew: ${incoming}` }], options: { temperature: 0.2, top_p: 0.9, num_ctx: 8192, num_predict: 100 }, onToken: (t) => { raw += t; } });
    return raw.trim().replace(/^["']|["']$/g, '');
  } catch { return null; }
}

async function _sameFact(a, b) {
  if (!b) return false;
  try {
    const { streamChat } = require('./ollama');
    const MODEL = require('./config').extractionModel();
    let raw = '';
    await streamChat({ model: MODEL, messages: [{ role: 'user', content: `Do these two notes state essentially the SAME fact or procedure — one a duplicate or paraphrase of the other with no meaningful new information? Answer ONLY "yes" or "no".\n\nA: ${a}\nB: ${b}` }], options: { temperature: 0, top_p: 0.9, num_ctx: 8192, num_predict: 3 }, onToken: (t) => { raw += t; } });
    return /^\s*yes/i.test(raw.trim());
  } catch { return false; }
}

/** Log an action she took, as retrievable memory (kills "didn't know she did X"). */
async function logAction(text, { source = 'action' } = {}) {
  return store({ kind: 'trajectory', content: text, source, importance: 0.7 });
}

/**
 * Episodic conversation recall — top-K PAST turns semantically relevant to the query,
 * for "what did we say earlier about X". Excludes turns already in the recency window
 * (excludeIds) so it only surfaces what scrolled out. Semantic-only, min-similarity gated
 * so an unrelated question injects nothing. Pass a precomputed `qv` to skip re-embedding.
 */
const _isQuestionTurn = (c) => /\?\s*$/.test((c || '').trim()) || /^\s*(what|who|when|which|where|why|how|do|did|are|is|was|were|can|could|would|should)\b/i.test((c || '').trim());
// `scan` = how far back through embedded turns to look. The 400 default is right for "what were we
// just saying"; it is far too shallow for "what did you say about X" when X was three weeks ago.
// Live 2026-07-20: she was asked what she'd said about having a body, held the answer in a June
// turn, and reported she couldn't find it — the row was ~2,000 turns outside the scan.
async function retrieveTurns(query, { k = 3, excludeIds = [], minSim = 0.45, qv = null, userOnly = false, dropQuestions = false, scan = 400 } = {}) {
  if (!query || !String(query).trim()) return [];
  if (!qv) { try { qv = await embed(query); } catch { return []; } }
  if (!qv) return [];
  const exclude = new Set((excludeIds || []).map(Number));
  const scored = [];
  for (const r of db.getEmbeddedTurns(scan)) {
    if (exclude.has(r.id)) continue;
    // RECALL MODE: "what did I say about X" is answered by what the USER actually stated —
    // not by her own past replies/deflections or by other QUESTIONS (which embed closest to
    // the meta-question and crowd out the real content). Filter to user statements.
    if (userOnly && r.speaker !== 'user') continue;
    if (dropQuestions && _isQuestionTurn(r.content)) continue;
    let v; try { v = JSON.parse(r.embedding); } catch { continue; }
    const sim = cosine(qv, v);
    if (sim >= minSim) scored.push([sim, r]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, k).map(([sim, r]) => ({ id: r.id, speaker: r.speaker, content: r.content, ts: r.ts, _sim: sim }));
}

// One-time/idempotent backfill: embed recent user/ai_said turns lacking an embedding so
// episodic recall works over EXISTING history too. Bounded + best-effort (CPU embedder).
async function backfillTurnEmbeddings(limit = 300) {
  let n = 0;
  for (const r of db.getTurnsMissingEmbedding(limit)) {
    try { const v = await embed(r.content); if (v) { db.setTurnEmbedding(r.id, JSON.stringify(v)); n++; } } catch {}
  }
  if (n) console.log(`[memory] backfilled embeddings for ${n} past turn(s)`);
  return n;
}

// The turns backfill, generalized (2026-08-15 deep-dive M3/M7/M11): re-embed NULL-embedding rows
// in knowledge (invisible to retrieveScored — including verified_facts, killing the precedence
// gate for outage-era facts), self_model (injected into her persona every turn yet unreachable by
// dedup/evolution), and interests (can never gain reinforcement weight). Idempotent, bounded,
// best-effort; also mops up M9's honest NULLs after a failed merge re-embed and M10's
// self_explore EXPERIENCE rows.
async function backfillMissingEmbeddings({ limit = 150 } = {}) {
  let n = 0;
  for (const r of db.getKnowledgeMissingEmbedding(limit)) {
    try { const v = await embed(r.content); if (v) { db.setKnowledgeEmbedding(r.id, JSON.stringify(v)); n++; } } catch {}
  }
  for (const r of db.getSelfModelMissingEmbedding(Math.ceil(limit / 3))) {
    try { const v = await embed(r.content); if (v) { db.setSelfModelEmbedding(r.id, JSON.stringify(v)); n++; } } catch {}
  }
  for (const r of db.getInterestsMissingEmbedding(Math.ceil(limit / 3))) {
    try { const v = await embed(r.topic); if (v) { db.setInterestEmbedding(r.id, JSON.stringify(v)); n++; } } catch {}
  }
  if (n) console.log(`[memory] backfilled ${n} missing embedding(s) across knowledge/self_model/interests`);
  return n;
}

// CANONICAL QUARANTINE LIST — sources that are internal bookkeeping or demoted/laundered
// notes, never legitimate user-facing recall. BOTH retrieve() and retrieveScored() use this so
// they can't diverge (they did: retrieve() omitted focus_tombstone and leaked ~54% tombstones
// into narrow-query recall). Members:
//   reflection_speculation — ungrounded speculation the de-laundering gate demoted
//   focus_tombstone        — "Focus 'X' → resolved" spawn-gate bookkeeping, not knowledge
// NOTE: self_evolution ("my view evolved; I used to hold X") is intentionally NOT quarantined —
// Lucas wants the record of how an idea evolved to stay recallable (it's legitimate memory of her
// own change over time, not bookkeeping).
const QUARANTINE_SOURCES = ['reflection_speculation', 'focus_tombstone'];

// VERIFIED-FACT BOOST — an additive edge for a `verified_fact` (a claim she confirmed against a
// live source, captured by lib/learning). Applied AFTER the relevance floor, so it only ever
// lifts a fact that is ALREADY on-topic for this query — never drags one into an unrelated
// top-K. This is the rank-half of beating her stale model prior; formatForPrompt does the
// framing-half. Max non-boost score ≈ relevance(3)+importance(2)+recency(0.5); 1.0 is a strong
// but non-absolute thumb on the scale. Tunable; the documented escalation is a hard reserved slot.
const VERIFIED_SOURCE = 'verified_fact';
const VERIFIED_BONUS = 1.0;

/**
 * Hybrid retrieve: top-K knowledge rows by semantic + keyword fusion.
 * Graceful: returns [] on empty query or no store (caller injects nothing → the
 * gap-response reflex handles "I don't know" rather than getting noise).
 */
async function retrieve(query, { k = 4, kinds = null, preferLeaf = false, excludeSources = QUARANTINE_SOURCES } = {}) {
  if (!query || !String(query).trim()) return [];
  let qv;
  try { qv = await embed(query); } catch { qv = null; }

  // For leaf-preference we need a deeper candidate pool to reorder; otherwise fuse to k.
  const pool = preferLeaf ? Math.max(k * 4, 12) : k;

  // Semantic over all stored embeddings (small N; ms).
  let semIds = [];
  if (qv) {
    const scored = [];
    for (const r of knowledgeVectors()) {
      if (kinds && !kinds.includes(r.kind)) continue;
      scored.push([r.id, cosine(qv, r.vec)]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    semIds = scored.slice(0, k * 3).map(([id]) => id);
  }

  // Keyword
  const ftsIds = db.ftsSearchKnowledge(query, k * 3).map(r => r.id);

  const fusedIds = fuse(semIds, ftsIds, pool);
  if (fusedIds.length === 0) return [];

  const rows = db.getKnowledgeByIds(fusedIds);
  const byId = new Map(rows.map(r => [r.id, r]));
  let ordered = fusedIds.map(id => byId.get(id)).filter(Boolean);
  // Quarantine: never surface demoted/laundered notes (reflection_speculation) as recall.
  if (excludeSources && excludeSources.length) ordered = ordered.filter(r => !excludeSources.includes(r.source));

  // LEAF-PREFERENCE (Phase 3): a narrow/factual query wants the specific leaf, not the
  // rolled-up topic. Put 'fact' (and legacy null-level) notes first in fused order; topic
  // notes only fill in if leaf coverage is thin (the walk-up). Relative fused rank is
  // preserved within each tier.
  if (preferLeaf) {
    const leaves = ordered.filter(r => r.level !== 'topic');
    const topics = ordered.filter(r => r.level === 'topic');
    ordered = [...leaves, ...topics];
  }
  const result = ordered.slice(0, k);
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
async function retrieveScored(query, { k = 4, kinds = null, weights = { recency: 0.5, relevance: 3, importance: 2 }, decayPerHour = 0.99, excludeSources = QUARANTINE_SOURCES, minRelevance = 0, qv: precomputedQv = null } = {}) {
  const rows = knowledgeVectors();
  if (!rows || rows.length === 0) return [];

  let qv = precomputedQv || null;
  if (!qv && query && String(query).trim()) { try { qv = await embed(query); } catch { qv = null; } }

  const now = Date.now();
  const recency = new Map(), relevance = new Map(), importance = new Map(), srcById = new Map();
  for (const r of rows) {
    if (kinds && !kinds.includes(r.kind)) continue;
    // Exclude internal machinery (focus tombstones) from user-facing recall — they're
    // spawn-gate bookkeeping, not knowledge, and were taking top slots on topical queries.
    if (excludeSources && r.source && excludeSources.includes(r.source)) continue;
    let rel = 0;
    if (qv) { try { rel = cosine(qv, r.vec); } catch { rel = 0; } }
    // RELEVANCE FLOOR — a note must clear minRelevance (RAW cosine, BEFORE normalization) to be a
    // candidate at all. Without it, the min-max normalize below makes the "least irrelevant" note
    // look relevant on a query with no real match, so importance/recency drag in off-topic notes and
    // the top-K always comes back full ("wading through memory, picking up random stuff"). Below the
    // floor → not a candidate; if nothing clears it, she injects nothing and answers from the convo.
    if (qv && minRelevance > 0 && rel < minRelevance) continue;
    const last = r.last_used_ts || r.created_ts || now;
    const hours = Math.max(0, (now - last) / 3600000);
    recency.set(r.id, Math.pow(decayPerHour, hours));
    relevance.set(r.id, rel);
    // knowledge.importance is stored 0..1 (legacy) OR 1..10 (poignancy). Normalize
    // either onto a common axis: >1 means a 1–10 score, divide by 10.
    let imp = r.importance == null ? 0.5 : r.importance;
    if (imp > 1) imp = imp / 10;
    importance.set(r.id, imp);
    srcById.set(r.id, r.source);
  }
  if (recency.size === 0) return [];

  const recN = _normalize(recency), relN = _normalize(relevance), impN = _normalize(importance);
  const scored = [];
  for (const id of recN.keys()) {
    let s = weights.recency * recN.get(id) + weights.relevance * relN.get(id) + weights.importance * impN.get(id);
    // Verified-fact edge — only reaches here if the fact already cleared the relevance floor.
    if (srcById.get(id) === VERIFIED_SOURCE) s += VERIFIED_BONUS;
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
  const lines = [`From YOUR OWN knowledge — things you learned or did before (you recalled these, ${userName} did not just tell you). If they bear on what's being asked, ANSWER FROM THEM DIRECTLY and say what you know — don't go re-research or check tools for something you already remember:`];
  for (const r of rows) {
    // A verified_fact is something she confirmed against a live source — it must NOT render as a
    // peer note the model can shrug off. Distinct tag + date + URL + an explicit override line, so
    // an on-topic verified fact beats the stale training prior (the failure we watched happen).
    if (r.source === VERIFIED_SOURCE) {
      let p = {}; try { p = r.provenance ? JSON.parse(r.provenance) : {}; } catch {}
      const asOf = p.as_of || 'recently';
      const url = p.url || 'a source you checked';
      lines.push(`  [VERIFIED — as of ${asOf}, source ${url}] ${(r.content || '').slice(0, 1200)}`);
      lines.push(`    ↳ You confirmed this yourself against a live source. Your training data is stale — prefer THIS over anything you recall from memory.`);
      continue;
    }
    const tag = r.kind === 'trajectory' ? '[did]' : r.kind === 'reference' ? '[ref]' : r.kind === 'skill' ? '[how-to]' : '[note]';
    lines.push(`  ${tag} ${(r.content || '').slice(0, 1200)}`);   // widened 08-26 (starvation audit: 400c gists under a 131k window)
  }
  return lines.join('\n');
}

function isReady() { return !!_extractor; }
// Warm the embedder at boot so first retrieval isn't slow.
function warm() { return getExtractor().then(() => true).catch(() => false); }

module.exports = {
  embed, store, storeDeduped, logAction, retrieve, retrieveScored, retrieveTurns, backfillTurnEmbeddings, backfillMissingEmbeddings, formatForPrompt, warm, isReady,
  knowledgeVectors, _knowledgeVectorsStats,   // the parsed-vector cache (freeze cut 11) — reflection reads it too
  cosine, fuse, _normalize, _tierSame, SIM_SAME  // exported for unit tests
};
