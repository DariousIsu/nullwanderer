/**
 * lib/curation_gate.js — the shared CITATION GATE for knowledge ingestion (Slice 0 of the curation
 * substrate; see docs/CURATION_SUBSTRATE_DESIGN.md).
 *
 * FIRST PRINCIPLE: never mint an object — or attach a fact — the system can't cite as real. "Requires
 * citation" is enforced HERE, structurally, not by prompt convention. A claim enters the graph only
 * carrying a source, and its confidence IS the quality of that source.
 *
 * It grades a claim's backing source on the shared evidence ladder (studio/puller_confidence — the same
 * A/B/C/D/E capped ratchet Puller uses to say "how real is this contact") and applies the two locked
 * gates:
 *   EXISTENCE gate — mint a NEW object only if its existence cites ≥ C (named in ≥1 real source).
 *   FACT gate      — attach an edge only if it's directly stated in a source (≥ B); ≤ D (a model
 *                    inference) is HELD, never auto-promoted.
 *
 * Pure. No I/O, no model, no db — just grading + threshold logic, so it's exhaustively smoke-testable.
 */
'use strict';

const PC = require('../studio/puller_confidence');   // ORDER/CAP + rank()/cap() — the shared grade ladder

// Locked thresholds (docs/CURATION_SUBSTRATE_DESIGN.md §6; Lucas 2026-07-04).
const EXISTENCE_FLOOR = 'C';   // a NEW object needs ≥ C to mint (named in a real source); pure-D never mints
const FACT_FLOOR = 'B';        // an edge auto-promotes only if directly stated in a source (≥ B); ≤ D holds

// Source HOST reputation: fan wikis + user-generated content NEVER qualify a civic entity's existence
// or back a fact. The gate only checked "has a url" (host-agnostic), so a bulbapedia (Pokémon wiki) URL
// minted a person. A junk-hosted source is treated as NO valid source → grade D → held (not silently
// dropped). Exact-host or subdomain-suffix match; add hosts here, not in a prompt.
const JUNK_SOURCE_HOSTS = [
  'fandom.com', 'wikia.com', 'wikia.org', 'bulbagarden.net', 'tvtropes.org',
  'reddit.com', 'quora.com', 'pinterest.com', 'answers.com', 'genius.com', 'ask.fm',
];
function _sourceHost(url) {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}
function isJunkSource(url) {
  const h = _sourceHost(url);
  return !!h && JUNK_SOURCE_HOSTS.some(j => h === j || h.endsWith('.' + j));
}

// Map a dossier per-claim source ref → an evidence grade + the backing URL.
//   "S2"  → the claim is DIRECTLY STATED in sources[1] (a named source)   → grade B, url = that source
//   "inferred" / null / out-of-range / a ref with no url → grade D (model inference, unbacked), url null
function gradeForClaim(sourceRef, sources) {
  const m = /^\s*s\s*(\d+)\s*$/i.exec(String(sourceRef == null ? '' : sourceRef));
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    const s = (Array.isArray(sources) && idx >= 0) ? sources[idx] : null;
    const url = (s && (s.url || s.link)) || null;
    if (url && !isJunkSource(url)) return { grade: 'B', url, kind: 'source' };   // directly stated in a named (non-junk) source
  }
  return { grade: 'D', url: null, kind: 'derived' };        // inference / junk-only source — unbacked
}

// LIST-AWARE grading (C2 enabler): a connection the dossier cites to ONE-OR-MANY [S#] refs → the set of
// DISTINCT backing URLs. Any ≥1 named source → grade B; the FULL url set flows to corroboration downstream,
// where independent domains/families raise confidence (grade-B single source = 0.88 < floor; two INDEPENDENT
// sources = 0.94, lands). No valid cited source → grade D (inference), held. Accepts a list, a single ref, or
// a comma/space-joined string ("S1, S2"). This is what lets a well-corroborated edge actually clear the bar.
function gradeForClaims(sourceRefs, sources) {
  let refs = Array.isArray(sourceRefs) ? sourceRefs
    : (sourceRefs == null ? [] : String(sourceRefs).split(/[,\s]+/));
  const urls = [];
  for (const ref of refs) {
    const m = /^\s*s\s*(\d+)\s*$/i.exec(String(ref == null ? '' : ref));
    if (!m) continue;
    const idx = parseInt(m[1], 10) - 1;
    const s = (Array.isArray(sources) && idx >= 0) ? sources[idx] : null;
    const url = (s && (s.url || s.link)) || null;
    if (url && !isJunkSource(url) && !urls.includes(url)) urls.push(url);
  }
  if (urls.length) return { grade: 'B', urls, url: urls[0], kind: 'source' };
  return { grade: 'D', urls: [], url: null, kind: 'derived' };
}

// Is `grade` at least as strong as `floor`? (rank: A=0 strongest → higher rank = weaker.)
function meets(grade, floor) {
  const rg = PC.rank(grade), rf = PC.rank(floor);
  return Number.isFinite(rg) && rg <= rf;
}

// Gate one proposed RELATION/fact. Accepts one-or-many source refs (see gradeForClaims). Returns
// {grade, confidence, urls, url, kind, promote} — `urls` is the FULL cited set (for corroboration),
// `url` the first (back-compat).
function gateFact(sourceRefs, sources) {
  const { grade, urls, url, kind } = gradeForClaims(sourceRefs, sources);
  return { grade, confidence: PC.cap(grade), urls, url, kind, promote: meets(grade, FACT_FLOOR) };
}

// Gate the EXISTENCE of a NEW object we'd mint (a related entity, or a missing anchor). Same source
// grade, floor = C. Returns {grade, confidence, url, kind, mint}.
function gateExistence(sourceRef, sources) {
  const { grade, url, kind } = gradeForClaim(sourceRef, sources);
  return { grade, confidence: PC.cap(grade), url, kind, mint: meets(grade, EXISTENCE_FLOOR) };
}

// A missing ANCHOR (news/convo tier entity, not yet in the graph) has no per-claim ref — its existence
// is cited by the web pull that produced its dossier. Real sources present → grade C (named in the web),
// mint; nothing found → grade D, hold (a potential hallucination we won't create).
function gateAnchorExistence(sources) {
  const cited = Array.isArray(sources)
    ? sources.find(s => s && (s.url || s.link) && !isJunkSource(s.url || s.link)) : null;
  const grade = cited ? 'C' : 'D';
  const url = cited ? (cited.url || cited.link) : null;
  return { grade, confidence: PC.cap(grade), url, mint: meets(grade, EXISTENCE_FLOOR) };
}

module.exports = {
  gradeForClaim, gradeForClaims, meets, gateFact, gateExistence, gateAnchorExistence,
  isJunkSource, EXISTENCE_FLOOR, FACT_FLOOR
};
