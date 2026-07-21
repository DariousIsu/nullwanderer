'use strict';
/**
 * lib/decompose_sweep.js — find documents that landed but were never read.
 *
 * `decomposeLandedDoc` lives at main.js:9029 and is called from five specific INGEST paths — canvas
 * drop, browser download, meeting, and so on. So decomposition is coupled to how a document ARRIVED
 * rather than to the document itself, and anything landing by another route is invisible to the graph
 * forever. Found the hard way: `scripts/research_org.js` landed raineycenter.org and raineyfreedom.org
 * with correct origins and content hashes, and they produced ZERO encounters — the sentence naming the
 * sister organisation sat in the corpus, unread.
 *
 * This module is the SELECTION half, and it is the half worth testing: which documents were never read.
 * The live wiring (cloud extractor, Echo dispatch, the resolution gate) belongs to the caller, because
 * that is environment rather than logic.
 *
 * ── WHY "NO ENCOUNTERS" IS NOT ENOUGH ON ITS OWN ────────────────────────────────────────────────
 *
 * A document can be read honestly and yield nothing — a page of navigation chrome, a stub, a form. If
 * absence of encounters were the only test, that document would be re-read on every sweep forever,
 * burning a cloud extraction each time to produce the same nothing. So an ATTEMPT is recorded
 * separately from a RESULT. Trying and finding nothing is a fact worth keeping, exactly like an
 * encounter that found nothing is different from never having looked.
 */

const META_KEY = 'decompose_sweep:attempted';

// The attempted set, as ids. Stored in meta rather than a new table: it is a small operational marker,
// not evidence, and it must not look like knowledge.
function attemptedSet(db) {
  try {
    const raw = db.getMeta(META_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(Number).filter(Number.isFinite) : []);
  } catch { return new Set(); }
}

function markAttempted(db, ids = []) {
  const set = attemptedSet(db);
  for (const id of ids) if (Number.isFinite(Number(id))) set.add(Number(id));
  // Bounded: keep the most recent 20k so this marker cannot grow without limit. Older ids falling off
  // is safe — they will only be re-read if they ALSO still have no encounters, which by then is a
  // genuine question worth asking again.
  const arr = [...set].sort((a, b) => a - b).slice(-20000);
  try { db.setMeta(META_KEY, JSON.stringify(arr)); } catch { /* operational marker — never fatal */ }
  return arr.length;
}

/**
 * Documents that landed and were never read.
 *
 * A document qualifies when it has a body, has produced NO encounters, and has not already been
 * attempted. `sinceId` and `limit` bound the work; `sources` narrows to specific lanes when a caller
 * only wants to repair one (e.g. `org_research`).
 *
 * Returns [{ id, title, source, origin_host, chars }]. Never throws.
 */
function findUndecomposed(db, { limit = 50, sinceId = 0, sources = null } = {}) {
  const attempted = attemptedSet(db);
  let rows = [];
  try {
    const where = ['d.body IS NOT NULL', "TRIM(d.body) <> ''", 'd.id > ?'];
    const args = [Number(sinceId) || 0];
    if (Array.isArray(sources) && sources.length) {
      where.push(`d.source IN (${sources.map(() => '?').join(',')})`);
      args.push(...sources);
    }
    rows = db.getDb().prepare(
      `SELECT d.id, d.title, d.source, d.origin_host, LENGTH(d.body) AS chars
         FROM documents d
        WHERE ${where.join(' AND ')}
          AND NOT EXISTS (SELECT 1 FROM encounters e WHERE e.source_ref = 'doc:' || d.id)
        ORDER BY d.id DESC
        LIMIT ?`).all(...args, Math.max(1, (Number(limit) || 50) * 4));
  } catch { return []; }
  return rows.filter((r) => !attempted.has(Number(r.id))).slice(0, Math.max(1, Number(limit) || 50));
}

module.exports = { findUndecomposed, attemptedSet, markAttempted, META_KEY };
