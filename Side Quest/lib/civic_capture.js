/* lib/civic_capture.js — HOW a roster legitimately gets into civic_memberships.
 *
 * The sibling of lib/cardinality_capture, and the same doctrine for the same reason: lib/civic_store
 * decides whether a seat MAY be stored; this decides whether one was legitimately OBSERVED. Refusing
 * correctly in the store is worthless if the thing feeding it invents people.
 *
 * ── WHY THIS IS NOT AN EXTRACTION OVER target.raw ─────────────────────────────────────────────
 *
 * The obvious implementation is to have the model read many passes of accumulated synthesis and emit
 * the roster it "saw". That is fabrication with extra steps: `target.raw` blends page text with the
 * model's own prose across a dozen passes, so a NAME lifted from it has no determinate origin — and
 * a name is far more dangerous than a number. An invented seat count looks wrong to anyone who
 * checks; an invented PERSON on a real board looks exactly like a fact, propagates into the CRM, and
 * can end up in something Lucas sends to a client.
 *
 * So the roster is captured by ASKING for it and its origin together, in one narrow question with a
 * strict per-line shape, and every line is then checked against something we independently know.
 *
 * ── THE FOUR CHECKS (three inherited, one new) ────────────────────────────────────────────────
 *
 *   1. SHAPE      — every member on ONE line in a fixed order. No prose salvaging.
 *   2. PLAUSIBLE  — the NAME must look like a person's name, not a role, a place, or page furniture
 *                   ("Board Members", "Contact Us", "Fulton County"). This check is the new one and
 *                   it exists because page-scraped rosters are full of headings.
 *   3. PROVENANCE — the cited URL's host must be one the run actually visited (inherited verbatim
 *                   from cardinality_capture, including the subdomain rule).
 *   4. SANITY     — a roster wildly larger than any real board is page-furniture noise, not a body.
 *
 * Pure functions only; no db, no network. The caller runs the pass and does the storing.
 */
'use strict';

const cap = require('./cardinality_capture');

const MAX_MEMBERS = 60;          // larger than any county board; beyond this we scraped a directory
// Words that mean "this line is not a person". Page furniture is the dominant failure of any
// roster scrape — headings and nav links sit in exactly the place a name would.
const NOT_A_NAME = /^(?:board|council|commission|committee|members?|staff|officials?|contact|home|about|meetings?|agenda|minutes|elections?|department|office|county|city|town|district|search|menu|skip to|read more|learn more|click|email|phone|address|the\b.*\bboard)\b/i;
// A PLACE or an ORGAN wearing name shape — "Fulton County", "Springfield Township", "Elections
// Office". The leading-word list above cannot catch these: the furniture word is at the END.
// Nobody's surname is "County", so a trailing jurisdiction/organ word is decisive.
const TRAILING_FURNITURE = /\b(?:county|parish|borough|township|city|town|village|district|department|division|board|commission|council|committee|office|authority|agency|bureau|court|school|university|institute|center|centre)\s*$/i;

