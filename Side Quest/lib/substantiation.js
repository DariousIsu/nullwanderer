'use strict';
/**
 * lib/substantiation.js — the SUBSTRATE classifier for the substantiation-grading pipeline
 * (docs/SUBSTANTIATION_GRADING_DESIGN.md §4, LOCKED 2026-07-15; docs/SUBSTANTIATION_IMPL_PLAN.md Slice 1).
 *
 * Two orthogonal axes every node/observation carries:
 *   substantiation_state ∈ { source-vouched, identity-confirmed, unsubstantiated }   (design §4.2)
 *   frame                ∈ real | fiction:<work> | domain:<x>                          (design §4.5)
 *
 * The load-bearing reframe (Lucas 2026-07-15): STATE IS NOT A GATE. It decides WHERE a node lives —
 * anything substantiated (source-vouched OR identity-confirmed) flows short→long, graded on the way, with
 * grade riding along as EXPLORE-PRIORITY (a LOW grade = higher priority to dig, never a rejection). Only
 * `unsubstantiated` stays short-term, to be proven or to fade (TTL→archive, Slice 6). News self-vouches
 * (the story is the substantiation); a decomposed document IS its own citation; fiction is real to its
 * fiction. A thin BOTTOM FLOOR (junk/spoofed source) is the one thing that can't promote (decision #1).
 *
 * PURE — no I/O, no db, no model, no clock — so it's exhaustively offline-smoke-testable. Every downstream
 * slice that gates (Slice 3), mints endpoints (Slice 2), walls intake (Slice 5), or fades (Slice 6) reads
 * these two fields; this module is the single place that assigns them.
 */

const { isJunkSource } = require('./curation_gate');   // shared host blocklist (the bottom-floor test)

const SOURCE_VOUCHED = 'source-vouched';
const IDENTITY_CONFIRMED = 'identity-confirmed';
const UNSUBSTANTIATED = 'unsubstantiated';
const SUBSTANTIATION_STATES = [SOURCE_VOUCHED, IDENTITY_CONFIRMED, UNSUBSTANTIATED];

// Feeds whose SOURCE self-vouches the claim: the news story IS the substantiation, a decomposed document
// IS the citation (its url is a `docstore:`/`download:` pointer, not an external site), a fiction work is
// real to its fiction. A claim from one of these is source-vouched by its own provenance — it does NOT
// need an external identity match — SO LONG AS it actually carries that provenance pointer.
const SELF_VOUCHING_FEEDS = new Set(['news', 'news-lane', 'news-daily', 'doc-decomp', 'doc-cards', 'fiction']);

const FRAME_REAL = 'real';
// Named TOPIC-domains that flooded the graph (the 2026-07-13 medical/dental directory dump; legal directory
// dumps). These frame tags drive the Slice-5 HARD wall: intake vetoes a named-flood frame UNLESS it is the
// operator's active domain. Everything NOT on this list is soft-framed — never door-rejected, only faded/
// prioritized. Add a domain here only when it has demonstrably flooded; the default is "let it in + mark".
const NAMED_FLOOD_FRAMES = ['domain:medical', 'domain:legal-directory'];

// NAMED-FLOOD detectors (Slice 5): the directory-dump shapes that flooded the KG. CONSERVATIVE by design — a
// frame is assigned only on a DENSITY of markers (the roster/directory shape), not a single civic mention of
// "hospital" or "attorney" — so a civic health-policy bill or a court filing stays `real` and is never walled.
const _MEDICAL_MARKERS = ['medical', 'dental', 'dentist', 'dentistry', 'orthodont', 'physician', 'clinic', 'hospital', 'patient', 'medicaid', 'medicare', 'nursing', 'pharmacy', 'pharmacist', 'healthcare', 'dermatolog', 'pediatric', 'radiolog', 'oncolog', 'cardiolog', 'practitioner', 'npi', 'dds'];
const _LEGAL_DIR_MARKERS = ['attorney', 'lawyer', 'law firm', 'law office', 'paralegal', 'bar association', 'esquire', 'litigation', 'barrister', 'solicitor'];
const _DIRECTORY_SIGNAL = ['directory', 'provider', 'roster', 'listing', 'faculty', 'find a doctor', 'find a provider'];
function _countMarkers(hay, markers) { let n = 0; for (const m of markers) if (hay.includes(m)) n++; return n; }

