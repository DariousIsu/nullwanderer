'use strict';
/**
 * lib/confidence_decay.js — C4 of the confidence engine (see
 * docs/AUTONOMOUS_SELF_CURATING_DB_ARCHITECTURE.md §Step-2).
 *
 * A verified fact does not stay true forever. A CEO/employment/office edge goes
 * stale in a couple of years; a birthplace never does. So confidence DECAYS
 * with age since last verification, at a PER-PREDICATE half-life — and when the
 * decayed value falls below a floor, the fact drops into a re-verify queue
 * (the loop's "chase a fresh citation" work-list) instead of silently rotting.
 *
 * Pure + deterministic (age is passed in — no clock here, so it stays
 * offline-smoke-testable and Workflow-safe). Confidence(t) =
 * conf0 · 0.5^(ageDays / halfLife); an immutable predicate has halfLife=∞ → no
 * decay.
 */

const DAY = 1; // half-lives are expressed in days

// Volatile: a role/office/employment that turns over every few years.
const FAST = 550 * DAY;      // ~1.5yr half-life
// Membership / location / affiliation — changes, but slowly.
const MEDIUM = 1825 * DAY;   // ~5yr half-life
// Immutable historical fact — never decays.
const IMMUTABLE = Infinity;

const PREDICATE_HALFLIFE = {
  // fast — positions/roles/events
  WORKS_FOR: FAST, HAS_CEO: FAST, HAS_CHAIR: FAST, LEADS: FAST, DIRECTED_BY: FAST,
  HOLDS_OFFICE: FAST, HOLDS_OFFICE_IN: FAST, HELD_OFFICE: FAST, REPRESENTED: FAST,
  APPOINTED: FAST, RESPONSIBLE_FOR: FAST, MET_WITH: FAST, ATTENDED: FAST, PARTICIPATED_IN: FAST,
  // medium — membership/place/affiliation/policy stance
  MEMBER_OF: MEDIUM, LOCATED_IN: MEDIUM, PART_OF: MEDIUM, SUBSIDIARY_OF: MEDIUM, AFFILIATE_OF: MEDIUM,
  FOCUSES_ON: MEDIUM, FUNDS: MEDIUM, SUPPORTS: MEDIUM, OPPOSES: MEDIUM, SPONSORED: MEDIUM,
  AFFECTS: MEDIUM, REGULATES: MEDIUM, CITES: MEDIUM, RELATED_TO: MEDIUM,
  // immutable — historical/biographical constants
  BORN_IN: IMMUTABLE, DIED_IN: IMMUTABLE, FOUNDED: IMMUTABLE, PARENT_OF: IMMUTABLE,
  CREATED: IMMUTABLE, SUCCEEDS: IMMUTABLE, PRECEDES: IMMUTABLE, MARRIED_TO: IMMUTABLE,
};
const DEFAULT_HALFLIFE = MEDIUM;

function halfLifeDays(predicate) {
  const p = String(predicate == null ? '' : predicate).trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(PREDICATE_HALFLIFE, p) ? PREDICATE_HALFLIFE[p] : DEFAULT_HALFLIFE;
}

// Confidence after `ageDays` since last verification, for this predicate.
function decayedConfidence(conf0, predicate, ageDays) {
  const c = Number(conf0);
  if (!(c > 0)) return 0;
  const age = Math.max(0, Number(ageDays) || 0);
  const hl = halfLifeDays(predicate);
  if (!isFinite(hl)) return c;                 // immutable → no decay
  return c * Math.pow(0.5, age / hl);
}

// A fact whose decayed confidence has fallen below `floor` needs re-verification.
function needsReverify(conf0, predicate, ageDays, floor = 0.5) {
  return decayedConfidence(conf0, predicate, ageDays) < Number(floor);
}

/**
 * Build the re-verify work-list from a set of facts.
 *   facts: [{ id?, predicate, confidence, ageDays }]
 *   opts:  { floor=0.5 }
 * Returns the below-floor facts, each annotated with `decayed`, worst-first
 * (lowest decayed confidence chased first).
 */
function reverifyQueue(facts, { floor = 0.5 } = {}) {
  const out = [];
  for (const f of (Array.isArray(facts) ? facts : [])) {
    const decayed = decayedConfidence(f.confidence, f.predicate, f.ageDays);
    if (decayed < floor) out.push({ ...f, decayed });
  }
  out.sort((a, b) => a.decayed - b.decayed);
  return out;
}

module.exports = {
  FAST, MEDIUM, IMMUTABLE, PREDICATE_HALFLIFE, DEFAULT_HALFLIFE,
  halfLifeDays, decayedConfidence, needsReverify, reverifyQueue,
};
