'use strict';
/**
 * lib/object_type.js — T3: what kind of thing is this? A GRADED CLAIM, not a column.
 *
 * docs/OBJECT_TYPE_AND_IDENTITY_DESIGN.md §5. This is the slice that actually fixes Fulton County.
 *
 * ── THE PROBLEM WITH A COLUMN ───────────────────────────────────────────────────────────────────
 *
 * Today the first writer wins forever. graph-walk stamped `concept` on 11,732 objects — not by deciding
 * anything, but because `recordEntity({ type = 'concept' })` is a default parameter nobody overrides
 * (§2a-i) — and nothing can dispute it. The LDA feed stamped `organization` on Fulton County and nothing
 * can dispute that either, even though it is a county GOVERNMENT that merely appears in that feed as a
 * lobbying client. The role it arrived in became its type.
 *
 * But "Fulton County is an organization" IS a claim, and by the LDA schema's own lights a true one. It is
 * simply weaker evidence about what Fulton County *is* than a county roster. So it goes in the log like
 * any other claim and the existing ladder decides, with the loser RETAINED. Nobody adjudicates at write
 * time, and a later official source corrects the record without a migration.
 *
 * ── WHY THE SUBJECT IS A BARE NAME ──────────────────────────────────────────────────────────────
 *
 * The object key CONTAINS the type — `org:fulton county` and `gov:fulton county` are two different
 * objects. Hanging a type claim off one of them would be circular: it could only ever tell you the type
 * you had already assumed to look it up. So the subject of a type claim is the type-free NAME, and the
 * claim says what kind of thing that name is. That is also what lets LDA's `organization` and a .gov's
 * `government_body` land on ONE subject and genuinely compete — under the old keying they would have
 * been two unrelated objects, each quietly certain.
 *
 * This module never writes a type anywhere. It records what sources SAY and reads back what wins.
 * Applying that to graph_entities is T4's job, deliberately separate: proposing is safe, and rewriting
 * 13,000 rows is not.
 */

const enc = require('./encounters');

// Grade ladder, mirrored from encounters. A `C` means one source looked once — enough to record, not
// enough to rewrite an object's identity on.
const RANK = { 'A+': 6, A: 5, 'A-': 4, 'B+': 3, B: 2, C: 1 };
const rankOf = (g) => RANK[g] || 0;
function _decisive(g) {
  if (rankOf(g.grade) < RANK.B) return false;                  // nobody has really looked yet
  const rival = (g.values || [])[1];
  if (!rival) return true;
  return rankOf(g.grade) > rankOf(rival.grade);                // a tie is not a win
}

// The claim's subject: a name with no type in it. `name:` is a namespace in the same key space as
// `org:`/`gov:`, so it can never collide with a real object — a type claim is ABOUT a name, it is not
// an object in its own right.
function typeSubject(label) {
  const s = String(label == null ? '' : label).toLowerCase().trim()
    .replace(/\[[^\]]*\]/g, ' ')      // a strong-id tag is identity, not part of the name (T2)
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? `name:${s}` : null;
}

// Record one source's assertion about what kind of thing this is.
//
// `authority` is the caller's to supply and is the whole ballgame: it is what makes a county roster beat
// a hundred lobbying filings. It is NOT inferred here from the type being asserted — that would let a
// source vouch for itself simply by claiming something official-sounding.
function recordType({ label, type, sourceKind = 'document', sourceRef = null, origin = null, originHost = null,
  contentHash = null, authority = 'unknown', observedAt = null } = {}) {
  const subject = typeSubject(label);
  const t = String(type || '').trim().toLowerCase();
  if (!subject || !t) return null;
  return enc.record({
    object_type: 'name',
    object_key: subject,
    object_label: String(label),
    claim_class: 'type',
    claim_key: null,
    claim_value: t,
    source_kind: sourceKind,
    source_ref: sourceRef,
    origin,
    origin_host: originHost,
    content_hash: contentHash,
    authority,
    observed_at: observedAt,
  });
}

// ALREADY-KNOWN IS NOT REFUSED. `encounters.record` returns 0 for a claim already on file and null for
// one it would not accept; collapsing both into "refused" made a re-run of the id-scheme backfill report
// "7 recorded, 2,123 refused", which reads as mass rejection when 2,123 were simply already there. The
// log is append-only and idempotent by design, so re-recording is the NORMAL case, not a failure.
function recordMany(rows = []) {
  let added = 0, alreadyKnown = 0, refused = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const id = recordType(r);
    if (id) added += 1;
    else if (id === 0) alreadyKnown += 1;
    else refused += 1;
  }
  return { added, alreadyKnown, refused, total: Array.isArray(rows) ? rows.length : 0 };
}

// What kind of thing is this, on the evidence? Returns the graded winner plus every rival, retained.
//
// `settled` is the question a caller actually has: is this good enough to act on? A contested claim
// whose rival is within one grade is NOT settled — that is the cleaning signal, and it is exactly the
// state the 8 labels T1 refused to migrate are in (`State of Florida` asserted as both a
// government_body and an organization). Acting on a coin-flip is how a wrong type gets baked in.
function typeOf(label) {
  const subject = typeSubject(label);
  if (!subject) return { type: null, grade: null, settled: false, contested: false, sources: 0, values: [] };
  const g = enc.gradeClaim(subject, { claimClass: 'type' });
  return {
    subject,
    type: g.value,
    grade: g.grade,
    sources: g.sources,
    official: !!g.official,
    contested: !!g.contested,
    cleaning: !!g.cleaning,
    unverified: !!g.unverified,
    // Settled = something won, on real evidence, and no rival is close enough to dispute it.
    //
    // A TIE IS NOT A WIN. Live backfill showed `Atkinson County` as location(C×1) vs
    // government_body(C×1) — identical grade, identical source count — where the winner is whichever
    // row the sort happened to leave on top. Reporting that as settled would smuggle first-writer-wins
    // back in through a tiebreak, which is the exact disease T3 exists to cure. The `cleaning` flag does
    // not catch it either: two C claims sit below its floor by design, because a pair of weak claims
    // means nobody has researched this yet rather than that a dispute needs a verification pass.
    //
    // So settled additionally requires the winner to be worth acting on (B or better) and, where a rival
    // exists, to STRICTLY outrank it.
    settled: !!g.value && !g.cleaning && !g.unverified && _decisive(g),
    values: g.values,
  };
}

// Every name whose type is disputed closely enough to be worth resolving — the work list, not a display.
function contested({ limit = 500 } = {}) {
  let rows = [];
  try {
    rows = require('./db').getDb().prepare(
      `SELECT object_key, MIN(object_label) label, COUNT(DISTINCT claim_value) n
         FROM encounters WHERE claim_class = 'type'
        GROUP BY object_key HAVING n > 1 LIMIT ?`).all(Math.max(1, limit | 0)) || [];
  } catch { return []; }
  const out = [];
  for (const r of rows) {
    const t = typeOf(r.label);
    if (t.contested) out.push({ subject: r.object_key, label: r.label, ...t });
  }
  return out;
}

module.exports = { typeSubject, recordType, recordMany, typeOf, contested };
