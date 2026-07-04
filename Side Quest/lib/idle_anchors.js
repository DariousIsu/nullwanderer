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
const MAX_TOTAL = 8;
const STOPNAMES = new Set(['i', 'you', 'he', 'she', 'they', 'it', 'we', 'us', 'lucas', 'zoe', 'the', 'a', 'an', 'this', 'that', 'them', 'his', 'her', 'their']);

function _clean(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
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
// row is {name, degree, ...}. Thinnest first (most in need of filling). Deduped, junk-filtered.
function frontierCandidates(thinNodes, { max = MAX_PER_TIER } = {}) {
  const rows = (Array.isArray(thinNodes) ? thinNodes : [])
    .map(r => ({ name: _clean(r && (r.name || r.entity || r)), degree: Number(r && r.degree) || 0 }))
    .filter(r => _usable(r.name));
  const seen = new Set(); const out = [];
  rows.sort((a, b) => a.degree - b.degree);
  for (const r of rows) { const k = visitKey(r.name); if (seen.has(k)) continue; seen.add(k); out.push(r.name); if (out.length >= max) break; }
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
// SOURCE so the move can log/steer by provenance. Pure.
function assembleAnchors({ news = [], frontier = [], convo = [], visitedKeys = new Set(), max = MAX_TOTAL } = {}) {
  const out = [];
  const seen = new Set(visitedKeys instanceof Set ? visitedKeys : []);
  const push = (name, source) => {
    const k = visitKey(name);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ mention: _clean(name), source });
  };
  for (const n of newsCandidates(news)) { push(n, 'news'); if (out.length >= max) return out; }
  for (const n of frontierCandidates(frontier)) { push(n, 'frontier'); if (out.length >= max) return out; }
  for (const n of convoCandidates(convo)) { push(n, 'convo'); if (out.length >= max) return out; }
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

module.exports = {
  newsCandidates, frontierCandidates, convoCandidates, assembleAnchors, provideAnchors,
  MAX_PER_TIER, MAX_TOTAL
};
