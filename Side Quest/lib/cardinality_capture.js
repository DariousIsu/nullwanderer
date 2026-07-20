/* lib/cardinality_capture.js — MEMORY PATH MAPPING P5b: HOW a seat count actually gets recorded.
 *
 * lib/cardinality.js decides whether a seat count may be STORED. This module decides whether one was
 * legitimately OBSERVED. They are deliberately separate: the store refuses on policy (no source, bad
 * value), and refusing correctly there is worthless if the thing feeding it invents sources.
 *
 * ── WHY THIS IS NOT A REGEX OVER THE RESEARCH TEXT ─────────────────────────────────────────────
 *
 * The obvious implementation is to scan `target.raw` for "70 members" and pair it with whatever URLs
 * the focus visited. That is the `inferred` tier wearing a costume. `target.raw` is many passes of
 * model synthesis blended with page content; a number lifted from it has no determinate origin, and
 * attributing it to "one of the 12 URLs we opened" manufactures a citation. Since cardinality.js
 * treats a sourced count as authoritative, a fabricated source is worse than no count at all — it
 * would silently freeze a roster as "complete" or invent a gap that can never close.
 *
 * So the count is captured by ASKING for it and its origin together, in one narrow question with a
 * strict reply shape, and every part of the answer is then checked against something we independently
 * know. The model supplies a claim; it does not supply its own warrant.
 *
 * ── THE THREE CHECKS ───────────────────────────────────────────────────────────────────────────
 *
 *   1. SHAPE      — the reply must state SEATS and SOURCE, or say NOT FOUND. No prose salvaging: a
 *                   number we had to dig out of a sentence is a number we do not understand.
 *   2. PLAUSIBLE  — delegated to cardinality.isPlausible (rejects years, zeroes, parse debris).
 *   3. PROVENANCE — the cited URL's HOST must be one the run actually visited. This is the
 *                   anti-fabrication check and the reason the module exists. A model that invents a
 *                   tidy-looking `legislature.<state>.gov/members` URL it never opened fails here.
 *
 * Host-level (not exact-URL) matching is intentional: opening a chamber's landing page and citing a
 * deep link on the same host is normal, honest research. Matching the full URL would reject that and
 * push toward citing the vaguer page — worse provenance, not better.
 *
 * Pure functions only; no db, no network. The caller runs the pass and does the storing.
 */
'use strict';

const cardinality = require('./cardinality');

// A .gov / .us legislature domain is the body speaking about itself — the only 'official' tier.
// Everything else that survives the checks is 'secondary'. We never mint 'corroborated' here: that
// means two INDEPENDENT sources agreed, which is a fact about a set of observations, not about one.
const OFFICIAL_HOST = /(^|\.)(gov|mil)$|(^|\.)[a-z]{2}\.us$/i;

function hostOf(url) {
  try {
    const u = new URL(String(url).trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return null; }
}

function classifySource(url) {
  const h = hostOf(url);
  if (!h) return null;
  return OFFICIAL_HOST.test(h) ? 'official' : 'secondary';
}

// Did this run actually go to that host? `visited` is the focus's visited list, which mixes opened
// URLs with "search: ..." entries — the search entries simply yield no host and never match.
function visitedHosts(visited) {
  const out = new Set();
  for (const v of (Array.isArray(visited) ? visited : [])) {
    const h = hostOf(v);
    if (h) out.add(h);
  }
  return out;
}

// Same registrable-ish site? Accept an exact host or a subdomain relationship, so
// `house.legislature.idaho.gov` counts as visiting `legislature.idaho.gov` and vice versa. We do NOT
// go down to the bare TLD+1 — `.gov` must not make every government site interchangeable.
function hostMatches(cited, seen) {
  if (seen.has(cited)) return true;
  for (const h of seen) {
    if (cited.endsWith('.' + h) || h.endsWith('.' + cited)) return true;
  }
  return false;
}

// The narrow question. One fact, one shape, and an explicit escape hatch — a pass that cannot answer
// must be able to say so cheaply, or it will invent something to fill the format.
function buildPrompt(body) {
  return `You are checking ONE specific fact about ${body}: how many seats it has in total.

This is a CITATION task, not a research summary. Report only a number you can point at in a source you actually opened.

Reply in EXACTLY this shape, nothing else:
SEATS: <the total number of seats/members>
SOURCE: <the full URL of the page that states it>

If you did not open a page that explicitly states the total number of seats, reply with exactly:
NOT FOUND

Do NOT count a roster to get the number. Do NOT estimate from what you know. Do NOT cite a page you did not open. "NOT FOUND" is a correct and useful answer — a wrong seat count is far worse than no seat count, because it makes an incomplete roster look finished.`;
}

// Parse + fully vet a reply. Returns { ok:false, reason } or { ok:true, seats, sourceKind, sourceRef }.
// Every rejection carries a reason so the wiring can log WHY nothing was recorded — a silent skip is
// indistinguishable from "this body has no seat count", which is the confusion P5 exists to end.
function parseCapture(answer, { visited = [] } = {}) {
  const ans = String(answer || '').trim();
  if (!ans) return { ok: false, reason: 'empty reply' };
  if (/\bNOT\s*FOUND\b/i.test(ans) && !/^\s*SEATS:/im.test(ans)) {
    return { ok: false, reason: 'not found (honest refusal)', refused: true };
  }

  const sm = ans.match(/^\s*SEATS:\s*([^\n]+)$/im);
  const um = ans.match(/^\s*SOURCE:\s*([^\n]+)$/im);
  if (!sm) return { ok: false, reason: 'no SEATS line — reply did not follow the shape' };
  if (!um) return { ok: false, reason: 'no SOURCE line — a count without an origin is not usable' };

  // Take the first bare integer on the SEATS line. Anything else ("70-105", "about 70") is ambiguous
  // and must fail rather than be rounded into a decision.
  const raw = sm[1].trim().replace(/[,*_`]/g, '');
  const nm = raw.match(/^(\d+)\b/);
  if (!nm) return { ok: false, reason: `unparseable seat value: "${sm[1].trim().slice(0, 40)}"` };
  if (/\b(?:to|or|-|–)\s*\d/.test(raw.slice(nm[1].length))) {
    return { ok: false, reason: `ambiguous range, not a count: "${raw.slice(0, 40)}"` };
  }
  const seats = Number(nm[1]);
  if (!cardinality.isPlausible(seats)) return { ok: false, reason: `implausible seat count: ${seats}` };

  const sourceRef = um[1].trim().replace(/[)\]>.,]+$/, '');
  const sourceKind = classifySource(sourceRef);
  if (!sourceKind) return { ok: false, reason: `SOURCE is not a usable URL: "${sourceRef.slice(0, 60)}"` };

  // THE ANTI-FABRICATION CHECK. Only enforced when we have a visited list to check against — with no
  // record of where the run went we cannot judge, and inventing a pass here would be the same sin.
  const seen = visitedHosts(visited);
  if (seen.size) {
    const cited = hostOf(sourceRef);
    if (!hostMatches(cited, seen)) {
      return { ok: false, reason: `cited host "${cited}" was never visited by this run — refusing a source we cannot confirm was read`, fabricated: true };
    }
  }

  return { ok: true, seats, sourceKind, sourceRef: sourceRef.slice(0, 300) };
}

module.exports = { OFFICIAL_HOST, hostOf, classifySource, visitedHosts, hostMatches, buildPrompt, parseCapture };
