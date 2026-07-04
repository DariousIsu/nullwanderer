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
const NEWS_MAX = 4, FRONTIER_MAX = 6, CONVO_MAX = 3;
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
function assembleAnchors({ news = [], frontier = [], convo = [], visitedKeys = new Set(),
  max = MAX_TOTAL, newsMax = NEWS_MAX, frontierMax = FRONTIER_MAX, convoMax = CONVO_MAX } = {}) {
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
  // canonical = the RAW graph name (with its "[Q…]" tag): the clean `mention` drives web search + voice,
  // but propose_* must target the EXACT node we selected (else "Woodrow Wilson" hits a wikiquote-doc twin,
  // not the person) — so growAround uses object.canonical for the propose calls.
  addTier(frontierCandidates(frontier, { max: 500 }).map(r => ({ mention: _clean(r.name), source: 'frontier', kind: 'thin', object: { id: r.id, degree: r.degree, canonical: r.raw } })), frontierMax);
  addTier(convoCandidates(convo, { max: convoMax * 4 }).map(n => ({ mention: _clean(n), source: 'convo' })), convoMax);
  return out;
}

// Async gatherer: resolves the three tiers from injected providers (each a value or an async fn) and
// assembles the queue. Every source is fail-soft — a dead tier just contributes nothing, never throws.
async function provideAnchors({ recentNews, thinNodes, convoNames, visitedKeys, log } = {}) {
  const resolve = async (src, label) => {
    try { return typeof src === 'function' ? ((await src()) || []) : (src || []); }
    catch (e) { log && log(`[idle-anchors] ${label} source failed: ${e && e.message}`); return []; }
  };
  const news = await resolve(recentNews, 'news');
  const frontier = await resolve(thinNodes, 'frontier');
  const convo = await resolve(convoNames, 'convo');
  return assembleAnchors({ news, frontier, convo, visitedKeys: visitedKeys || new Set() });
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
  newsCandidates, frontierCandidates, convoCandidates, assembleAnchors, provideAnchors, rotateFrontierCursor,
  MAX_PER_TIER, MAX_TOTAL, NEWS_MAX, FRONTIER_MAX, CONVO_MAX
};
