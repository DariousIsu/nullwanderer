'use strict';
/**
 * lib/promote_gate.js — the confidence + domain gate that closes the landing loop.
 *
 * SUBSTANTIATION INVERSION (Lucas 2026-07-15, decision #1; docs/SUBSTANTIATION_GRADING_DESIGN.md §4):
 * grade is a PRIORITY tag, NOT a gate. Anything SUBSTANTIATED (source-vouched or identity-confirmed) is safe
 * to promote at ANY confidence — the calibrated confidence rides along as an EXPLORE-PRIORITY score (a LOW
 * grade means "dig here first", never "reject"). Only the UNSUBSTANTIATED stay short-term (prove-or-fade;
 * Slice 4 proves them, Slice 6 fades them). A thin BOTTOM FLOOR remains: a junk/spoofed source can't vouch,
 * so it never counts as substantiated. This REPLACES the old 0.90 calibrated-confidence floor — which parked
 * a lone authoritative source forever ("local official on their one .gov page").
 *
 *   promote  — SUBSTANTIATED (a real non-junk source, or resolved to a known node) → promotes at ANY
 *              confidence; OR an ungrounded-but-confident claim (kept from the old floor) that ingest_lane
 *              then routes to RESEARCH to find its citation before it can auto-promote (the grounding anchor).
 *   review   — mid-band unsubstantiated → an operator glance / research to corroborate
 *   hold     — thin / uncited / junk-only → stays short-term, prove-or-fade
 *
 * The INVERSION removes the 0.90 floor for SUBSTANTIATED proposals ONLY (the fix: a lone authoritative source
 * promotes without the 2nd source it can never get). UNSUBSTANTIATED proposals KEEP the confidence-band
 * routing so the prove-or-fade path still runs (research_lane citation-finding now; Slice-4 async lane later).
 * The grounding anchor is preserved downstream: ingest_lane auto-promotes the `promote` band only when the
 * proposal ALSO carries a real citation — so nothing ungrounded slips through to the live graph.
 *
 * TOPIC IS NOT A GATE. This is a living graph — it absorbs and expands ANYTHING it's handed. Domain and
 * substantiation are ORTHOGONAL: substantiation answers "is it real/backed?", topic answers "how central?"
 * — the latter never discards an edge, only helps prioritize the civic core. So `classify` attaches a
 * `domain` TAG ('civic' | 'off-domain') but NEVER rejects on it. Pure + deterministic.
 */

const { isCivic } = require('./civic_domain');
const { calibratedConfidence } = require('./confidence_model');
const { corroborationCount } = require('./corroboration');
const substantiation = require('./substantiation');   // Slice 3 — the state classifier the inversion gates on

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

// The proposal's provenance, shaped for the substantiation classifier: the cited source_set (as {url}
// records for the junk-host check), a single url, and the producing feed. Reads either the parsed metadata
// or the raw fields, mirroring effectiveConfidence/isGrounded.
function _provenance(p) {
  const meta = _meta(p) || {};
  const ss = Array.isArray(meta.source_set) ? meta.source_set
    : (Array.isArray(p && p.source_set) ? p.source_set : null);
  const sources = ss ? ss.map((u) => ({ url: u })) : null;
  const url = (p && p.url) || meta.url || null;
  const feed = (p && (p.feed || p.source)) || meta.feed || null;
  return { url, sources, feed };
}

// The substantiation STATE of a promotion proposal (Slice 3). source-vouched when a real non-junk citation
// backs it; identity-confirmed when it resolved to a known node; else unsubstantiated. This is what the
// inversion gates on — grade/confidence is priority, not the gate.
function substantiationState(p) {
  const { url, sources, feed } = _provenance(p);
  return substantiation.classifySubstantiation({ resolved: !!(p && p.resolved === true), url, sources, feed });
}

function classify(p, { promoteFloor = PROMOTE_FLOOR, reviewFloor = REVIEW_FLOOR } = {}) {
  // Domain is a TAG, never a veto — a sports/celebrity edge can carry real civic weight, and its reality
  // (substantiation) is independent of its topic. We record the domain so the operator can prioritize the
  // civic core, but the DECISION is substantiation-first. An off-domain endpoint tags the proposal off-domain.
  let domain = 'civic', domainReason = null;
  for (const nm of _names(p)) {
    const d = isCivic({ name: nm });
    if (!d.civic) { domain = 'off-domain'; domainReason = d.reason; break; }
  }
  const tag = { domain, domainReason };
  const conf = effectiveConfidence(p);                 // now the EXPLORE-PRIORITY score, not a hard gate
  const state = substantiationState(p);
  // DECISION #1 INVERSION (the core change): a SUBSTANTIATED proposal (real non-junk source, or resolved to a
  // known node) promotes at ANY confidence — the calibrated confidence becomes an explore-priority score, not
  // a floor. This lifts a lone authoritative/cited source over the old 0.90 bar (which parked "the official's
  // one .gov page" forever). A junk-only source never substantiates (classifySubstantiation = the bottom floor).
  if (substantiation.isSubstantiated(state)) {
    return { decision: 'promote', reason: 'substantiated', state, confidence: (conf >= 0 ? conf : null), ...tag };
  }
  // UNSUBSTANTIATED (uncited / inferred / junk-only): KEEP the confidence-band routing so the prove-or-fade
  // path still runs — an ungrounded-but-confident claim is routed to RESEARCH to find a real citation
  // (ingest_lane's grounding gate) before it can auto-promote; a thin one holds. Slice-4's async lane also
  // proves these from the observation ledger. Grade/confidence still rides as the priority score.
  if (!(conf >= 0)) return { decision: 'hold', reason: 'no-confidence', state, confidence: null, ...tag };
  if (conf >= promoteFloor) return { decision: 'promote', reason: 'confident-ungrounded', state, confidence: conf, ...tag };
  if (conf >= reviewFloor) return { decision: 'review', reason: 'mid-band', state, confidence: conf, ...tag };
  return { decision: 'hold', reason: 'below-floor', state, confidence: conf, ...tag };
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

module.exports = { PROMOTE_FLOOR, REVIEW_FLOOR, effectiveConfidence, substantiationState, classify, gate };
