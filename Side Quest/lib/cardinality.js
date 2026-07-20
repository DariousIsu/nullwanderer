/* lib/cardinality.js — MEMORY PATH MAPPING slice P5: PER-BODY CARDINALITY.
 *
 * The gap P4 could not close. Coverage counts BODIES researched; it cannot say whether the roster
 * inside a body is complete. "state-legislature-id 2/2" means both chambers were worked, not that
 * Idaho's legislators are on file. To ask "do we have all of them?" you need the body's SEAT COUNT —
 * its cardinality — and that is the one thing that turns a vague "probably incomplete" into a
 * countable, prioritisable work item: the Idaho House has 70 seats, we hold 41, therefore 29 are
 * missing. Nothing is inferred; it is subtraction.
 *
 * The completeness literature is unanimous that this is the highest-precision gap signal available
 * (Razniewski & Nutt's cardinality assertions; recall = |have| / N). Every other method — peer
 * comparison, obligatory-attribute mining — is an ESTIMATE. This one is arithmetic.
 *
 * ── A SEAT COUNT IS A CLAIM ABOUT THE WORLD, NOT BOOKKEEPING ───────────────────────────────────
 *
 * This is the design line that matters. `covered` is our own record of what we did — we can assert
 * it freely because it is a fact about US. A cardinality asserts something about reality ("this
 * chamber has 105 seats"), and a wrong one is actively harmful in both directions: too high
 * manufactures phantom gaps that can never close, too low declares a roster finished while members
 * are missing. So the same discipline as the absence model applies — a value is REFUSED without a
 * source. Structurally, not by convention.
 *
 * We deliberately do NOT guess a cardinality from what we happen to hold. "We have 41 members so
 * there are probably 41 seats" would make every incomplete roster look complete — the exact failure
 * this slice exists to eliminate.
 *
 * CONFLICTS ARE SURFACED, NOT SILENTLY RESOLVED. Two sources disagreeing about a seat count is a
 * real-world signal (a chamber was resized, or one source is wrong). Overwriting on last-write-wins
 * would hide that, so a disagreement is recorded and the incumbent value is kept unless the new one
 * is better-sourced.
 *
 * Pure decision logic; the sq.db edge is at the bottom and is fail-soft.
 */
'use strict';

// Source quality, ordered. Only these count — "the model said so" is not a source, which is why
// there is no 'inferred' or 'estimated' tier. Mirrors absence.VALID_EVIDENCE.
const SOURCE_RANK = { official: 3, corroborated: 2, secondary: 1 };
const VALID_SOURCES = new Set(Object.keys(SOURCE_RANK));

// A plausible seat count. The bound is not fussiness: a parsing failure that yields 0, a year
// (2026), or a phone number would silently poison every completeness figure downstream, and a bad
// cardinality is worse than none because it looks authoritative.
const MIN_SEATS = 1;
const MAX_SEATS = 1000;   // the largest real legislature (NH House) is 400; 1000 is generous headroom

// Numeric strings are coerced deliberately — a count extracted from text or read back from JSON
// legitimately arrives as "70". Coercion is safe because the bounds are applied AFTER it: "2026"
// becomes 2026 and is rejected as out of range, "7 seats" becomes NaN and is rejected. So the guard
// that matters (no years, no phone numbers, no parse failures) is untouched by allowing strings.
function isPlausible(n) {
  const v = Number(n);
  return Number.isInteger(v) && v >= MIN_SEATS && v <= MAX_SEATS;
}

function validate({ seats, sourceKind, sourceRef } = {}) {
  if (!isPlausible(seats)) return { ok: false, reason: `implausible seat count: ${seats}` };
  if (!sourceKind) return { ok: false, reason: 'no source: a seat count is a claim about the world and needs one' };
  if (!VALID_SOURCES.has(sourceKind)) return { ok: false, reason: `source kind "${sourceKind}" is not admissible` };
  if (!sourceRef || !String(sourceRef).trim()) return { ok: false, reason: 'source must cite where the count came from' };
  return { ok: true };
}

// Should an incoming value replace the stored one? Same value → just re-affirm (strengthens nothing,
// but records that a second source agreed). Different value → only a STRICTLY better source wins;
// otherwise the incumbent stands and the disagreement is flagged for a human.
function shouldReplace(prev, next) {
  if (!prev) return { replace: true, conflict: false };
  if (Number(prev.seats) === Number(next.seats)) return { replace: false, conflict: false, agrees: true };
  const pr = SOURCE_RANK[prev.source_kind] || 0;
  const nr = SOURCE_RANK[next.sourceKind] || 0;
  if (nr > pr) return { replace: true, conflict: true, reason: 'better-sourced value supersedes' };
  return { replace: false, conflict: true, reason: 'conflicting count from an equal-or-weaker source — keeping incumbent' };
}

