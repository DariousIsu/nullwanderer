'use strict';
/**
 * lib/mint_type.js — T5: stop minting `concept` for things nobody typed. PURE.
 *
 * docs/OBJECT_TYPE_AND_IDENTITY_DESIGN.md §7 (T5) and §2a-i. This closes the source of the problem the
 * other T-slices have been cleaning up downstream.
 *
 * ── WHAT WAS ACTUALLY WRONG ─────────────────────────────────────────────────────────────────────
 *
 * Lucas asked whether a model decided those 13,033 types or a blind classification run did. Neither:
 *
 *     function recordEntity({ name, type = 'concept', … })      // graph_memory.js
 *     recordEntity({ name: sName, epistemic, proposedBy })      // recordRelation — no type argument
 *
 * `concept` is a JavaScript DEFAULT PARAMETER that the graph-walk's call site never overrides. Nothing
 * was classified, compared against existing nodes, or checked against Wikidata. `GENERAL MOTORS COMPANY`
 * was not judged to be a concept; it was never judged at all. And because a default is indistinguishable
 * from an assertion once written, the guard that would have upgraded it could never fire either.
 *
 * ── THE FIX: SAY "UNKNOWN" WHEN IT IS UNKNOWN ───────────────────────────────────────────────────
 *
 * An honest `unknown` is worth more than a confident `concept`, for one concrete reason: `unknown` is
 * VISIBLE. It shows up in an audit, it invites correction, and T3's grading ladder will overwrite it the
 * moment any source says otherwise. `concept` is a claim, and a claim that nobody made is the worst
 * possible input to a system whose whole premise is that evidence accumulates.
 *
 * Four rules, in order:
 *   1. THE CALLER KNOWS      an explicit type from an extractor is used as given. Zero inference.
 *   2. THE EVIDENCE KNOWS    T3 has a SETTLED type claim for this name → use it. This is the payoff of
 *                            type-as-a-claim: the mint gate asks what sources said instead of guessing.
 *   3. A STRONG ID PROVES IT IS NOT A CONCEPT   a concept does not have a lobbying-client id or a
 *                            bioguide code. 511 rows in the live data say otherwise. → `unknown`.
 *   4. OTHERWISE             `unknown`. Not `concept`.
 *
 * `concept` is still reachable — but only when a caller genuinely asserts it (rule 1), which is the
 * difference between a decision and a fallback.
 */

const { parseEntity } = require('./entity_match');

// The placeholders that mean "nobody has established this yet". Both are weak: a later real type
// upgrades either, and neither may ever overwrite a real type.
const UNKNOWN = 'unknown';
const PLACEHOLDER = new Set(['concept', UNKNOWN, '']);
const isPlaceholder = (t) => PLACEHOLDER.has(String(t == null ? '' : t).trim().toLowerCase());

function hasStrongId(name) {
  try { return Object.keys(parseEntity({ name }).ids || {}).length > 0; } catch { return false; }
}

/**
 * Decide what type to mint. `supplied` is what the caller passed, or null/undefined if it passed
 * nothing — the distinction a default parameter destroys, and the reason this takes it explicitly.
 *
 * `lookup` is injected so this stays pure and testable; callers pass object_type.typeOf.
 * Returns { type, why } — `why` so an audit can tell a decision from a fallback, which is precisely
 * what was impossible before.
 */
function decideType(name, supplied, { lookup = null } = {}) {
  const given = String(supplied == null ? '' : supplied).trim().toLowerCase();

  // 1. The caller actually knows. An extractor saying `government_body` is an assertion, not a guess.
  if (given && !isPlaceholder(given)) return { type: given, why: 'supplied' };

  // 2. Ask the evidence (T3). Only a SETTLED claim counts: a contested or single-C type is not something
  //    to stamp on a new object, because a mint is exactly where a wrong type becomes sticky.
  if (typeof lookup === 'function' && name) {
    try {
      const t = lookup(name);
      if (t && t.settled && t.type && !isPlaceholder(t.type)) return { type: t.type, why: `settled-claim(${t.grade})` };
    } catch { /* the claim store is advisory — minting must survive without it */ }
  }

  // 3. A strong identifier proves this is not a concept, even though we cannot say what it IS.
  if (name && hasStrongId(name)) return { type: UNKNOWN, why: 'strong-id: provably not a concept' };

  // 4. An explicit `concept` from a caller is still a real assertion and is honoured; an absent type is
  //    not turned into one.
  if (given === 'concept') return { type: 'concept', why: 'supplied' };
  return { type: UNKNOWN, why: 'nobody said' };
}

module.exports = { decideType, isPlaceholder, hasStrongId, UNKNOWN, PLACEHOLDER };
