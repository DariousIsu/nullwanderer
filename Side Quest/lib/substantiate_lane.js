'use strict';
/**
 * lib/substantiate_lane.js — Slice 4: the ASYNC SUBSTANTIATION lane (the "prove" arm of prove-or-fade;
 * docs/SUBSTANTIATION_IMPL_PLAN.md). Slice 2 mints unresolved endpoints as UNSUBSTANTIATED nodes so their
 * edges land; this background worker tries to PROVE them so Slice 3's inverted promote gate can carry them
 * long-term. The cascade (design §1):
 *
 *   1. INTERNAL first — the attached corpora / known graph (Echo search_knowledge / mediawiki / kg_neighborhood,
 *      the currently-UNUSED first validation tier). A match → IDENTITY-CONFIRMED (it's a known real thing).
 *   2. else WEB — a web search. A real (non-junk) source → SOURCE-VOUCHED.
 *   3. else leave it UNSUBSTANTIATED → Slice 6 (TTL→archive) fades it if it never proves out.
 *
 * Low-grade / oldest-first = explore priority (the queue is ordered upstream). Bounded per tick. PURE
 * decision core — the DB queue, the two probes, and the persist step are ALL injected → exhaustively
 * offline-smoke-testable. The live wiring (Echo + web + db) is supplied by main.js's curation pass.
 */
const SUB = require('./substantiation');

function _firstUrl(s) {
  if (!s) return null;
  if (typeof s === 'string') return s;
  return s.url || s.link || null;
}

// Decide the substantiation OUTCOME for one candidate from the two probe results (internal first, then web).
//   internalHit — a corpora / known-graph match: { title?, url? } (or null/undefined for a miss)
//   webSources  — external web results: [{url}|{link}|url, ...] (or null)
// Returns { state, source }: identity-confirmed (internal) > source-vouched (a real web source) >
// unsubstantiated (neither probe substantiates → leave for fade). PURE.
function decideOutcome({ internalHit = null, webSources = null } = {}) {
  if (internalHit && (internalHit.title || internalHit.url)) {
    return { state: SUB.IDENTITY_CONFIRMED, source: internalHit.url || ('internal:' + internalHit.title) };
  }
  const real = (Array.isArray(webSources) ? webSources : [])
    .map(_firstUrl).filter((u) => SUB.isRealSourceUrl(u));
  if (real.length) return { state: SUB.SOURCE_VOUCHED, source: real[0] };
  return { state: SUB.UNSUBSTANTIATED, source: null };
}

// Substantiate ONE candidate. Injected probes (async, fail-soft — a throwing probe counts as a miss):
//   validateInternal(name) → { title?, url? } | null    internal corpora / known-graph match
//   searchWeb(name)        → [{url}|url, ...]            external web results (only run if internal missed)
// Returns { name, state, source, proved } — proved=true when it flipped off unsubstantiated.
async function substantiateOne(cand, { validateInternal, searchWeb } = {}) {
  const name = String((cand && (cand.name || cand.source_entity)) || '').trim();
  if (!name) return { name: '', state: SUB.UNSUBSTANTIATED, source: null, proved: false, reason: 'no-name' };
  let internalHit = null;
  try { if (typeof validateInternal === 'function') internalHit = await validateInternal(name); } catch { internalHit = null; }
  let webSources = null;
  if (!(internalHit && (internalHit.title || internalHit.url))) {   // WEB only when INTERNAL missed (cascade order)
    try { if (typeof searchWeb === 'function') webSources = await searchWeb(name); } catch { webSources = null; }
  }
  const out = decideOutcome({ internalHit, webSources });
  return { name, state: out.state, source: out.source, proved: out.state !== SUB.UNSUBSTANTIATED };
}

// Run ONE bounded tick over the unsubstantiated queue. Injected (all async, all fail-soft):
//   listUnsubstantiated(cap) → [{ name|source_entity, grade?, captured_at? }]   the queue, priority-ordered
//   validateInternal, searchWeb                                                  the two probes
//   markProved(name, state, source) → void     persist the flip (db.setSubstantiationForEntity + source log)
//   cap  — max candidates this tick (volume discipline)
// Returns a tally { scanned, proved, internal, web, stillUnsub }. Never throws.
async function runTick({ listUnsubstantiated, validateInternal, searchWeb, markProved, cap = 12, log } = {}) {
  const out = { scanned: 0, proved: 0, internal: 0, web: 0, stillUnsub: 0 };
  let cands = [];
  try { cands = (typeof listUnsubstantiated === 'function' ? await listUnsubstantiated(cap) : []) || []; } catch { cands = []; }
  for (const cand of (Array.isArray(cands) ? cands : []).slice(0, cap)) {
    out.scanned++;
    const r = await substantiateOne(cand, { validateInternal, searchWeb });
    if (r.proved) {
      out.proved++;
      if (r.state === SUB.IDENTITY_CONFIRMED) out.internal++; else out.web++;
      if (typeof markProved === 'function') { try { await markProved(r.name, r.state, r.source); } catch {} }
      log && log(`[substantiate] proved "${r.name}" → ${r.state} (${r.source})`);
    } else {
      out.stillUnsub++;
    }
  }
  return out;
}

module.exports = { decideOutcome, substantiateOne, runTick };
