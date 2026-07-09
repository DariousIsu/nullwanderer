'use strict';
/**
 * lib/promote_gate.js — the confidence + domain gate that closes the landing loop.
 *
 * The audit's core failure: proposals accrue in tenant staging but nothing lands
 * in civic_graph (operator-gated by design — good — but the loop never closes).
 * With the confidence engine (C1–C4) + the civic-domain filter (#2) live, we can
 * now tell the OPERATOR exactly which queued proposals are safe to bulk-promote:
 *
 *   promote  — trustworthy: calibrated confidence in the A-band AND civic-domain
 *   review   — mid-band: worth an operator glance
 *   hold     — below floor: chase corroboration / a better source first
 *   reject   — off-domain (sports/entertainment drift) — never promote
 *
 * Promotion itself stays the operator's action (Skuld charter: no silent
 * auto-promote); this only RANKS the queue so the operator can promote the
 * `promote` bucket in one confident sweep. Pure + deterministic.
 */

const { isCivic } = require('./civic_domain');
const { calibratedConfidence } = require('./confidence_model');
const { corroborationCount } = require('./corroboration');

// Decision bands over calibrated P(true).
const PROMOTE_FLOOR = 0.90;   // A-band: multi-source-corroborated or A-grade single source
const REVIEW_FLOOR = 0.72;    // operator-review band; below → hold

function _meta(p) {
  if (p && p.relation_metadata) {
    try { return typeof p.relation_metadata === 'string' ? JSON.parse(p.relation_metadata) : p.relation_metadata; }
    catch { return null; }
  }
  if (p && p.metadata && typeof p.metadata === 'object') return p.metadata;
  return null;
}

// Effective confidence: recompute the CALIBRATED value from the proposal's
// provenance (grade + independent corroboration) when present; otherwise fall
// back to the stored confidence (legacy flat-0.8 proposals with no metadata).
function effectiveConfidence(p) {
  const meta = _meta(p);
  if (meta && (meta.grade || meta.source_set || meta.corroboration != null)) {
    const corr = meta.corroboration != null ? Number(meta.corroboration)
      : (Array.isArray(meta.source_set) ? corroborationCount(meta.source_set) : 1);
    return calibratedConfidence({ grade: meta.grade || 'B', corroboration: corr });
  }
  const c = Number(p && p.confidence);
  return Number.isFinite(c) ? c : NaN;
}

// The name(s) a proposal touches — an entity has one, a relation has both
// endpoints (BOTH must be civic or the edge is drift).
function _names(p) {
  return [p && p.name, p && p.source_name, p && p.target_name].filter(Boolean);
}

function classify(p, { promoteFloor = PROMOTE_FLOOR, reviewFloor = REVIEW_FLOOR } = {}) {
  for (const nm of _names(p)) {
    const d = isCivic({ name: nm });
    if (!d.civic) return { decision: 'reject', reason: `off-domain:${d.reason}`, confidence: null };
  }
  const conf = effectiveConfidence(p);
  if (!(conf >= 0)) return { decision: 'hold', reason: 'no-confidence', confidence: null };
  if (conf >= promoteFloor) return { decision: 'promote', reason: 'trustworthy', confidence: conf };
  if (conf >= reviewFloor) return { decision: 'review', reason: 'mid-band', confidence: conf };
  return { decision: 'hold', reason: 'below-floor', confidence: conf };
}

// Partition a queue into the four buckets + counts. The operator promotes the
// `promote` bucket; `review` is the human-glance queue; `reject` is drift to purge.
function gate(proposals, opts = {}) {
  const out = { promote: [], review: [], hold: [], reject: [] };
  for (const p of (Array.isArray(proposals) ? proposals : [])) {
    const c = classify(p, opts);
    out[c.decision].push(Object.assign({}, p, { _gate: c }));
  }
  out.counts = {
    promote: out.promote.length, review: out.review.length,
    hold: out.hold.length, reject: out.reject.length,
  };
  return out;
}

module.exports = { PROMOTE_FLOOR, REVIEW_FLOOR, effectiveConfidence, classify, gate };
