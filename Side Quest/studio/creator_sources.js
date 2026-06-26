/* studio/creator_sources.js — the Creator's source-flagging analyzer (clinical panel, Slice 4).
 *
 * "Flag sources from the database." DETERMINISTIC + model-free: it reuses the verification harness's
 * proven, 0-token claim extractor (studio/verify_extract.extractUnits) to pull checkable claims
 * (quotes / statistics / numeric claims) from the prose, then — in main — queries the operator's
 * OWN corpus (the `search` tool: FTS over Rainey content; returns doc_id + title + path + project)
 * for each. A claim with a corpus hit gets a CANDIDATE source the operator can OPEN and cite (the
 * seed of the auto-citation engine); a claim with no hit is flagged "needs a citation."
 *
 * Lessons baked in (from in-app feedback + live engine probes):
 *  - Query the operator's OWN corpus (`search`), NOT the broad external `search_knowledge` — the
 *    latter returns loosely-related snippets with no openable identity (noise dressed as citations).
 *  - The `search` tool is implicit-AND and has NO 'OR' operator (probed: "a OR b" → []). Long
 *    queries starve (all terms must co-occur); single terms over-match. The sweet spot is the TOP-2
 *    salient terms (AND) with a SINGLE-term fallback — `queries()` returns both, tried in order.
 *  - DON'T pre-gate claims on "has a number" (that dropped on-topic prose before any search ran).
 *    Instead: search every substantive sentence, and SURFACE only the ones the corpus actually
 *    matched (status 'found') plus signal-bearing claims (stat/quote/citation) that lack a match
 *    ("needs citation"). Vague unmatched prose is silently skipped — no "source every phrase" noise.
 *
 * HONESTY LINE (determinism law): a corpus hit means "citable material EXISTS," NOT "this claim is
 * verified true." Status is 'found' (candidate source, openable) vs 'none' (needs citation) — never
 * "supported"/"verified". Truth verdicts are the fact-check sweep (Slice 5, the model classify leaf).
 *
 * This module is pure (extract / keyword-query / classify / surface-gate); engine calls live in main.
 */
'use strict';
const VE = require('./verify_extract');

const MAX_CLAIMS = 20;          // bound the number of engine round-trips per pass
const MIN_CLAIM_WORDS = 6;      // a bare sentence must be this substantive to be worth searching

// Common words that make poor FTS terms (only filtered when lowercase — a capitalized form is a
// possible proper noun and kept).
const STOP = new Set(('the a an and or but of to in on for with that this it is are was were be been as at by from has have had his '
  + 'her their they we our you your not no so if then than into about over under after before during today tomorrow yesterday said '
  + 'told says will would can could should may might must also more most some such other these those there here what which who whom '
  + 'whose when where why how out off up down them him she he its just only very much many own per via amid among amongst toward '
  + 'towards across because since whether either neither while however although though thus hence meanwhile let lets each every '
  + 'against between within without upon onto still even yet once first last next new old per').split(/\s+/));

function stripMarks(s) { return String(s || '').replace(/<\/?mark>/gi, '').replace(/\s+/g, ' ').trim(); }
function wordCount(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }

