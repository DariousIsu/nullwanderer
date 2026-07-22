/* lib/known_incorrect.js — the inoculation record (§7).
 *
 * docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md §7: "Nothing is deleted, ever. A refuted claim stays, marked."
 *
 * The encounter log is append-only, so a disproven claim never leaves it — and that is the problem this
 * solves rather than the solution. Left alone, a value proven false keeps sitting in the evidence,
 * getting re-encountered, and being re-learned by the next sweep with no memory that it was already
 * tested and failed. `studio/puller_negatives.js` does this for bounced email; this generalises it to
 * any claim about any object.
 *
 * ── REFUTED IS NOT STALE ────────────────────────────────────────────────────────────────────────
 *
 * §5a says contact DECAYS: an old address superseded by a newer one is history, not an error, and
 * recording it as incorrect would be a lie about a fact that was true when it was written. This file is
 * only for values shown to be FALSE — an email that bounced, a record corrected at the source. Every
 * entry demands a REASON and a SOURCE, because "we stopped believing it" is not refutation.
 *
 * ── WHAT IT DOES TO GRADING ─────────────────────────────────────────────────────────────────────
 *
 * A refuted value can never WIN a claim, however well attested. Ten documents repeating a bounced
 * address do not make it deliverable; they make it a widely-published mistake. The value stays visible
 * with its sources — deleting it would let the same datum walk back in — but it is out of the running.
 *
 * ── THE BAR FOR REFUTATION (§13.2) ──────────────────────────────────────────────────────────────
 *
 * Lucas settled this: demoting a claim requires an A-grade source. A weak claim cannot dethrone a
 * well-sourced one; it can only make the attribute contested. So refutation here is not a vote — it is
 * a TEST RESULT (a bounce, an official correction), which is why `reason` is mandatory and free text
 * rather than a grade.
 */
'use strict';

let _db = null;
const db = () => (_db || (_db = require('./db')));

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

// Record a disproven value. Idempotent — re-testing the same bad address is not a second refutation.
function record({ objectKey, claimClass, claimKey = null, claimValue, reason, refutedBy = null, refutedAt = null } = {}) {
  if (!objectKey || !claimClass || claimValue == null || !String(claimValue).trim()) return null;
  // A refutation without a reason is just an opinion, and it would be indistinguishable from a value
  // that merely went stale. Refused rather than stored with a placeholder.
  if (!reason || !String(reason).trim()) return null;
  try {
    const info = db().getDb().prepare(
      `INSERT INTO known_incorrect (object_key, claim_class, claim_key, claim_value, reason, refuted_by, refuted_at)
       VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`
    ).run(String(objectKey), String(claimClass), claimKey || null, String(claimValue),
      String(reason).slice(0, 500), refutedBy ? String(refutedBy) : null,
      Number.isFinite(refutedAt) ? refutedAt : Date.now());
    // KG surface tap (graph lane, cleared by Lucas 2026-07-22). Refutations are rare by design — 508 rows
    // against 102k encounters — so no throttle is needed and every one deserves to be seen: this is the
    // moment something she held is proven wrong, which is the most consequential event in the whole store.
    // Gated on info.changes, so re-testing a known-bad value stays silent. The write path above is untouched.
    if (info.changes) {
      try {
        require('./kg_activity').emit({
          db: 'sidequest', kind: 'refute',
          anchor: String(objectKey).slice(0, 110), anchor2: String(claimValue).slice(0, 60),
        });
      } catch (e) { /* never disturb the refutation itself */ }
    }
    return info.changes ? info.lastInsertRowid : 0;   // 0 = already known, not an error
  } catch (e) { console.error('[known_incorrect] record failed:', e.message); return null; }
}

function recordMany(list) {
  let added = 0, known = 0;
  for (const r of (Array.isArray(list) ? list : [])) { const id = record(r); if (id) added += 1; else if (id === 0) known += 1; }
  return { added, alreadyKnown: known };
}

// Every refuted value for one object+claim, as a lookup set. Values are compared case-insensitively:
// "Karen.Knutson@x.com" and "karen.knutson@x.com" are the same address and the same bounce.
function refutedSet(objectKey, { claimClass = null, claimKey = null } = {}) {
  const out = new Set();
  if (!objectKey) return out;
  try {
    const w = ['object_key = ?'], a = [String(objectKey)];
    if (claimClass) { w.push('claim_class = ?'); a.push(claimClass); }
    if (claimKey) { w.push('claim_key = ?'); a.push(claimKey); }
    for (const r of db().getDb().prepare(`SELECT claim_value FROM known_incorrect WHERE ${w.join(' AND ')}`).all(...a)) {
      out.add(norm(r.claim_value));
    }
  } catch { /* a missing table must not break grading */ }
  return out;
}

// Why was this value refused? Returned so a caller can SAY it — "that address bounced in March" is a
// useful answer, and silently omitting the value is not.
function reasonFor(objectKey, claimValue, { claimClass = null, claimKey = null } = {}) {
  if (!objectKey || claimValue == null) return null;
  try {
    const w = ['object_key = ?', 'LOWER(claim_value) = ?'], a = [String(objectKey), norm(claimValue)];
    if (claimClass) { w.push('claim_class = ?'); a.push(claimClass); }
    if (claimKey) { w.push('claim_key = ?'); a.push(claimKey); }
    const r = db().getDb().prepare(`SELECT reason, refuted_by, refuted_at FROM known_incorrect WHERE ${w.join(' AND ')} LIMIT 1`).get(...a);
    return r || null;
  } catch { return null; }
}

function stats() {
  try {
    const d = db().getDb();
    return {
      total: d.prepare('SELECT COUNT(*) c FROM known_incorrect').get().c,
      objects: d.prepare('SELECT COUNT(*) c FROM (SELECT 1 FROM known_incorrect GROUP BY object_key)').get().c,
      byClass: d.prepare('SELECT claim_class, COUNT(*) c FROM known_incorrect GROUP BY 1').all(),
    };
  } catch { return { total: 0, objects: 0, byClass: [] }; }
}

module.exports = { record, recordMany, refutedSet, reasonFor, stats, norm };