// THE PAYOFF. Known cardinality + what we hold = a countable gap. Returns `known:false` when the
// cardinality is unknown — and then makes NO completeness claim at all, which is the honest answer
// and the whole reason this module refuses to guess.
function reconcile({ seats = null, held = 0 } = {}) {
  const h = Math.max(0, Number(held) || 0);
  if (!isPlausible(seats)) {
    return { known: false, held: h, seats: null, missing: null, complete: null,
      text: `${h} on file; the body's size is unknown, so completeness cannot be stated` };
  }
  const n = Number(seats);
  const missing = Math.max(0, n - h);
  // held > seats is not "complete" — it means duplicates, or a stale seat count. Flag it rather than
  // reporting a tidy 100%, because a silent over-count hides a real data problem.
  const over = h > n;
  return {
    known: true, held: h, seats: n, missing, over,
    complete: missing === 0 && !over,
    text: over ? `${h} on file against ${n} seats — MORE than the body has; check for duplicates or a stale seat count`
      : missing === 0 ? `all ${n} on file`
      : `${h} of ${n} on file; ${missing} missing`,
  };
}

// ── sq.db edge (fail-soft; cardinality bookkeeping must never break research) ───────────────────
let _db = null;
function db() { if (!_db) _db = require('./db'); return _db; }

// BODY KEY — same reasoning as absence.js: a seat count must stay attached to the body across changes
// in how the worklist names it, or a rename silently orphans it and the body reads "size unknown"
// again. lib/body_key.js strips only prefixes we generate; an unrecognised name is left alone.
let _bk = null;
function bodyKey(body) {
  try {
    if (!_bk) _bk = require('./body_key');
    return _bk.normalizeBody(body) || String(body || '');
  } catch { return String(body || ''); }
}

function get(body) {
  try {
    return db().getDb().prepare(`SELECT * FROM cardinality WHERE body = ?`).get(bodyKey(body)) || null;
  } catch { return null; }
}

// Record a seat count. Refuses without an admissible source (see the header). Returns
// { ok, stored, conflict, reason }.
function record(body, { seats, sourceKind, sourceRef, now = Date.now() } = {}) {
  const v = validate({ seats, sourceKind, sourceRef });
  if (!v.ok) return { ok: false, stored: false, conflict: false, reason: v.reason };
  try {
    const prev = get(body);
    const d = shouldReplace(prev, { seats, sourceKind });
    if (d.conflict) {
      try {
        db().getDb().prepare(
          `UPDATE cardinality SET conflict_seats = ?, conflict_source = ?, conflict_ts = ? WHERE body = ?`
        ).run(Number(seats), String(sourceRef).slice(0, 300), now, bodyKey(body));
      } catch {}
    }
    if (!d.replace) return { ok: true, stored: false, conflict: !!d.conflict, agrees: !!d.agrees, reason: d.reason || 'unchanged' };
    db().getDb().prepare(
      `INSERT INTO cardinality (body, seats, source_kind, source_ref, observed_ts, conflict_seats, conflict_source, conflict_ts)
       VALUES (?,?,?,?,?,NULL,NULL,NULL)
       ON CONFLICT(body) DO UPDATE SET
         seats = excluded.seats, source_kind = excluded.source_kind,
         source_ref = excluded.source_ref, observed_ts = excluded.observed_ts`
    ).run(bodyKey(body), Number(seats), String(sourceKind), String(sourceRef).slice(0, 300), now);
    return { ok: true, stored: true, conflict: !!d.conflict, reason: d.reason || 'stored' };
  } catch (e) { return { ok: false, stored: false, conflict: false, reason: e.message }; }
}

// Reconcile a body against what we hold, reading the stored cardinality.
function gapFor(body, held) {
  const rec = get(body);
  return reconcile({ seats: rec ? rec.seats : null, held });
}

// Bodies whose sources disagree — a human question, not something to auto-resolve.
function conflicts({ limit = 50 } = {}) {
  try {
    return db().getDb().prepare(
      `SELECT * FROM cardinality WHERE conflict_seats IS NOT NULL ORDER BY conflict_ts DESC LIMIT ?`).all(limit) || [];
  } catch { return []; }
}

module.exports = {
  SOURCE_RANK, VALID_SOURCES, MIN_SEATS, MAX_SEATS,
  isPlausible, validate, shouldReplace, reconcile,
  get, record, gapFor, conflicts,
};