// Salient keywords from a claim, best-first. Proper nouns + 4-digit years weigh highest; then longer
// words (UNCAPPED length, so a specific term like "permitting" outranks an incidental "straining").
// Pure alphanumeric tokens only — always FTS5-MATCH-safe. Returns ALL scored terms (caller slices).
function keywords(text) {
  const toks = String(text || '').match(/[A-Za-z]{3,}|\d{4}/g) || [];
  const seen = new Set(); const scored = [];
  for (const raw of toks) {
    const low = raw.toLowerCase();
    if (STOP.has(low)) continue;   // stopword (case-insensitive — drops sentence-initial "The", "After", …)
    if (seen.has(low)) continue; seen.add(low);
    const isYear = /^\d{4}$/.test(raw);
    const proper = /^[A-Z]/.test(raw);
    scored.push({ term: raw, score: (proper ? 3 : 0) + (isYear ? 3 : 0) + raw.length * 0.25 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.term);
}

// Checkable claims worth searching: every SIGNAL-bearing unit (quote / statistic / citation) PLUS
// any bare declarative sentence of ≥ MIN_CLAIM_WORDS (substantive enough to have a source). We do
// NOT pre-filter bare claims on content here — the SURFACING gate (shouldSurface) decides what the
// operator actually sees, so on-topic prose still gets searched. Headings excluded; capped.
function extractClaims(blocks) {
  const { units } = VE.extractUnits({ blocks: Array.isArray(blocks) ? blocks : [] }, { includeHeadings: false, includeBareClaims: true });
  const kept = units.filter(u => u.kind !== 'claim' || wordCount(u.text) >= MIN_CLAIM_WORDS);
  return kept.slice(0, MAX_CLAIMS);
}

// Ordered candidate FTS queries for a claim: top-2 terms (AND, precision) then the single top term
// (recall fallback). main tries them in order, stopping at the first hit. Empty ⇒ skip the search.
function queries(unit) {
  const kw = keywords((unit && (unit.quote || unit.text)) || '');
  if (!kw.length) return [];
  const out = [];
  if (kw.length >= 2) out.push(kw.slice(0, 2).join(' '));
  // Single-term fallback ONLY when the top term is DISTINCTIVE (proper noun or year) — a generic
  // word like "program" alone would broadly false-match; a distinctive term is a safe recall net.
  const top = kw[0];
  if (out.length === 0 || /^[A-Z]/.test(top) || /^\d{4}$/.test(top)) out.push(top);
  return [...new Set(out)];
}
// Back-compat single query (top-2 AND); main uses queries() for the fallback chain.
function queryFor(unit) { return keywords((unit && (unit.quote || unit.text)) || '').slice(0, 2).join(' '); }

// Surfacing gate (kills noise): show a finding only if the corpus actually matched it, OR it's a
// signal-bearing claim (stat/quote/citation) that genuinely warrants a citation. A vague bare
// sentence with no corpus match is dropped — never surfaced.
function shouldSurface(finding) {
  return !!finding && (finding.status === 'found' || (finding.kind && finding.kind !== 'claim'));
}

const NONE = { status: 'none', provenance: null, docId: null, url: null, title: null, source: null, snippet: null, project: null, byline: null };

// Internal lane: decide a claim's source status from `search` results
// ([{doc_id,title,snippet,path,project_name,rank}], best-first). A hit → an OPENABLE library source.
function classifyMatch(unit, results) {
  const arr = Array.isArray(results) ? results : [];
  if (!arr.length) return { ...NONE };
  const top = arr[0] || {};
  return {
    ...NONE,
    status: 'found', provenance: 'library',
    docId: top.doc_id != null ? top.doc_id : null,
    title: top.title || '(untitled)',
    source: top.project_name || 'corpus',
    snippet: stripMarks(top.snippet).slice(0, 220),
    project: top.project_name || null,
  };
}

// Natural-language query for the external lanes (web/academic accept prose, unlike FTS). Prefer a
// verbatim quote; else the sentence, trimmed.
function webQuery(unit) {
  const base = (unit && (unit.quote || unit.text)) || '';
  return String(base).replace(/\s+/g, ' ').trim().slice(0, 200);
}

// External lane: choose the best candidate from the web + academic result sets. Academic is preferred
// (peer-reviewed / higher-trust citation) when present; else top web hit. Returns an openable URL.
//   webRows:  [{title,url,snippet}]
//   acadRows: [{title,authors[],year,venue,doi,url,abstract,is_oa,source}]
function classifyExternal(webRows, acadRows) {
  const acad = (Array.isArray(acadRows) ? acadRows : [])[0];
  if (acad && (acad.url || acad.doi)) {
    const authors = Array.isArray(acad.authors) ? acad.authors : [];
    const byline = authors.length ? (authors.length > 2 ? `${authors[0]} et al.` : authors.join(', ')) : '';
    return {
      ...NONE,
      status: 'found', provenance: 'academic',
      url: acad.url || `https://doi.org/${acad.doi}`,
      title: acad.title || '(untitled)',
      snippet: stripMarks(acad.abstract || [byline, acad.venue, acad.year].filter(Boolean).join(' · ')).slice(0, 220),
      source: acad.source || 'academic',
      byline: byline || null,
    };
  }
  const web = (Array.isArray(webRows) ? webRows : [])[0];
  if (web && web.url) {
    let host = ''; try { host = new URL(web.url).hostname.replace(/^www\./, ''); } catch (e) {}
    return {
      ...NONE,
      status: 'found', provenance: 'web',
      url: web.url,
      title: web.title || host || '(untitled)',
      snippet: stripMarks(web.snippet).slice(0, 220),
      source: host || 'web',
    };
  }
  return { ...NONE };
}

function toFinding(unit, match) {
  return {
    id: unit.uid, anchor: unit.anchor, kind: unit.kind,
    text: unit.text, quote: unit.quote || null,
    status: match.status, provenance: match.provenance,
    docId: match.docId, url: match.url, title: match.title,
    source: match.source, snippet: match.snippet, project: match.project, byline: match.byline,
  };
}

module.exports = { extractClaims, keywords, queries, queryFor, webQuery, classifyMatch, classifyExternal, toFinding, shouldSurface, stripMarks, wordCount, MAX_CLAIMS };
