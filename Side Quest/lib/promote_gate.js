'use strict';
/**
 * lib/promote_gate.js — the confidence + domain gate that closes the landing loop.
 *
 * The audit's core failure: proposals accrue in tenant staging but nothing lands
 * in civic_graph (operator-gated by design — good — but the loop never closes).
 * With the confidence engine (C1–C4) live, we tell the OPERATOR which queued
 * proposals are safe to bulk-promote — ranked purely on CONFIDENCE (is it true /
 * well-sourced), which is what "safe to promote" means:
 *
 *   promote  — trustworthy: calibrated confidence in the A-band
 *   review   — mid-band: worth an operator glance
 *   hold     — below floor: chase corroboration / a better source first
 *
 * TOPIC IS NOT A GATE. This is a living graph — it absorbs and expands ANYTHING
 * it's handed (a World-Cup match can be a major political story; a celebrity's
 * connections matter the moment they're across a table from you). Domain and
 * quality are ORTHOGONAL: confidence answers "is it true?", topic answers "how
 * central is it?" — the latter never discards an edge, it only helps the operator
 * prioritize the civic core. So `classify` attaches a `domain` TAG ('civic' |
 * 'off-domain') but NEVER rejects on it. Promotion itself stays the operator's
 * action (Skuld charter: no silent auto-promote). Pure + deterministic.
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
  // Domain is a TAG, never a veto — a sports/celebrity edge can carry real civic
  // weight, and its truthfulness (confidence) is independent of its topic. We record
  // the domain so the operator can prioritize the civic core, but the DECISION is
  // confidence-only. An off-domain endpoint tags the whole proposal off-domain.
  let domain = 'civic', domainReason = null;
  for (const nm of _names(p)) {
    const d = isCivic({ name: nm });
    if (!d.civic) { domain = 'off-domain'; domainReason = d.reason; break; }
  }
  const tag = { domain, domainReason };
  const conf = effectiveConfidence(p);
  if (!(conf >= 0)) return { decision: 'hold', reason: 'no-confidence', confidence: null, ...tag };
  if (conf >= promoteFloor) return { decision: 'promote', reason: 'trustworthy', confidence: conf, ...tag };
  if (conf >= reviewFloor) return { decision: 'review', reason: 'mid-band', confidence: conf, ...tag };
  return { decision: 'hold', reason: 'below-floor', confidence: conf, ...tag };
}

// Partition a queue into buckets + counts. The operator promotes the `promote`
// bucket; `review` is the human-glance queue; `hold` waits for corroboration.
// `reject` is retained in the shape for API stability but is no longer populated
// (topic never discards a proposal — see classify). Each bucketed item carries its
// `_gate.domain` tag so the operator can sort the civic core to the top.
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
