/**
 * lib/idle_anchors.js — GROUNDED anchor sourcing for the idle graph-builder.
 *
 * WHY: the idle knowledge-builder (graph_walk.runMove) used to derive its anchors ONLY from recent
 * conversation (extractCandidates(recentTurns)). When Lucas goes quiet — the common overnight/away
 * case — recentTurns ages out to her own heartbeat musings, the candidate extractor finds nothing,
 * and the whole knowledge-expansion loop goes silent (audit 2026-07-04: no notable graph move in 2
 * days while she idled). The old fix — a self-accreted "interest agenda" — was deleted as a rootless
 * noise generator. This is the middle path: NON-conversational anchors that are still GROUNDED.
 *
 * Three tiers, in priority order (a move takes the first tier that yields a real gap):
 *   1. NEWS      — principals (people/orgs/places) of recent, corroborated news the world just surfaced.
 *                  "X is in the news and I have nothing on X" → build it. Fresh, external, grounded by
 *                  the story's corroboration.
 *   2. FRONTIER  — under-developed objects ALREADY in the graph (low degree / few facts). "I half-know
 *                  X" → fill it in. Always available, grounded by definition (the node exists).
 *   3. CONVO     — the existing recent-conversation gap (names passed in). Still first-class when Lucas
 *                  is actually talking; just no longer the ONLY fuel.
 *
 * Pure + deps-injected: news objects, thin-node rows, and convo names are ALL passed in (or supplied by
 * injected async providers), so the cascade is offline-testable with no news_db, Echo, or model. Live
 * wiring lives in monologue.js (runGraphWalkMove).
 */
'use strict';

const { visitKey } = require('./graph_walk');   // shared dedup key (no cycle: graph_walk never requires this)

const MAX_PER_TIER = 6;
const MAX_TOTAL = 10;
// per-tier slot caps (news is priority-first per Lucas's cascade, but it's mostly already-rich famous
// entities, so it's capped LOW so it can't crowd out the frontier tier — the reliable gap source).
// RELEVANT (Lucas's neighborhood) is the FOCUS tier — capped generously so it dominates the queue when he
// has recent work, pushing the global frontier into a fallback role. News stays first (fresh external world).
const NEWS_MAX = 4, RELEVANT_MAX = 6, FRONTIER_MAX = 6, CONVO_MAX = 3;
const STOPNAMES = new Set(['i', 'you', 'he', 'she', 'they', 'it', 'we', 'us', 'lucas', 'zoe', 'the', 'a', 'an', 'this', 'that', 'them', 'his', 'her', 'their']);

function _clean(name) {
  return String(name == null ? '' : name)
    // strip a trailing graph ID tag: wikidata "[Q53268]"/"[wd:Q34296]" or bioguide "[T000058]"/"[C001044]"
    // → cleaner web search + dossier prompt + voice. (The RAW name is kept as `canonical` for propose_*.)
    .replace(/\s*\[[A-Za-z0-9:]*\d[A-Za-z0-9:]*\]\s*$/, '')
    .replace(/\s+/g, ' ').trim();               // no-op for news/convo names (they carry no such tag)
}
function _usable(name) {
  const n = _clean(name);
  if (n.length < 3) return false;
  const k = visitKey(n);
  if (!k) return false;
  // single bare stopword token → junk
  const toks = k.split(' ').filter(Boolean);
  if (toks.length === 1 && STOPNAMES.has(toks[0])) return false;
  return true;
}

// --- tier 1: NEWS principals -----------------------------------------------
// Input: news objects (news_objects.recentNewsObjects shape) — each has .principals (entity tokens) and
// .corroboration.independent. A principal appearing across several well-corroborated stories is a stronger
// anchor, so we score by summed corroboration and return names most-newsworthy first.
function newsCandidates(newsObjects, { max = MAX_PER_TIER } = {}) {
  const score = new Map();   // key → { name, s }
  for (const o of (Array.isArray(newsObjects) ? newsObjects : [])) {
    if (!o) continue;
    const weight = Math.max(1, Number(o.corroboration && o.corroboration.independent) || 1);
    for (const p of (Array.isArray(o.principals) ? o.principals : [])) {
      const name = _clean(p);
      if (!_usable(name)) continue;
      const k = visitKey(name);
      const cur = score.get(k);
      if (cur) cur.s += weight;
      else score.set(k, { name, s: weight });
    }
  }
  return [...score.values()].sort((a, b) => b.s - a.s).slice(0, max).map(x => x.name);
}

