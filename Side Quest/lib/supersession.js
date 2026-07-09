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
        subjectName: loser.sourceName || winner.sourceName || null,
        loserTarget: loser.targetName || null, winnerTarget: winner.targetName || null,
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

// A comparable WORLD-TIME year from an extracted valid-time value (year int, ISO date, or a string with a
// 4-digit year). NEVER derive from created_at. Guards against reading a unix-epoch number as a bogus year.
function worldYear(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (v >= 1600 && v <= 2200) return v;                          // already a year
    if (v > 1e8) { const y = new Date(v > 1e11 ? v : v * 1000).getUTCFullYear(); return (y >= 1600 && y <= 2200) ? y : null; }  // epoch → year
    return null;
  }
  const m = /\b(1[6-9]\d\d|2[0-1]\d\d)\b/.exec(String(v));
  return m ? Number(m[1]) : null;
}

// civic_graph relation rows (with joined names + metadata) → the edge shape the candidate generators use.
// WORLD-TIME valid_from is parsed from relation_metadata (valid_from / tenure_start / start_date) — NOT the
// valid_from COLUMN, which was A1-backfilled to created_at (ingest time; ordering on it would BE the anti-pattern).
function edgesFromRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    let md = {};
    try { md = typeof r.md === 'string' ? JSON.parse(r.md || '{}') : (r.md || {}); } catch { md = {}; }
    const vfRaw = md.valid_from != null ? md.valid_from : (md.tenure_start != null ? md.tenure_start : md.start_date);
    const vtRaw = md.valid_to != null ? md.valid_to : (md.tenure_end != null ? md.tenure_end : md.end_date);
    return {
      id: r.id, source_id: r.source_id, target_id: r.target_id,
      relation: r.rt || r.relation_type, confidence: _num(r.confidence),
      validFrom: worldYear(vfRaw), validTo: worldYear(vtRaw),
      sourceName: r.sn || null, targetName: r.tn || null,
    };
  });
}

/**
 * The nightly REPLACEMENT scan (read-only, PROPOSAL-FIRST). Reads the live functional-predicate edges via
 * the injected `dispatch` (db_query; these predicates are tiny + relation_type-indexed, so it's cheap), then
 * generates replacement candidates on WORLD-TIME valid_from. Termination-by-valid_to is intentionally NOT
 * run here yet: valid_to is unpopulated + unindexed today (needs C1 valid-time to land + a partial index).
 * Returns { candidates, summary }. Never writes to the graph.
 */
async function runReplacementScan({ dispatch, functional = FUNCTIONAL_PREDICATES, confFloor = DEFAULT_CONF_FLOOR } = {}) {
  if (typeof dispatch !== 'function') return { candidates: [], summary: { assessed: 0, candidates: 0 } };
  const types = [...functional].map((t) => `'${String(t).replace(/[^A-Z_]/g, '')}'`).filter((t) => t !== "''").join(',');
  if (!types) return { candidates: [], summary: { assessed: 0, candidates: 0 } };
  const sql = 'SELECT r.id, r.source_id, r.target_id, r.relation_type rt, r.confidence, r.relation_metadata md,'
    + ' es.name sn, et.name tn'
    + ' FROM relations r JOIN entities es ON es.id = r.source_id JOIN entities et ON et.id = r.target_id'
    + ` WHERE r.relation_type IN (${types}) AND r.tx_to IS NULL AND r.deleted = 0`;
  let rows = [];
  try { const res = await dispatch({ kind: 'do', name: 'db_query', args: { sql } }); const j = JSON.parse(res.text); rows = (j && j.rows) || []; }
  catch { return { candidates: [], summary: { assessed: 0, candidates: 0, error: true } }; }
  const edges = edgesFromRows(rows);
  const candidates = replacementCandidates(edges, { functional, confFloor });
  return { candidates, summary: { assessed: edges.length, candidates: candidates.length } };
}

module.exports = {
  FUNCTIONAL_PREDICATES, DEFAULT_CONF_FLOOR,
  terminationCandidates, replacementCandidates, supersessionCandidates,
  worldYear, edgesFromRows, runReplacementScan,
};
