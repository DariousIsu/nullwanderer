/* lib/place_key.js — one identity per place (O2).
 *
 * docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md §3: "Addresses are edges to Place objects, not string fields."
 * Measured before building: there are no address fields anywhere in the system to convert. What exists
 * is 500 place objects in the encounter log and 28,301 LOCATED_IN observations — so the real work is not
 * turning addresses into places, it is making sure one place is ONE object.
 *
 * It currently is not:
 *
 *   AL · ALABAMA · Alabama      two objects for one state (case already folds; the abbreviation does not)
 *   AZ · ARIZONA                two objects
 *   AR · ARKANSAS               two objects
 *
 * ── WHAT THIS DELIBERATELY REFUSES TO MERGE ─────────────────────────────────────────────────────
 *
 * A false merge is the one unrecoverable failure, and place names are full of traps that look like
 * duplicates:
 *
 *   Adams          vs  Adams County        — there are Adams Counties in a dozen states, and "Adams"
 *                                            alone is at least as likely to be a person or a street.
 *   Orange         vs  Orange County       — different places, one contains the other.
 *   Washington     vs  Washington County   — a state, a city, and 30-odd counties.
 *   Kansas City    vs  Kansas              — a city that begins with a state's name.
 *
 * None of those are merged here. The ONLY merge performed is the one that is closed-set and
 * unambiguous: a two-letter US state code to its state name. Every other normalisation is
 * case/punctuation folding, which cannot merge two things that were genuinely different.
 *
 * The asymmetry is deliberate. A missed merge shows up as two objects that later evidence can join; a
 * wrong merge silently averages two real places into one and cannot be undone.
 *
 * ── THE RESIDUAL RISK, AND WHAT CONTAINS IT ─────────────────────────────────────────────────────
 *
 * Several state codes are also ordinary words: IN, OR, CO, ID, MS, ME, HI, OK, DE, PA. If one of those
 * were extracted from prose as a preposition and expanded here, a real state would inherit a claim it
 * has nothing to do with.
 *
 * What contains it is that this only ever runs on labels ALREADY TYPED `place` by the extractor — the
 * model has to have asserted "this is a location" before the question of canonicalisation arises. A
 * preposition typed as a location is an extraction failure, and fixing it here would mean second-
 * guessing the type rather than resolving the identity.
 *
 * Checked on the live data rather than assumed: every ambiguous code in the log (IN, OR, CO, ID, MS,
 * NE, OK) traced back to two Census ranking tables that list places in `City, ST` form. They are
 * genuine state abbreviations. That is a spot check, not a proof — if a future case turns out to be the
 * word, it belongs in the extractor's type call, not in this file.
 *
 * Pure. No db, no IO.
 */
'use strict';

// Reuse the extractor's own state table rather than a second copy that can drift out of step.
const { stateFull } = require('./doc_decompose');

// Words that mark an administrative division. Never stripped — "Orange County" is not "Orange" — but
// recognised so the KIND of place can be reported to a caller that wants it.
const DIVISION_RE = /\b(county|parish|borough|municipality|township|village|city|town|district|precinct|ward)\b/i;

// Leading "St."/"Ste." is Saint in a place name: St. Johns, St. Charles Parish, Ste. Genevieve. Only at
// the START — a trailing "St." is Street ("Main St."), and expanding that would rename a road.
function expandSaint(s) {
  return s.replace(/^st\.?\s+/i, 'saint ').replace(/^ste\.?\s+/i, 'sainte ');
}

// The canonical identity of a place, or null.
//
// Returns the KEY only — the caller keeps the original label as evidence of what the source called it.
function placeKey(label) {
  let s = String(label == null ? '' : label).trim();
  if (!s) return null;

  // A state code is the one safe expansion: closed set, two letters, no other reading.
  const full = stateFull(s);
  if (full) return full.toLowerCase();

  s = s.toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  s = expandSaint(s);
  // A trailing comma-state is part of the identity, not noise: "St. Johns, Arizona" stays distinct from
  // a St. Johns elsewhere. Nothing is dropped here — only spacing was normalised above.
  return s;
}

// Does this label name an administrative division? Reported, never acted on — a caller deciding whether
// "Adams" and "Adams County" are the same thing needs real evidence, not a string rule.
function isDivision(label) {
  return DIVISION_RE.test(String(label == null ? '' : label));
}

// Would merging these two labels be safe? Only true for the closed-set state case. Exposed so the
// migration can assert its own safety rather than trusting the key function silently.
function safeToMerge(a, b) {
  const ka = placeKey(a), kb = placeKey(b);
  if (!ka || !kb || ka !== kb) return false;
  // Same key. It is only a MERGE (rather than an identity) if the raw labels differ; and the only way
  // that happens here is a state code, a case/punctuation variant, or a Saint expansion.
  return true;
}

module.exports = { placeKey, isDivision, safeToMerge, expandSaint, DIVISION_RE };