// --- tier 2: FRONTIER thin nodes -------------------------------------------
// Input: rows of already-in-graph objects worth enriching (e.g. db_query for low-degree entities). Each
// row is {id, name, degree, ...}. Thinnest first (most in need of filling). Deduped, junk-filtered.
// Returns the ROWS (name + id + degree) so the assembler can carry the KNOWN gap classification — the
// graph degree we selected on is the truth, not recallObject's rich-sweep resolution downstream.
function frontierCandidates(thinNodes, { max = FRONTIER_MAX } = {}) {
  const rows = (Array.isArray(thinNodes) ? thinNodes : [])
    .map(r => { const raw = String((r && (r.name || r.entity || r)) || ''); return { name: _clean(raw), raw, id: (r && r.id != null) ? r.id : null, degree: Number(r && r.degree) || 0 }; })
    .filter(r => _usable(r.name));
  const seen = new Set(); const out = [];
  rows.sort((a, b) => b.degree - a.degree);   // MOST-connectable first (degree DESC): more web presence + edges to forge
  for (const r of rows) { const k = visitKey(r.name); if (seen.has(k)) continue; seen.add(k); out.push(r); if (out.length >= max) break; }
  return out;
}

// --- tier 1.5: RELEVANT frontier — thin nodes in Lucas's neighborhood -------
// The global FRONTIER tier walks the WHOLE thin set (random 1800s congressmen etc.) — grounded but not
// FOCUSED on what Lucas actually works on. This tier steers enrichment toward HIS graph: given the entity
// names he recently touched (dropped-document decomposition + fresh conversation = the "active set"), it
// returns thin (degree 2-7) nodes that are EITHER in that active set OR 1-hop neighbors of it via Echo
// `relations`. So the builder fills in the region around his work first, and only falls through to the
// global walk when his neighborhood is exhausted. Deps-injected async `query` (SQL runner → {rows}) keeps
// it offline-testable; fail-soft (no names / dead query → []).
const _RELEVANT_MAX_NAMES = 40;    // cap the IN() list so the neighbor query stays cheap
function _sqlName(n) { return `'${String(n).replace(/'/g, "''")}'`; }   // SELECT-only db_query; escape quotes
// The web-enrichable, "who/what-org/what-happened" entity types — the surface Lucas actually works on
// (people, orgs, the summit event, agencies). Deliberately EXCLUDES the 1.5M `bill` rows, `document`
// (vault-doc nodes like the "Rainey Center Offer Letter" pollution), and legislative-structure types
// (committee/decision/legal_instrument/office_held) which aren't objects you enrich from the open web.
const _RELEVANT_TYPES = ['person', 'organization', 'event', 'government_body'];

