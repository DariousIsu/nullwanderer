'use strict';
/**
 * lib/supersession.js — Milestone D2: deterministic supersession CANDIDATE generation.
 *
 * PROPOSAL-FIRST + non-destructive. It never writes, expires, or supersedes an edge — that is D3
 * (operator-gated, behind a flag). It only SURFACES two kinds of "this fact should end" candidate,
 * both decided on VALID-TIME (world time), never `created_at` (ingest order):
 *
 *   • TERMINATION — a fact whose valid_to (world-time end) has already passed → it has expired.
 *     ("was exploding information — a predetermined termination.")
 *   • REPLACEMENT — for a FUNCTIONAL predicate (single-valued per subject: HAS_CEO / HAS_CHAIR /
 *     SUBSIDIARY_OF), a subject holding two DIFFERENT live values → the one with the EARLIER
 *     valid_from is superseded by the one with the LATER valid_from (the current truth).
 *
 * THE ANTI-PATTERN GUARD (the gate): a late-arriving OLD fact (a newer `created_at` but an OLDER
 * valid_from) must NOT supersede the newer truth. Supersession follows valid_from, so the
 * later-valid fact always wins regardless of when it was ingested. NEVER ingest-recency.
 *
 * Confidence-gated (never supersede on a weak new fact) and lineage-cycle-guarded (no A⇄B). Pure +
 * deterministic — the classical subset. Free-text-predicate contradiction (LLM) is a separate, later
 * lane; this module is the safe deterministic core the nightly termination pass runs.
 */

// Single-valued-per-subject predicates (the plan's deterministic subset). Conservative + configurable;
// final allowlist is an open decision (needs CIVIC_TAXONOMY.md). A subject can hold only ONE of these
// at a time, so two different live values are a genuine replacement.
const FUNCTIONAL_PREDICATES = new Set(['HAS_CEO', 'HAS_CHAIR', 'SUBSIDIARY_OF']);
const DEFAULT_CONF_FLOOR = 0.5;

const _num = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/**
 * TERMINATION candidates: live edges whose world-time validity has already ended (valid_to < now).
 *   edges: [{ id, source_id, target_id, relation, validTo, ... }]   (validTo in unix SECONDS)
 *   now:   ms epoch
 */
function terminationCandidates(edges, { now = null } = {}) {
  const nowSec = Math.floor((Number(now) || 0) / 1000);
  const out = [];
  for (const e of (Array.isArray(edges) ? edges : [])) {
    const vt = _num(e && e.validTo);
    if (vt != null && vt > 0 && nowSec > 0 && vt < nowSec) {
      out.push({ kind: 'termination', edgeId: e.id, source_id: e.source_id, target_id: e.target_id, relation: e.relation, reason: 'valid_to_passed', validTo: vt });
    }
  }
  return out;
}

/**
 * REPLACEMENT candidates: for FUNCTIONAL predicates, a subject with two DIFFERENT live values →
 * the earlier-valid_from value is superseded by the later. Decided on valid_from (world time), so a
 * late-arriving OLD fact never supersedes the newer truth. Only proposes when the SUPERSEDING fact
 * clears the confidence floor. Edges without a valid_from can't be ordered deterministically → left
 * for the operator / LLM lane (not guessed).
 */
function replacementCandidates(edges, { functional = FUNCTIONAL_PREDICATES, confFloor = DEFAULT_CONF_FLOOR } = {}) {
  const groups = new Map();
  for (const e of (Array.isArray(edges) ? edges : [])) {
    const R = String((e && e.relation) || '').toUpperCase();
    if (!functional.has(R)) continue;
    const key = `${e.source_id}|${R}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const out = [];
  for (const grp of groups.values()) {
    const dated = grp.filter((e) => _num(e.validFrom) != null);
    if (dated.length < 2) continue;                                   // need valid-time on ≥2 to decide
    dated.sort((a, b) => _num(a.validFrom) - _num(b.validFrom));      // ascending world-time
    const winner = dated[dated.length - 1];                          // LATEST valid_from = the current truth
    if (!(_num(winner.confidence) >= confFloor)) continue;            // never supersede on a weak new fact
    for (let i = 0; i < dated.length - 1; i++) {
      const loser = dated[i];
      if (loser.target_id != null && winner.target_id != null && loser.target_id === winner.target_id) continue; // same value → not a replacement
      out.push({
        kind: 'replacement', supersededId: loser.id, supersededBy: winner.id,
        source_id: loser.source_id, relation: String((loser.relation) || '').toUpperCase(),
        reason: 'newer_valid_from', loserValidFrom: _num(loser.validFrom), winnerValidFrom: _num(winner.validFrom),
        winnerConfidence: _num(winner.confidence),
      });
    }
  }
  return out;
}

/**
 * All supersession candidates (termination ∪ replacement), lineage-cycle-guarded (drop any replacement
 * whose reverse A→B / B→A was already proposed). Proposal-first: the caller persists these for the
 * operator; nothing is written to the graph here.
 */
function supersessionCandidates(edges, opts = {}) {
  const all = [...terminationCandidates(edges, opts), ...replacementCandidates(edges, opts)];
  const seen = new Set();
  const safe = [];
  for (const c of all) {
    if (c.kind === 'replacement') {
      const rev = `${c.supersededBy}->${c.supersededId}`;
      if (seen.has(rev)) continue;                                    // reverse already queued → cycle → drop
      seen.add(`${c.supersededId}->${c.supersededBy}`);
    }
    safe.push(c);
  }
  return safe;
}

module.exports = {
  FUNCTIONAL_PREDICATES, DEFAULT_CONF_FLOOR,
  terminationCandidates, replacementCandidates, supersessionCandidates,
};
