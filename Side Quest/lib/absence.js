/* lib/absence.js — MEMORY PATH MAPPING slice P3: the ABSENCE MODEL.
 *
 * The problem this exists to prevent: a failed lookup and a non-existent fact are NOT the same
 * thing, and a system that records them identically will eventually conclude something is untrue
 * because it remembers failing to find it. In a graph written continuously by autonomous workers
 * that error compounds — one worker's "not found" becomes another's "does not exist".
 *
 * Adopted directly from Wikidata's three-valued snaks (see the survey in
 * docs/MEMORY_PATH_MAPPING_DESIGN.md §6):
 *
 *   value      — we know it
 *   somevalue  — a value EXISTS but we have not found it   → this is a GAP; it feeds research
 *   novalue    — no value exists in the world               → this is a CLAIM; it needs evidence
 *
 * INVARIANT #3 — a failed lookup is ALWAYS `somevalue`. It may NEVER auto-promote to `novalue`.
 *   Promotion requires the same evidentiary bar as a positive fact: an explicit completeness or
 *   cardinality assertion, or an authoritative source stating the absence. A TIMEOUT IS NOT
 *   EVIDENCE. A hundred failed searches are not evidence either — they are one gap, observed a
 *   hundred times. This module enforces that structurally: promote() refuses without evidence.
 *
 * INVARIANT #4 (RFC 2308) — `first_observed_ts` NEVER refreshes on re-read. Only a genuinely NEW
 *   lookup attempt updates the record, and even then the ORIGIN timestamp is frozen. Without this,
 *   autonomous workers re-observing each other's records would keep re-stamping a negative as
 *   fresh, and a "not found" would circulate forever as self-sustaining truth — the exact
 *   failure DNS negative-caching was designed around.
 *
 * Absence also expires FASTER than presence: absence is a weaker claim than presence, so a gap
 * goes stale sooner and gets re-checked sooner.
 *
 * Pure decision logic here; the sq.db read/write edge is at the bottom and is fail-soft.
 */
'use strict';

const KIND = { SOME: 'somevalue', NO: 'novalue' };

// A gap is worth re-checking sooner than a fact is worth re-verifying. Default 6h.
const DEFAULT_TTL_S = 6 * 3600;
// Backoff: a gap re-confirmed many times is unlikely to close on the next pass either, so the
// re-check interval grows. Capped so a gap is never parked forever — that would be `novalue` by
// the back door, which invariant #3 forbids.
const MAX_TTL_S = 7 * 24 * 3600;

function ttlFor(attempts, { baseS = DEFAULT_TTL_S, maxS = MAX_TTL_S } = {}) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(maxS, Math.round(baseS * Math.pow(2, n - 1)));
}

// Is a recorded absence still fresh enough to trust (i.e. skip re-checking)? Uses lastAttemptTs,
// NOT firstObservedTs — the origin stamp is for provenance and must never drive expiry, or a
// long-standing gap would look permanently fresh.
function isFresh(rec, now = Date.now()) {
  if (!rec) return false;
  const last = Number(rec.last_attempt_ts) || Number(rec.first_observed_ts) || 0;
  const ttlMs = (Number(rec.ttl_s) || DEFAULT_TTL_S) * 1000;
  return (now - last) < ttlMs;
}

// THE CORE RULE. What does a lookup outcome mean for the absence record?
//   found            → the gap is CLOSED (delete any record)
//   not found        → `somevalue`: a gap, recorded/re-attempted, NEVER `novalue`
//   error/timeout    → NOTHING is recorded. A transport failure is not an observation of absence;
//                      recording it would let infrastructure trouble masquerade as a fact.
function classifyLookup({ found, errored }) {
  if (errored) return { action: 'ignore', reason: 'error-is-not-evidence' };
  if (found) return { action: 'close', reason: 'found' };
  return { action: 'gap', kind: KIND.SOME, reason: 'not-found' };
}

// Can this gap be promoted to an asserted absence? Only with real evidence. The evidence KINDS are
// the ones the completeness literature actually accepts (cardinality/completeness assertions, or a
// source that states the absence) — never "we looked N times".
const VALID_EVIDENCE = new Set(['cardinality', 'completeness-assertion', 'authoritative-source']);

