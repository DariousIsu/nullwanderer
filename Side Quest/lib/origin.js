/* lib/origin.js — WHERE DID THIS COME FROM? The independence primitives.
 *
 * Blocker #2 from docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md. The `documents` table recorded a document's
 * LANE (`browser_download`, `news`, `research`) but never its ORIGIN — 0 of 77 research documents
 * carried a URL. So `min(distinct origins, distinct texts)` could only ever evaluate half of itself,
 * and every fact ingested was permanently ungradeable: origin cannot be reconstructed after the fact.
 *
 * Blocker #1 is the other half and is solved by the same module. The corpus was measured at 11.6%
 * byte-identical duplicates (461 groups, 771 redundant copies, one PDF stored 18 times), and that was
 * ALREADY inflating corroboration — a person showing `doc_count: 5` from only 3 distinct texts. Content
 * hashing collapses those to one origin.
 *
 * ── THE FORMULA IS NOT NEW ─────────────────────────────────────────────────────────────────────
 *
 * `independence()` is lib/news_brief.js's corroboration rule, lifted out of the news lane and made
 * general: min(distinct origins, distinct texts). Bounded by BOTH, so neither syndication (ten outlets
 * carrying one wire story) nor repetition (one outlet publishing ten times) can inflate it. It was
 * already correct there; it just wasn't available to anything else.
 *
 * TWO SOURCES ARE INDEPENDENT WHEN THEY COULD HAVE BEEN WRONG SEPARATELY. Same host = same origin, so
 * a claim repeated across five pages of one website counts once. That is deliberately strict: over-
 * counting independence inflates grades, and an inflated grade is worse than a missing one because it
 * looks rigorous.
 *
 * Pure. No db, no IO.
 */
'use strict';

const crypto = require('crypto');

// Tracking parameters carry no meaning and would split one origin into many.
const JUNK_PARAMS = /^(utm_|fbclid$|gclid$|mc_[ce]id$|_hs|ref$|ref_src$|igshid$|si$|s$|source$|campaign)/i;

// The normalised host — the independence key. www is not a different publisher.
function hostOf(url) {
  try {
    const u = new URL(String(url || '').trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch { return null; }
}

// A stable URL: scheme+host+path+meaningful query, no fragment, no tracking junk. Two links to the same
// page with different campaign tags must normalise to one origin, or one source counts as several.
function normalizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    const keep = [...u.searchParams.entries()].filter(([k]) => !JUNK_PARAMS.test(k));
    u.search = '';
    for (const [k, v] of keep.sort((a, b) => a[0].localeCompare(b[0]))) u.searchParams.append(k, v);
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch { return null; }
}

// Content identity. Whitespace-normalised and case-folded so trivial reformatting doesn't read as a
// second independent text — the duplicates measured in the corpus are byte-identical, but a re-save
// with different line endings must not defeat this.
function contentHash(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!s) return null;
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
}

// CORROBORATION, generalised from lib/news_brief.js:33.
//
// `items` = [{ origin|origin_host, hash|content_hash }]. Returns the count plus the parts, because a
// caller usually needs to know WHY it was bounded — `syndicated` (many origins, one text) and
// `repeated` (one origin, many texts) are different problems with different fixes.
//
// Items missing BOTH keys are counted as one unattributable origin each: we cannot show they are
// independent, and we cannot show they are not. That is the conservative direction — it can only
// lower a grade, never inflate one.
function independence(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return { count: 0, origins: 0, texts: 0, syndicated: false, repeated: false };
  const origins = new Set(), texts = new Set();
  let unattributed = 0;
  for (const it of list) {
    const o = it.origin_host || hostOf(it.origin) || null;
    const h = it.content_hash || it.hash || null;
    if (o) origins.add(o);
    if (h) texts.add(h);
    if (!o && !h) unattributed += 1;
  }
  const o = origins.size + unattributed;
  const t = texts.size + unattributed;
  const count = Math.min(o, t);
  return {
    count,
    origins: o,
    texts: t,
    syndicated: o > count && count > 0,   // many origins, one text — a wire story
    repeated: t > count && count > 0,     // one origin, many texts — a site repeating itself
  };
}

module.exports = { hostOf, normalizeUrl, contentHash, independence, JUNK_PARAMS };