// Build the active ∪ neighbors-of-active SQL (pure — no DB). Returns null when no usable names, so the
// caller can skip the query and fall straight through to the global frontier.
//
// UNLIKE the global frontier, this tier does NOT gate on wikidata_qid: Lucas's neighborhood is freshly
// curated local material (his dropped-doc people/orgs, the LAMP summit) that carries no QID — the very
// nodes the global QID gate would exclude. Focus comes from active-set membership + real-entity type +
// an under-developed degree band instead. We match BOTH the cleaned name AND the raw stored form because
// doc-decomp nodes keep a disambiguation tag ("Brad Overcash [dfacde1f]") whose person node only matches
// the raw string (the cleaned "Brad Overcash" hits the document twin, which the type gate then drops).
function buildRelevantFrontierSql(activeNames, { min = 1, max = 15, limit = 200, types = _RELEVANT_TYPES } = {}) {
  const forms = new Set();
  let considered = 0;
  for (const nm of (Array.isArray(activeNames) ? activeNames : [])) {
    if (considered >= _RELEVANT_MAX_NAMES) break;
    const raw = String(nm == null ? '' : nm).trim();
    const cleaned = _clean(nm);
    if (cleaned.length < 3) continue;          // gate on the cleaned form; a real entity name is ≥3 chars
    considered++;
    forms.add(cleaned);
    if (raw && raw !== cleaned && raw.length >= 3) forms.add(raw);   // also match the tagged/raw node
  }
  if (!forms.size) return null;
  const inList = [...forms].map(_sqlName).join(',');
  const typeList = (Array.isArray(types) && types.length ? types : _RELEVANT_TYPES).map(_sqlName).join(',');
  const mn = Math.max(0, parseInt(min, 10)); const mx = Math.max(mn, parseInt(max, 10) || 15), lim = Math.max(1, parseInt(limit, 10) || 200);
  // UNION: (a) active entities that are themselves under-developed real entities — direct enrichment of
  // what he touched; and (b) their under-developed real-entity neighbors via the relations graph — his
  // rich hubs (Ted Alexander deg 79, the summit deg 29) are kept as e1 SEEDS (no degree cap on e1) so they
  // radiate to thin neighbors, but excluded as enrichment TARGETS (the e2/self degree band skips them).
  return `SELECT id, name, degree FROM entities`
    + ` WHERE name IN (${inList}) AND entity_type IN (${typeList}) AND degree BETWEEN ${mn} AND ${mx}`
    + ` UNION `
    + `SELECT e2.id, e2.name, e2.degree FROM entities e1`
    + ` JOIN relations r ON (r.source_id = e1.id OR r.target_id = e1.id) AND r.deleted = 0`
    + ` JOIN entities e2 ON e2.id = (CASE WHEN r.source_id = e1.id THEN r.target_id ELSE r.source_id END)`
    + ` WHERE e1.name IN (${inList}) AND e2.entity_type IN (${typeList}) AND e2.degree BETWEEN ${mn} AND ${mx}`
    + ` ORDER BY degree DESC LIMIT ${lim}`;
}

// Run the relevant-frontier query via an injected SQL runner. Returns {id,name,degree} rows (same shape as
// the global frontier tier) so the assembler treats them identically downstream.
async function relevantFrontier(activeNames, { query, min, max, limit = 200, log } = {}) {
  const sql = buildRelevantFrontierSql(activeNames, { min, max, limit });   // undefined min/max → builder's focus defaults (1..15)
  if (!sql || typeof query !== 'function') return [];
  try {
    const r = await query(sql);
    const rows = (r && (r.rows || r)) || [];
    return Array.isArray(rows) ? rows : [];
  } catch (e) { log && log(`[idle-anchors] relevant frontier failed: ${e && e.message}`); return []; }
}

// --- tier 3: CONVO names (already extracted upstream) ----------------------
function convoCandidates(names, { max = MAX_PER_TIER } = {}) {
  const seen = new Set(); const out = [];
  for (const nm of (Array.isArray(names) ? names : [])) {
    const name = _clean(nm);
    if (!_usable(name)) continue;
    const k = visitKey(name); if (seen.has(k)) continue; seen.add(k);
    out.push(name); if (out.length >= max) break;
  }
  return out;
}