function canPromote({ evidenceKind, evidenceRef } = {}) {
  if (!evidenceKind) return { ok: false, reason: 'no-evidence: a failed search is not evidence of absence' };
  if (!VALID_EVIDENCE.has(evidenceKind)) return { ok: false, reason: `evidence kind "${evidenceKind}" is not admissible` };
  if (!evidenceRef || !String(evidenceRef).trim()) return { ok: false, reason: 'evidence must cite a source/assertion' };
  return { ok: true };
}

// Merge a new observation into an existing record WITHOUT ever moving the origin stamp (#4).
function applyAttempt(prev, now = Date.now()) {
  if (!prev) {
    return { kind: KIND.SOME, first_observed_ts: now, last_attempt_ts: now, attempts: 1, ttl_s: ttlFor(1) };
  }
  const attempts = (Number(prev.attempts) || 0) + 1;
  return {
    ...prev,
    kind: prev.kind || KIND.SOME,
    first_observed_ts: Number(prev.first_observed_ts) || now,   // FROZEN — invariant #4
    last_attempt_ts: now,
    attempts,
    ttl_s: ttlFor(attempts),
  };
}

// ── sq.db edge (fail-soft; absence bookkeeping must never break research) ───────────────────────
let _db = null;
function db() { if (!_db) _db = require('./db'); return _db; }

function get(subject, predicate) {
  try {
    return db().getDb().prepare(
      `SELECT * FROM absence WHERE subject = ? AND predicate = ?`).get(String(subject), String(predicate)) || null;
  } catch { return null; }
}

// Record a NOT-FOUND. Always `somevalue`. Returns the stored row, or null if it was an error
// (errors are deliberately not recorded — see classifyLookup).
function recordMiss(subject, predicate, { errored = false, now = Date.now() } = {}) {
  try {
    const c = classifyLookup({ found: false, errored });
    if (c.action !== 'gap') return null;
    const prev = get(subject, predicate);
    const next = applyAttempt(prev, now);
    db().getDb().prepare(
      `INSERT INTO absence (subject, predicate, kind, first_observed_ts, last_attempt_ts, attempts, ttl_s, evidence_kind, evidence_ref)
       VALUES (?,?,?,?,?,?,?,NULL,NULL)
       ON CONFLICT(subject, predicate) DO UPDATE SET
         last_attempt_ts = excluded.last_attempt_ts,
         attempts        = excluded.attempts,
         ttl_s           = excluded.ttl_s`
    ).run(String(subject), String(predicate), next.kind, next.first_observed_ts, next.last_attempt_ts, next.attempts, next.ttl_s);
    return next;
  } catch { return null; }
}

// The gap closed — we found it. Drop the record.
function recordFound(subject, predicate) {
  try {
    db().getDb().prepare(`DELETE FROM absence WHERE subject = ? AND predicate = ?`).run(String(subject), String(predicate));
    return true;
  } catch { return false; }
}

// Promote a gap to an ASSERTED absence. Refuses without admissible evidence (invariant #3).
function promote(subject, predicate, { evidenceKind, evidenceRef } = {}) {
  const v = canPromote({ evidenceKind, evidenceRef });
  if (!v.ok) return v;
  try {
    db().getDb().prepare(
      `UPDATE absence SET kind = ?, evidence_kind = ?, evidence_ref = ?
       WHERE subject = ? AND predicate = ?`
    ).run(KIND.NO, String(evidenceKind), String(evidenceRef), String(subject), String(predicate));
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// The GAPS the research allocator should act on: `somevalue` records whose TTL has lapsed.
// `novalue` is excluded by construction — an asserted absence is an answer, not a work item.
function openGaps({ limit = 100, now = Date.now() } = {}) {
  try {
    return (db().getDb().prepare(
      `SELECT * FROM absence WHERE kind = ? ORDER BY attempts ASC, last_attempt_ts ASC LIMIT ?`
    ).all(KIND.SOME, limit) || []).filter(r => !isFresh(r, now));
  } catch { return []; }
}

module.exports = {
  KIND, DEFAULT_TTL_S, MAX_TTL_S, VALID_EVIDENCE,
  ttlFor, isFresh, classifyLookup, canPromote, applyAttempt,
  get, recordMiss, recordFound, promote, openGaps,
};
