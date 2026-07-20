/* lib/body_key.js — a STABLE identity for a researched body, across changes to how we name it.
 *
 * Why this exists. `absence` and `cardinality` are keyed by the target string we happened to research
 * under. When commit 0ce3945 stopped worklists asserting invented body titles, every county/municipal/
 * township/school target was renamed — "Parish Council of Acadia Parish, Louisiana" became "the
 * governing body of Acadia Parish, Louisiana". The facts we had recorded about those bodies were
 * suddenly filed under keys nothing would ever look up again: unreachable, never refreshable, never
 * closable, and permanently listed as "due for re-attempt" in the gap report.
 *
 * ── WHY NOT REUSE beats.targetPlaceKey ─────────────────────────────────────────────────────────
 *
 * That is the obvious candidate and it is DANGEROUS here. It takes the segment after the last " of ",
 * which is exactly right for "the governing body of Lee County, Florida" → "lee", and catastrophic for
 * a chamber: "Oregon House of Representatives" and "Pennsylvania House of Representatives" BOTH reduce
 * to "representatives". Every state's House would share one absence row and their gaps would merge into
 * a single meaningless record. Verified before writing this, not assumed.
 *
 * So this does the opposite of guessing: it strips ONLY the body-label prefixes this codebase itself
 * generates (current and legacy), and leaves everything else untouched. A name we did not construct
 * passes through unchanged, which is the safe failure — an unrecognised name keeps its own identity
 * rather than being merged into someone else's.
 *
 * Pure. No db, no IO.
 */
'use strict';

// Prefixes this codebase has generated, longest first so "the municipal governing body of " is matched
// before "the governing body of ". Current forms and every legacy form from before 0ce3945 — the legacy
// ones must stay forever, because rows written under them still exist.
const BODY_PREFIXES = [
  // current (post-0ce3945)
  'the municipal governing body of ',
  'the township governing body of ',
  'the town governing body of ',
  'the governing body of ',
  'the school board of ',
  // legacy county-equivalent
  'board of county commissioners of ',
  'borough and census area government of ',
  'municipality assembly of ',
  'municipal government of ',
  'borough assembly of ',
  'parish council of ',
  'city council of ',
  // legacy municipal / township
  'charter township board of trustees of ',
  'township board of trustees of ',
  'plantation board of assessors of ',
  'town board / select board of ',
  'municipal council of ',
  'township board of ',
  'borough council of ',
  'village board of ',
  'town council of ',
  // legacy school
  'board of education of ',
];

// Strip a generated prefix, then normalise punctuation/case/whitespace. Nothing is inferred: if no
// known prefix matches, only the cosmetic normalisation applies.
function normalizeBody(name) {
  let s = String(name || '').trim().toLowerCase();
  if (!s) return '';
  for (const p of BODY_PREFIXES) {
    if (s.startsWith(p)) { s = s.slice(p.length); break; }   // one prefix only — they do not nest
  }
  return s.replace(/[^a-z0-9]+/g, ' ').trim();
}

// Do two names refer to the same body?
function sameBody(a, b) {
  const na = normalizeBody(a);
  return !!na && na === normalizeBody(b);
}

module.exports = { BODY_PREFIXES, normalizeBody, sameBody };
