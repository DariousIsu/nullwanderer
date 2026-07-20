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

// ── ORIGIN IS THE FIRST HIGH-QUALITY SOURCE (Lucas, 2026-07-20) ───────────────────────────────────
//
// Measured the moment origin capture started working: three Apache County official documents — a notary
// list, a public-records form, a road-work notice — recorded their origin as
// `ecs-cluster-bucket-wsos-prod-two.s3.us-west-2.amazonaws.com`. That is where the BYTES lived. It is
// not who published them.
//
// Storing the bucket breaks grading in both directions at once:
//   - authority: a genuinely official record grades `unknown` instead of official, so it never earns
//     the +1 that a lone local government document can never get any other way.
//   - independence: that bucket serves many client sites (the path was `/uploads/sites/107/`), so two
//     DIFFERENT counties would share one origin_host and count as ONE source. `min(origins, texts)`
//     exists to stop inflation; here the same key would deflate genuinely independent publishers.
//
// So origin walks the chain and takes the first source that is a PUBLISHER. A CDN, an object store or a
// site-builder's asset domain is infrastructure — it carries no authority and asserts nothing.
const COMMODITY_HOST = new RegExp([
  '(^|\\.)s3[.-][a-z0-9-]*\\.amazonaws\\.com$', '(^|\\.)s3\\.amazonaws\\.com$',
  '(^|\\.)amazonaws\\.com$', '(^|\\.)cloudfront\\.net$', '(^|\\.)blob\\.core\\.windows\\.net$',
  '(^|\\.)storage\\.googleapis\\.com$', '(^|\\.)googleusercontent\\.com$',
  '(^|\\.)digitaloceanspaces\\.com$', '(^|\\.)r2\\.dev$', '(^|\\.)backblazeb2\\.com$',
  '(^|\\.)akamaized\\.net$', '(^|\\.)fastly\\.net$', '(^|\\.)cdn\\.[a-z0-9-]+\\.[a-z]{2,}$',
  '(^|\\.)wixstatic\\.com$', '(^|\\.)squarespace-cdn\\.com$', '(^|\\.)shopifycdn\\.com$',
  '(^|\\.)files\\.wordpress\\.com$', '(^|\\.)dropboxusercontent\\.com$',
  '(^|\\.)sharepoint\\.com$', '(^|\\.)docs\\.google\\.com$', '(^|\\.)drive\\.google\\.com$',
].join('|'), 'i');

// Infrastructure, not a publisher. Nothing about a claim's authority follows from living here.
function isCommodityHost(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!h) return false;
  return COMMODITY_HOST.test(h);
}

// Pick the origin from a provenance chain, ordered nearest-the-bytes first: [fetchUrl, referringPage, …].
//
// Returns the first entry published by a real host. When EVERY link is commodity infrastructure there is
// no publisher to name, so the fetch URL stands — better a weak origin honestly labelled than none.
// Returns { origin, host, commodity } so a caller can tell "this is the publisher" from "this is only
// where the bytes were", which is the difference between an official grade and an unknown one.
function pickOrigin(chain) {
  const list = (Array.isArray(chain) ? chain : [chain]).map((u) => normalizeUrl(u)).filter(Boolean);
  if (!list.length) return { origin: null, host: null, commodity: false };
  for (const u of list) {
    const h = hostOf(u);
    if (h && !isCommodityHost(h)) return { origin: u, host: h, commodity: false };
  }
  const u = list[0];
  return { origin: u, host: hostOf(u), commodity: true };
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
// UNKNOWNS COLLAPSE TO ONE, they do not vanish and they do not multiply.
//
// Most of the existing corpus has a content hash but no origin (origin was never captured before this
// module; it is unrecoverable for those documents). Two wrong ways to handle that, both of which this
// got wrong before being run on real data:
//   - counting them as ZERO origins makes min() zero, so three genuinely distinct documents report as
//     NO evidence at all. That is not conservative, it is false: it grades a well-attested legacy fact
//     as unsupported rather than unproven.
//   - counting them as one origin EACH inflates — three documents of unknown provenance could all be
//     copies from the same site.
// The truth is "at least one, possibly more, unprovable": all unknown-origin items collapse into a
// single unattributable origin. Same for missing hashes. So evidence is never erased and never
// invented, and capturing real origins can only ever RAISE a count from that floor.
function independence(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return { count: 0, origins: 0, texts: 0, syndicated: false, repeated: false, unproven: false };
  const origins = new Set(), texts = new Set();
  let anyOriginMissing = false, anyHashMissing = false;
  for (const it of list) {
    const o = it.origin_host || hostOf(it.origin) || null;
    const h = it.content_hash || it.hash || null;
    if (o) origins.add(o); else anyOriginMissing = true;
    if (h) texts.add(h); else anyHashMissing = true;
  }
  const o = origins.size + (anyOriginMissing ? 1 : 0);
  const t = texts.size + (anyHashMissing ? 1 : 0);
  const count = Math.min(o, t);
  return {
    count,
    origins: o,
    texts: t,
    syndicated: o > count && count > 0,   // many origins, one text — a wire story
    repeated: t > count && count > 0,     // one origin, many texts — a site repeating itself
    // The count is held down by missing provenance rather than by real duplication — capturing origin
    // for these would raise it. Distinguishes "we checked and it is one source" from "we cannot tell".
    unproven: anyOriginMissing && t > o,
  };
}

// SYNCHRONY IS A FLAG, NOT CORROBORATION (Lucas: "if all outlets say the same thing at the same time
// that should be a major flag"). §6 rule 1, and until now it was the one part of independence nothing
// computed.
//
// independence() catches identical TEXT. It cannot catch ten outlets each re-wording one press release
// within the hour — those score min(10,10)=10 and read as overwhelming corroboration. Measured on the
// live news corpus: of 599 events reaching 3+ independent sources, 78 published inside ONE HOUR and 380
// inside six. Those are wire pickups and network republication (States Newsroom, Advance Local), not
// ten newsrooms independently confirming a fact.
//
// This REPORTS rather than reduces. A simultaneous burst is sometimes exactly right — a scheduled
// announcement really is reported by everyone at once — so the count stays honest and the caller is
// told the sources were not temporally independent. Deciding what that is worth is a grading policy
// question, not an arithmetic one.
//
// `items` = [{ observed_at }]. Undated items are ignored rather than treated as simultaneous.
const SYNCHRONY_WINDOW_MS = 60 * 60 * 1000;
function synchrony(items, { windowMs = SYNCHRONY_WINDOW_MS } = {}) {
  const ts = (Array.isArray(items) ? items : []).filter(Boolean)
    .map((i) => i.observed_at).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (ts.length < 2) return { dated: ts.length, spanMs: null, simultaneous: false };
  const spanMs = ts[ts.length - 1] - ts[0];
  return {
    dated: ts.length,
    spanMs,
    // Three or more is where a burst starts meaning something; two things landing together is ordinary.
    simultaneous: ts.length >= 3 && spanMs < windowMs,
  };
}

module.exports = { hostOf, normalizeUrl, contentHash, independence, isCommodityHost, pickOrigin, synchrony, JUNK_PARAMS, COMMODITY_HOST, SYNCHRONY_WINDOW_MS };
