/* studio/puller_confidence.js — Puller axis-1: contact QUALIFICATION (what gets sent). PURE.
 *
 * Conservative by mandate — whatever we send out gets used, so a contact's confidence is a
 * SEND-SAFETY statement, not a probability. It's governed by a deterministic CAPPED RATCHET over
 * an evidence-grade ladder: confidence = the cap of the highest-grade source present. Corroborating
 * sources are listed but never push the % past the cap. Only a grade-A (official dedicated source —
 * a business card, official directory, signed/owner-confirmed) unlocks 100%. A negative (bounce/
 * invalid) on the held value caps it down and flags a conflict (forcing re-derivation downstream).
 *
 * This is DISTINCT from the per-domain pattern belief (studio/puller_beliefs, a Beta used internally
 * to pick which pattern to derive). That number is never a contact's qualification.
 *
 * Ladder (mirrors the EA2030 handoff tiers 95/80/50/30 + an A tier on top + a negative floor):
 *   A official dedicated source ........ 100%   (business card / official directory / owner-confirmed)
 *   B independently verified ............  95%   (mail-server deliverable OR named in a primary source)
 *   C pattern-confirmed .................  80%   (company email format confirmed + applied)
 *   D best-guess ........................  50%   (real person at company, format defaulted)
 *   E generic / unconfirmed .............  30%   (shared mailbox, no person-specific evidence)
 *   neg bounce / invalid ................ ≤20%   (caps the failed value down; forces re-derivation)
 */
'use strict';

const ORDER = ['A', 'B', 'C', 'D', 'E'];           // best → worst (index 0 = strongest)
const CAP = { A: 1.00, B: 0.95, C: 0.80, D: 0.50, E: 0.30 };
const NEG_CAP = 0.20;                              // a value that bounced can't sit above this

// Map an observation kind/source label to an evidence grade (or 'neg', or null if ungradeable).
const KIND_GRADE = {
  // A — official dedicated source
  dedicated: 'A', business_card: 'A', card: 'A', official_directory: 'A', directory: 'A', owner_confirmed: 'A', signed: 'A',
  // B — independently verified
  verified: 'B', mail_confirmed: 'B', deliverable: 'B', primary_source: 'B', source: 'B',
  // C — pattern-confirmed
  pattern: 'C',
  // D — best-guess / derived
  guess: 'D', derived: 'D', best_guess: 'D',
  // E — generic mailbox / unconfirmed
  generic: 'E', mailbox: 'E', unconfirmed: 'E',
  // negative
  bounce: 'neg', invalid: 'neg', undeliverable: 'neg', failed: 'neg',
};
function gradeOf(kindOrObs) {
  const k = String((kindOrObs && kindOrObs.kind != null) ? kindOrObs.kind : kindOrObs || '').toLowerCase().trim();
  return KIND_GRADE[k] || null;
}
function cap(grade) { return CAP[grade] != null ? CAP[grade] : 0; }
function rank(grade) { const i = ORDER.indexOf(grade); return i < 0 ? Infinity : i; }

// How far a grade is from fully-qualified, as a human note for the UI.
function stagesToFull(grade) {
  if (grade === 'A') return 'fully qualified';
  if (!grade) return 'needs any confirmed source';
  return `needs a grade-A dedicated source (business card / official directory) to reach 100%`;
}

// Capped ratchet over a set of observations (already scoped to ONE attribute, e.g. a person's email).
// Returns the governing grade, the send-confidence, the winning observation, and whether the held
// value is in conflict with a negative. Deterministic; ties broken by most-recent capture.
//
// If `value` is given, the ratchet is scoped to THAT value — only its positive observations count and
// only negatives on it conflict. This is the send-confidence of the value the dossier actually holds
// (a bounce on an old, discarded address must NOT drag down the new held one). Omit `value` to get the
// best across all values (e.g. "what's the strongest evidence we have for anyone's address").
function qualify(observations, value) {
  let obs = Array.isArray(observations) ? observations : [];
  if (value != null) {
    const want = String(value).trim().toLowerCase();
    obs = obs.filter(o => String(o.value == null ? '' : o.value).trim().toLowerCase() === want);
  }
  let best = null;        // strongest positive observation
  const negatives = [];
  for (const o of obs) {
    const g = gradeOf(o);
    if (g === 'neg') { negatives.push(o); continue; }
    if (!g) continue;
    if (!best || rank(g) < rank(gradeOf(best)) ||
        (rank(g) === rank(gradeOf(best)) && (o.captured_at || 0) >= (best.captured_at || 0))) {
      best = o;
    }
  }
  if (!best) {
    return { grade: null, confidence: 0, capBy: null, conflicted: negatives.length > 0, negatives, note: stagesToFull(null) };
  }
  const grade = gradeOf(best);
  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
  const conflicted = negatives.some(n => norm(n.value) === norm(best.value));
  const confidence = conflicted ? Math.min(cap(grade), NEG_CAP) : cap(grade);
  return { grade, confidence, capBy: best, conflicted, negatives, note: conflicted ? 'held value bounced — re-derive' : stagesToFull(grade) };
}

module.exports = { ORDER, CAP, NEG_CAP, gradeOf, cap, rank, stagesToFull, qualify };