// A REAL external citation: an http(s) URL from a non-junk host. `docstore:`/`download:` pointers are NOT
// external citations — they're handled via the self-vouching-feed path (the document itself is the source).
function isRealSourceUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!/^https?:\/\//i.test(s)) return false;
  return !isJunkSource(s);
}
function hasRealHttpSource({ url = null, sources = null } = {}) {
  if (isRealSourceUrl(url)) return true;
  if (Array.isArray(sources)) {
    for (const s of sources) {
      const u = (s && (s.url || s.link)) || (typeof s === 'string' ? s : null);
      if (isRealSourceUrl(u)) return true;
    }
  }
  return false;
}
function hasAnyProvenance({ url = null, sources = null } = {}) {
  if (String(url == null ? '' : url).trim()) return true;
  return Array.isArray(sources) && sources.length > 0;
}

/**
 * Classify the substantiation STATE from what's known about a node/observation. PURE.
 *   resolved      true  → the entity matched an EXISTING known node (Echo/wiki resolve) → identity-confirmed
 *   status              → an observation already marked `held` couldn't land → unsubstantiated
 *   feed                → a SELF_VOUCHING_FEED source-vouches on its own provenance pointer
 *   url / sources       → a non-junk http(s) citing source source-vouches
 *   selfVouching  bool  → explicit override (e.g. the fiction lane)
 * Precedence: identity-confirmed (a known real thing) > source-vouched (a source stands behind it) >
 * unsubstantiated (a bare mention we can neither identify nor source — short-term, prove-or-fade).
 */
function classifySubstantiation({ resolved = false, status = null, feed = null, url = null, sources = null, selfVouching = false } = {}) {
  if (resolved === true) return IDENTITY_CONFIRMED;
  const st = String(status == null ? '' : status).trim().toLowerCase();
  if (st === 'held') return UNSUBSTANTIATED;   // the endpoint/existence couldn't be substantiated into the graph
  const f = String(feed == null ? '' : feed).trim().toLowerCase();
  if ((selfVouching || SELF_VOUCHING_FEEDS.has(f)) && hasAnyProvenance({ url, sources })) return SOURCE_VOUCHED;
  if (hasRealHttpSource({ url, sources })) return SOURCE_VOUCHED;
  return UNSUBSTANTIATED;
}

// Is a node/observation substantiated (belongs long-term, subject to the junk bottom-floor)? A convenience
// the promotion inversion (Slice 3) reads: substantiated ⇔ NOT unsubstantiated.
function isSubstantiated(state) {
  const s = String(state == null ? '' : state).trim().toLowerCase();
  return s === SOURCE_VOUCHED || s === IDENTITY_CONFIRMED;
}

/**
 * Classify the FRAME of an intake. Slice 1 assigns `real` for civic/news/doc feeds; a `fiction` hint yields
 * a `fiction:<work>` frame. The `domain:<x>` detection + the flood wall it drives are Slice 5 (this keeps
 * the surface stable so Slice 5 only has to fill the detector, not thread a new field everywhere). PURE.
 */
function classifyFrame({ url = null, feed = null, text = null, title = null, fiction = null } = {}) {
  if (fiction) {
    const work = String(fiction).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return work ? `fiction:${work}` : FRAME_REAL;
  }
  const hay = `${String(title == null ? '' : title)} ${String(text == null ? '' : text)}`.toLowerCase();
  if (hay.trim()) {
    const dir = _countMarkers(hay, _DIRECTORY_SIGNAL);
    const med = _countMarkers(hay, _MEDICAL_MARKERS);
    if (med >= 3 || (med >= 2 && dir >= 1)) return 'domain:medical';               // a medical directory dump
    const leg = _countMarkers(hay, _LEGAL_DIR_MARKERS);
    if (leg >= 3 || (leg >= 2 && dir >= 1)) return 'domain:legal-directory';       // a legal directory dump
  }
  return FRAME_REAL;
}

function isNamedFloodFrame(frame) {
  const f = String(frame == null ? '' : frame).trim().toLowerCase();
  return NAMED_FLOOD_FRAMES.includes(f);
}
function isFictionFrame(frame) {
  return /^fiction:/i.test(String(frame == null ? '' : frame).trim());
}

module.exports = {
  SOURCE_VOUCHED, IDENTITY_CONFIRMED, UNSUBSTANTIATED, SUBSTANTIATION_STATES,
  SELF_VOUCHING_FEEDS, FRAME_REAL, NAMED_FLOOD_FRAMES,
  isRealSourceUrl, hasRealHttpSource, hasAnyProvenance,
  classifySubstantiation, isSubstantiated, classifyFrame, isNamedFloodFrame, isFictionFrame,
};