// Assemble the prioritized, cross-tier-deduped, visited-filtered anchor queue. Each entry carries its
// SOURCE (provenance); FRONTIER entries also carry a pre-classification {kind:'thin', object:{id,degree}}
// so the downstream assess step trusts the graph degree we selected on instead of re-resolving the name
// to a famous same-name twin and flipping it 'rich'. Pure.
function assembleAnchors({ news = [], relevant = [], frontier = [], convo = [], visitedKeys = new Set(),
  max = MAX_TOTAL, newsMax = NEWS_MAX, relevantMax = RELEVANT_MAX, frontierMax = FRONTIER_MAX, convoMax = CONVO_MAX } = {}) {
  const out = [];
  const seen = new Set(visitedKeys instanceof Set ? visitedKeys : []);
  let full = false;
  // Scan a DEEP per-tier pool, skipping visited/dup, adding FRESH entries up to the tier cap. This is the
  // fix for frontier visited-exhaustion: the deterministic db_query returns the same top nodes every tick,
  // so capping BEFORE the visited filter (old bug) meant once the top few were visited the tier went empty.
  // Now we filter-then-cap over the whole pool → always surfaces fresh thin nodes until the pool is dry.
  const addTier = (entries, cap) => {
    let added = 0;
    for (const e of entries) {
      if (full || added >= cap) break;
      const k = visitKey(e.mention);
      if (!k || seen.has(k)) continue;   // visited / dup / junk → skip, keep scanning for fresh ones
      seen.add(k); out.push(e); added++;
      if (out.length >= max) full = true;
    }
  };
  addTier(newsCandidates(news, { max: newsMax * 4 }).map(n => ({ mention: _clean(n), source: 'news' })), newsMax);
  // RELEVANT (Lucas's neighborhood) sits ABOVE the global frontier so idle enrichment focuses on his work;
  // the global frontier stays below as the always-available fallback so the walk never starves when his
  // neighborhood is exhausted. Same thin-row shape as frontier → same canonical/degree handling downstream.
  addTier(frontierCandidates(relevant, { max: 500 }).map(r => ({ mention: _clean(r.name), source: 'relevant', kind: 'thin', object: { id: r.id, degree: r.degree, canonical: r.raw } })), relevantMax);
  // canonical = the RAW graph name (with its "[Q…]" tag): the clean `mention` drives web search + voice,
  // but propose_* must target the EXACT node we selected (else "Woodrow Wilson" hits a wikiquote-doc twin,
  // not the person) — so growAround uses object.canonical for the propose calls.
  addTier(frontierCandidates(frontier, { max: 500 }).map(r => ({ mention: _clean(r.name), source: 'frontier', kind: 'thin', object: { id: r.id, degree: r.degree, canonical: r.raw } })), frontierMax);
  addTier(convoCandidates(convo, { max: convoMax * 4 }).map(n => ({ mention: _clean(n), source: 'convo' })), convoMax);
  return out;
}

// Async gatherer: resolves the three tiers from injected providers (each a value or an async fn) and
// assembles the queue. Every source is fail-soft — a dead tier just contributes nothing, never throws.
async function provideAnchors({ recentNews, relevantNodes, thinNodes, convoNames, visitedKeys, log } = {}) {
  const resolve = async (src, label) => {
    try { return typeof src === 'function' ? ((await src()) || []) : (src || []); }
    catch (e) { log && log(`[idle-anchors] ${label} source failed: ${e && e.message}`); return []; }
  };
  const news = await resolve(recentNews, 'news');
  const relevant = await resolve(relevantNodes, 'relevant');
  const frontier = await resolve(thinNodes, 'frontier');
  const convo = await resolve(convoNames, 'convo');
  return assembleAnchors({ news, relevant, frontier, convo, visitedKeys: visitedKeys || new Set() });
}

// Rotate the frontier query window so the graph-walk walks the WHOLE thin set over time rather than
// re-offering the same deterministic top-N (which the visited-filter drains to empty → permanent no-gap,
// the exhaustion we hit at visited=392 > a 200 pool). Advance by one window each cycle; wrap to 0 when a
// short page signals the end of the set. Pure.
function rotateFrontierCursor(cursor, returnedCount, windowSize) {
  const w = Math.max(1, Number(windowSize) || 1);
  const c = Math.max(0, Number(cursor) || 0);
  if ((Number(returnedCount) || 0) < w) return 0;   // hit the end of the set → wrap around
  return c + w;
}

module.exports = {
  newsCandidates, frontierCandidates, convoCandidates, buildRelevantFrontierSql, relevantFrontier,
  assembleAnchors, provideAnchors, rotateFrontierCursor,
  MAX_PER_TIER, MAX_TOTAL, NEWS_MAX, RELEVANT_MAX, FRONTIER_MAX, CONVO_MAX
};
