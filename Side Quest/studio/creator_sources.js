/* studio/creator_sources.js — the Creator's source-flagging analyzer (clinical panel, Slice 4).
 *
 * "Flag sources from the database." DETERMINISTIC + model-free: it reuses the verification harness's
 * proven, 0-token claim extractor (studio/verify_extract.extractUnits) to pull checkable claims
 * (quotes / statistics / citations / declarative claims) from the prose, then — in main — queries
 * the operator's knowledge DB (search_knowledge) for each. A claim with a corpus hit gets a
 * CANDIDATE source the operator can cite (the seed of the auto-citation engine); a claim with no
 * hit is flagged "needs a citation."
 *
 * HONESTY LINE (determinism law): a corpus hit means "citable material EXISTS," NOT "this claim is
 * verified true." Status is 'found' (candidate source) vs 'none' (needs citation) — never
 * "supported"/"verified". Truth verdicts are the fact-check sweep (Slice 5, the model classify leaf).
 *
 * This module is pure (extract / query-build / classify); the engine call lives in main.
 */
'use strict';
const VE = require('./verify_extract');

const MAX_CLAIMS = 20;          // bound the number of engine round-trips per pass
const MAX_QUERY = 240;          // trim a claim to a sane FTS query length

function stripMarks(s) { return String(s || '').replace(/<\/?mark>/gi, '').replace(/\s+/g, ' ').trim(); }

// Checkable claims from the block model. The balance between "source every phrase" (too noisy) and
// "source nothing" (too narrow): keep every SIGNAL-bearing unit — verbatim quotes, citation markers,
// statistics — PLUS bare declarative sentences that contain a NUMBER or YEAR (e.g. "...a 72-year low
// in 2014"), which is a cheap, strong signal of a sourceable fact. Vague prose with no number/quote
// ("the program was popular") is left alone. Headings excluded. Capped to bound engine round-trips.
function extractClaims(blocks) {
  const { units } = VE.extractUnits({ blocks: Array.isArray(blocks) ? blocks : [] }, { includeHeadings: false, includeBareClaims: true });
  const kept = units.filter(u => u.kind !== 'claim' || /\d/.test(u.text));   // bare claim kept only if it has a number/date
  return kept.slice(0, MAX_CLAIMS);
}

// The FTS query for a claim: a quote/stat is most discriminating, else the sentence text.
function queryFor(unit) {
  const base = unit && (unit.quote || unit.text) || '';
  return String(base).replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
}

// Decide a claim's source status from search_knowledge results ([{source,snippet,rank}], best-first).
function classifyMatch(unit, results) {
  const arr = Array.isArray(results) ? results : [];
  if (!arr.length) return { status: 'none', source: null, snippet: null };
  const top = arr[0] || {};
  return { status: 'found', source: top.source || 'corpus', snippet: stripMarks(top.snippet).slice(0, 220) };
}

function toFinding(unit, match) {
  return {
    id: unit.uid, anchor: unit.anchor, kind: unit.kind,
    text: unit.text, quote: unit.quote || null,
    status: match.status, source: match.source, snippet: match.snippet,
  };
}

module.exports = { extractClaims, queryFor, classifyMatch, toFinding, stripMarks, MAX_CLAIMS };
