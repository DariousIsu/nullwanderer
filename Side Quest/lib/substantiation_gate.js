'use strict';
/**
 * lib/substantiation_gate.js — the READ half of lane-boundary §1.4
 * (docs/LANE_BOUNDARY_2026-07-21_REPLY.md): "a node minted from one county PDF and a node confirmed
 * against a register are both status:'resolved' to you, and they should not read the same in the
 * prompt."
 *
 * The WRITE half already exists and is enforced at the sink: every observation through
 * curation_store.record gets a substantiation_state — explicit from the caller
 * (doc_decompose._mintUnsubstantiated stamps UNSUBSTANTIATED) or derived by
 * substantiation.classifySubstantiation. What was MISSING is a way for the conversation lane to READ
 * it: echo_suit.resolveMention returns Echo's entity with no substantiation field, so the prompt
 * assembler had nothing to gate on. This module is that read: given the name a mention resolved to,
 * what does this lane's observation log know about how substantiated that node is?
 *
 * THE CONTRACT (for lib/references.js and anything else that renders resolved mentions):
 *   pinned === true   ⇔  some observation of this entity is IDENTITY-CONFIRMED — it matched a known
 *                        real thing (Echo/wiki resolve), not merely a cited sighting.
 *   pinned === false  →  render UNPINNED. This includes source-vouched (a source stands behind the
 *                        claim, but nothing confirmed the identity), unsubstantiated (prove-or-fade),
 *                        AND the null return (no local record at all — e.g. an entity that entered
 *                        Echo through a bulk import this lane never observed). Unknown is not pinned.
 *
 * Precedence is STRONGEST-ACROSS-OBSERVATIONS (identity-confirmed > source-vouched > unsubstantiated):
 * each encounter raises certainty, and an identity confirmation is not undone by a later weaker
 * sighting of the same name. Archived (faded) rows never vouch. The async substantiation lane upgrades
 * states in place (db.setSubstantiationForEntity), so this read always reflects the current truth.
 *
 * Lookup is by the CANONICAL name — the same string doc_decompose observes under and resolveMention
 * returns — via the (source_entity, status) index; a case-insensitive scan is the fallback, never the
 * first try.
 */

const SUB = require('./substantiation');

const RANK = { [SUB.IDENTITY_CONFIRMED]: 3, [SUB.SOURCE_VOUCHED]: 2, [SUB.UNSUBSTANTIATED]: 1 };

const _SQL = `SELECT substantiation_state AS s, COUNT(*) AS n, MAX(captured_at) AS latest
                FROM kg_observations WHERE {WHERE} AND status <> 'archived'
               GROUP BY substantiation_state`;

/**
 * The substantiation footing of an entity, from this lane's observation log.
 * Returns { state, pinned, counts, observations, latest } — or null when the log has never observed
 * the name at all (which the §1.4 gate must treat exactly like unsubstantiated: not pinned).
 */
function stateFor(db, name) {
  const nm = String(name == null ? '' : name).trim();
  if (!nm) return null;
  let rows = [];
  try {
    const d = db.getDb();
    rows = d.prepare(_SQL.replace('{WHERE}', 'source_entity = ?')).all(nm);
    if (!rows.length) rows = d.prepare(_SQL.replace('{WHERE}', 'LOWER(source_entity) = LOWER(?)')).all(nm);
  } catch { return null; }
  if (!rows.length) return null;
  const counts = {};
  let best = null, observations = 0, latest = null;
  for (const r of rows) {
    const s = r.s == null ? null : String(r.s).trim().toLowerCase();
    counts[s == null ? 'unstated' : s] = r.n;
    observations += r.n;
    if (r.latest != null && (latest == null || r.latest > latest)) latest = r.latest;
    // A pre-substrate row with a null state is a sighting, never a vouching — it counts toward
    // `observations` but can't become `state`.
    if (s != null && RANK[s] && (!best || RANK[s] > RANK[best])) best = s;
  }
  return { state: best, pinned: best === SUB.IDENTITY_CONFIRMED, counts, observations, latest };
}

/** pinned ⇔ identity-confirmed. Unknown / unobserved / merely-vouched are all false. */
function isPinned(db, name) {
  const r = stateFor(db, name);
  return !!(r && r.pinned);
}

/**
 * Convenience over a resolveMention result: the one call a prompt assembler needs.
 * gateResolved(db, r) → { pinned, state, why } — safe on any input shape, never throws.
 */
function gateResolved(db, resolveResult) {
  const name = resolveResult && resolveResult.object && resolveResult.object.name;
  if (!name || resolveResult.status !== 'resolved') return { pinned: false, state: null, why: 'not-resolved' };
  const r = stateFor(db, name);
  if (!r) return { pinned: false, state: null, why: 'no-local-record' };
  if (r.pinned) return { pinned: true, state: r.state, why: 'identity-confirmed' };
  return { pinned: false, state: r.state, why: r.state || 'unstated' };
}

module.exports = { stateFor, isPinned, gateResolved, RANK };
