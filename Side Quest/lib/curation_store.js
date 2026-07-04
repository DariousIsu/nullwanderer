/**
 * lib/curation_store.js — the durable, cross-feed OBSERVATION STORE for the curation substrate
 * (Slice 1; see docs/CURATION_SUBSTRATE_DESIGN.md).
 *
 * Every feed that introduces entities/facts (the idle graph-walk, Puller contacts, the news lane,
 * document decomposition …) records what it SAW here — the graded, cited "observation" leg of the
 * Puller isomorphism (source, source_url, confidence). This is the home of record for the
 * "requires citation" first principle: a promotion is provable back to its source, and a HELD
 * (uncited / inferred) claim is not lost — it queues as a candidate for later enrichment.
 *
 * The qualifier (studio/puller_confidence) and the two gates (lib/curation_gate) are already the
 * shared grading/threshold logic. This module is the shared SINK they feed: the one place a graded
 * observation becomes durable, so no feed has to invent its own trail. `observe()` used to only
 * console-log; now it lands a row here.
 *
 * Pure except for the injected `db` (lib/db, or any object exposing recordKgObservation /
 * listKgObservations / kgObservationStats) — so it's exhaustively offline-smoke-testable.
 */
'use strict';

const PC = require('../studio/puller_confidence');   // shared grade → send-confidence ladder

const s = (v) => String(v == null ? '' : v).trim();
const lc = (v) => s(v).toLowerCase();

// Natural key for idempotency: a feed re-seeing the SAME cited claim (same subject, edge, object/value,
// backing url) must be a no-op, not a duplicate row. relation/target/value/url are optional (an
// existence observation has no edge); the key tolerates their absence.
function obsKey(o) {
  return [lc(o.feed), lc(o.sourceEntity), lc(o.relation), lc(o.target || o.value), lc(o.url)].join('|');
}

// Coerce a raw observation into the stored shape. Fills a send-confidence from the grade when the
// caller didn't supply one (so a feed can pass just a grade and get the ladder's cap). `status`
// defaults to 'promoted'; a gate-HELD claim passes status:'held'.
function normalizeObservation(o = {}) {
  const grade = o.grade == null ? null : String(o.grade).trim();
  let confidence = o.confidence;
  if ((confidence == null || confidence === '') && grade) confidence = PC.cap(grade);
  if (typeof confidence === 'number' && !Number.isFinite(confidence)) confidence = null;
  const norm = {
    feed: s(o.feed) || 'unknown',
    sourceEntity: s(o.sourceEntity),
    relation: o.relation == null ? null : s(o.relation) || null,
    target: o.target == null ? null : s(o.target) || null,
    value: o.value == null ? null : s(o.value) || null,
    url: o.url == null ? null : s(o.url) || null,
    grade: grade || null,
    confidence: confidence == null ? null : confidence,
    kind: o.kind == null ? null : s(o.kind) || null,
    status: s(o.status) || 'promoted',
    capturedAt: o.capturedAt == null ? null : o.capturedAt,
  };
  norm.obsKey = obsKey(norm);
  return norm;
}

// Record one graded observation. Returns { id, inserted, obsKey } (inserted=false on a dup). A row
// with no subject is refused — an observation must be ABOUT something.
function record(db, o) {
  const n = normalizeObservation(o);
  if (!n.sourceEntity) return { id: null, inserted: false, obsKey: n.obsKey, skipped: 'no-subject' };
  const r = db.recordKgObservation(n);
  return { id: r.id, inserted: r.inserted, obsKey: n.obsKey };
}

// Record many; returns per-status counts + how many were new (deduped).
function recordMany(db, list) {
  const out = { total: 0, inserted: 0, promoted: 0, held: 0 };
  for (const o of (Array.isArray(list) ? list : [])) {
    const n = normalizeObservation(o);
    if (!n.sourceEntity) continue;
    out.total++;
    if (n.status === 'held') out.held++; else out.promoted++;
    const r = db.recordKgObservation(n);
    if (r.inserted) out.inserted++;
  }
  return out;
}

function list(db, filter) { return db.listKgObservations(filter || {}); }
function stats(db) { return db.kgObservationStats(); }

// Held candidates for a subject (uncited/inferred claims we did NOT promote) — the enrichment queue:
// what we'd chase down a real citation for next.
function heldFor(db, sourceEntity, limit = 50) {
  return db.listKgObservations({ sourceEntity, status: 'held', limit });
}

// BRIDGE — generalize the Puller contacts path into the shared trail. A Puller contact/handoff row
// (already tier-graded) becomes a normalized attribute observation, so a promoted contact shows up in
// the same observation store as a graph-walk fact. Reuses the Puller confidence tiers verbatim (a
// verified email is grade B, a pattern C, a best-guess D, generic E). Pure; caller records the result.
function fromContact(c = {}, { feed = 'puller', now = null } = {}) {
  const name = s(c.name || c.full_name || c.person);
  if (!name) return [];
  const conf = (typeof c.confidence === 'number') ? c.confidence : null;
  // map a tier confidence back onto the grade ladder for a consistent grade column
  const gradeOf = (v) => v == null ? null : (v >= 0.95 ? 'B' : v >= 0.80 ? 'C' : v >= 0.50 ? 'D' : 'E');
  const src = s(c.source) || (c.verified ? 'verified' : 'guess');
  const out = [];
  const email = lc(c.email);
  if (email) out.push({ feed, sourceEntity: name, relation: 'email', value: email, url: c.source_url || null, grade: gradeOf(conf), confidence: conf, kind: src, status: 'promoted', capturedAt: now });
  const title = s(c.title || c.role || c.position);
  if (title) out.push({ feed, sourceEntity: name, relation: 'role', value: title, url: c.source_url || null, grade: gradeOf(conf), confidence: conf, kind: 'handoff', status: 'promoted', capturedAt: now });
  return out;
}

module.exports = {
  obsKey, normalizeObservation, record, recordMany, list, stats, heldFor, fromContact,
};