// A person's name: 2-5 words, each starting with a letter, allowing initials, hyphens, apostrophes,
// particles (van/de/bin), and suffixes. Deliberately permissive about ORIGIN of the name and strict
// about SHAPE — the goal is to reject "Board Members", not to police what names may look like.
function looksLikeName(s) {
  const n = String(s || '').replace(/\s+/g, ' ').trim().replace(/[,.]+$/, '');
  if (n.length < 4 || n.length > 70) return false;
  if (NOT_A_NAME.test(n) || TRAILING_FURNITURE.test(n)) return false;
  if (/\d/.test(n)) return false;                                  // "District 3" is a seat, not a person
  if (/[@/:]|https?/i.test(n)) return false;                       // an address or URL
  const words = n.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;          // mononyms are almost always furniture
  return words.every((w) => /^[A-Za-z][A-Za-z'’.\-]*$/.test(w));
}

// The narrow question. One roster, one shape, an explicit escape hatch, and the reason the escape
// hatch is safe stated plainly — a pass that cannot answer must be able to say so cheaply, or it
// will invent people to fill the format.
function buildPrompt(body) {
  return `You are recording the CURRENT membership of ${body} — the people who hold its seats right now.

This is a CITATION task, not a research summary. Report ONLY people you can point at on a page you actually opened.

Reply with ONE LINE PER PERSON, in exactly this shape, and nothing else:
MEMBER: <full name> | <role, or "Member"> | <district or seat label, or "-"> | <source URL of the page listing them>

After the members, add these two lines:
LEVEL: <county | municipal | township | school_district | state | special_district | other>
FUNCTION: <governing | elections | school | judicial | planning | other>

If you did not open a page that lists the actual people, reply with exactly:
NOT FOUND

Rules: never write a name you did not read on a page you opened. Never fill a seat with a placeholder, a heading ("Board Members"), or a body/place name. Never cite a page you did not open. Omit anyone whose name you are unsure of. "NOT FOUND" is a correct and useful answer — an invented member is far worse than a missing one, because it looks exactly like a fact and will be treated as one.`;
}

// Parse + fully vet a reply. Returns { ok:false, reason } or { ok:true, members[], level, function }.
// Every rejection carries a reason: a silent skip is indistinguishable from "this body has no
// published roster", which is precisely the ambiguity this module exists to end.
function parseCapture(answer, { visited = [] } = {}) {
  const ans = String(answer || '').trim();
  if (!ans) return { ok: false, reason: 'empty reply' };
  if (/\bNOT\s*FOUND\b/i.test(ans) && !/^\s*MEMBER:/im.test(ans)) {
    return { ok: false, reason: 'not found (honest refusal)', refused: true };
  }
  const lines = [...ans.matchAll(/^\s*MEMBER:\s*([^\n]+)$/gim)].map((m) => m[1]);
  if (!lines.length) return { ok: false, reason: 'no MEMBER lines — reply did not follow the shape' };
  if (lines.length > MAX_MEMBERS) return { ok: false, reason: `${lines.length} "members" — a directory page, not a board roster` };

  const seen = cap.visitedHosts(visited);
  const members = []; const rejected = [];
  for (const raw of lines) {
    const parts = String(raw).split('|').map((p) => p.trim());
    const [name, role, district, url] = [parts[0], parts[1], parts[2], parts[3]];
    if (!looksLikeName(name)) { rejected.push({ line: raw.slice(0, 60), why: 'not a person name' }); continue; }
    if (!url) { rejected.push({ line: raw.slice(0, 60), why: 'no source URL' }); continue; }
    const sourceUrl = url.replace(/[)\]>.,]+$/, '');
    const kind = cap.classifySource(sourceUrl);
    if (!kind) { rejected.push({ line: raw.slice(0, 60), why: 'source is not a usable URL' }); continue; }
    // THE ANTI-FABRICATION CHECK, inherited verbatim: only enforced when we know where the run went.
    if (seen.size) {
      const cited = cap.hostOf(sourceUrl);
      if (!cap.hostMatches(cited, seen)) { rejected.push({ line: raw.slice(0, 60), why: `cited host "${cited}" never visited` }); continue; }
    }
    members.push({
      personName: String(name).replace(/\s+/g, ' ').trim(),
      role: role && role !== '-' ? role.slice(0, 80) : 'Member',
      district: district && district !== '-' ? district.slice(0, 60) : null,
      sourceUrl: sourceUrl.slice(0, 300),
      // 'official' → the body speaking about itself; the store grades on this.
      sourceKind: kind === 'official' ? 'official' : 'news',
      confidence: kind === 'official' ? 0.9 : 0.6,
    });
  }
  if (!members.length) return { ok: false, reason: `every MEMBER line failed vetting (${rejected.slice(0, 3).map((r) => r.why).join('; ')})`, rejected };

  const lv = (ans.match(/^\s*LEVEL:\s*([a-z_]+)\s*$/im) || [])[1] || 'other';
  const fn = (ans.match(/^\s*FUNCTION:\s*([a-z_]+)\s*$/im) || [])[1] || 'other';
  return { ok: true, members, level: lv, function: fn, rejected };
}

module.exports = { looksLikeName, buildPrompt, parseCapture, MAX_MEMBERS, NOT_A_NAME, TRAILING_FURNITURE };
