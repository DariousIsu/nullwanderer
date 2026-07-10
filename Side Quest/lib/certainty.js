'use strict';
/**
 * lib/certainty.js — F5: the UNIFIED certainty model. One evidence state, two readings.
 *
 * The codebase grew two confidence numbers that looked like rivals:
 *   • KG (lib/confidence_model)     — P(true): grade-anchored prior where each INDEPENDENT corroboration
 *                                     RAISES belief (truth-discovery / Knowledge-Vault).
 *   • Puller (studio/puller_confidence) — SEND-SAFETY: a capped ratchet where confidence = the cap of the
 *                                     best grade and a negative (bounce) floors it; corroboration is listed
 *                                     but never pushes past the cap (whatever we send gets used).
 *
 * They are not rivals — they answer DIFFERENT QUESTIONS from the SAME evidence. This module makes that
 * explicit: it takes ONE evidence state {grade (authority), corroboration, age (recency), conflicted} and
 * projects BOTH readings off a SHARED authority×recency×corroboration computation. The two share the A–E
 * grade vocabulary AND the per-predicate recency-decay curve (lib/confidence_decay), so for the same
 * evidence they can never contradict — pTrue and sendConfidence move together with grade/age and diverge
 * only where the QUESTION differs (corroboration raises pTrue; the send cap holds sendConfidence). This is
 * the single import site the Puller and the KG both read certainty through.
 */

const model = require('./confidence_model');          // KG: grade prior + noisy-OR corroboration
const decay = require('./confidence_decay');           // shared recency: per-predicate half-life
const puller = require('../studio/puller_confidence');  // send-safety caps + negative floor

const CONF_FLOOR = 0.02, CONF_CEIL = 0.995;
const clamp = (x) => Math.max(CONF_FLOOR, Math.min(CONF_CEIL, x));

// A Puller contact ATTRIBUTE decays like the KG predicate it most resembles (research: contact info decays
// ~15–25%/yr — role/email churn with the job). So a Puller belief and a KG edge age on the SAME curve.
const ATTR_PREDICATE = {
  email: 'WORKS_FOR', phone: 'WORKS_FOR', role: 'HOLDS_OFFICE', employer: 'WORKS_FOR',
  affiliation: 'MEMBER_OF', address: 'LOCATED_IN', name: 'BORN_IN',   // a person's name doesn't decay
};

// The recency factor 0.5^(age/halfLife) for a predicate/attr — the SHARED multiplier both readings apply.
function recencyFactor(predicate, ageDays) {
  const hl = decay.halfLifeDays(predicate);
  if (!isFinite(hl)) return 1;                          // immutable → no decay
  return Math.pow(0.5, Math.max(0, Number(ageDays) || 0) / hl);
}

/**
 * certainty(evidence) → { grade, pTrue, sendConfidence, recency, predicate, corroboration }
 *   grade         A–E authority of the STRONGEST source
 *   corroboration count of INDEPENDENT sources (≥1)
 *   predicate     KG predicate for the decay half-life (else derived from `attr`, else MEDIUM default)
 *   attr          a Puller attribute (email/role/…) — maps to a predicate when `predicate` is absent
 *   ageDays       days since last verification (0 = fresh)
 *   conflicted    a negative on the held value (a bounce) → floors the SEND reading only
 *
 * pTrue          KG reading — corroboration RAISES it, then recency-decayed.
 * sendConfidence Puller reading — the grade CAP, recency-decayed, floored to NEG_CAP when conflicted.
 */
function certainty({ grade = 'C', corroboration = 1, predicate = null, attr = null, ageDays = 0, conflicted = false } = {}) {
  const g = String(grade == null ? 'C' : grade).trim().toUpperCase();
  const pred = predicate || (attr ? ATTR_PREDICATE[String(attr).toLowerCase()] : null) || null;
  const n = Math.max(1, Math.floor(Number(corroboration) || 1));
  const recency = recencyFactor(pred, ageDays);

  // KG: P(true) — grade prior lifted by independent corroboration, then aged.
  const pTrue = clamp(model.calibratedConfidence({ grade: g, corroboration: n }) * recency);

  // Puller: send-safety — the cap of the grade, aged; a bounce floors it to NEG_CAP.
  let sendConfidence = puller.cap(g) * recency;
  if (conflicted) sendConfidence = Math.min(sendConfidence, puller.NEG_CAP);
  sendConfidence = clamp(sendConfidence);

  return { grade: g, pTrue, sendConfidence, recency, predicate: pred, corroboration: n, conflicted: !!conflicted };
}

/**
 * fromObservations(observations, value, opts) — the Puller bridge: turn a per-attribute observation pile
 * into the unified certainty. Reuses puller_confidence.qualify for the grade + conflict determination
 * (so the SEND reading stays byte-identical to today's ratchet), counts the independent positive sources
 * for corroboration, and returns BOTH readings. This is how a Puller belief gains a KG-consumable pTrue
 * without changing its send-safety number.
 */
function fromObservations(observations, value, { ageDays = 0, attr = 'email', predicate = null } = {}) {
  const q = puller.qualify(observations, value);
  // independent corroboration = distinct positive SOURCES agreeing on this value (a gradeable observation)
  const want = String(value == null ? '' : value).trim().toLowerCase();
  const srcs = new Set();
  for (const o of (Array.isArray(observations) ? observations : [])) {
    if (want && String(o.value == null ? '' : o.value).trim().toLowerCase() !== want) continue;
    const grade = puller.gradeOf(o);
    if (grade && grade !== 'neg') srcs.add(String(o.source || o.kind || o.id || Math.random()));
  }
  const corroboration = Math.max(1, srcs.size);
  const c = certainty({ grade: q.grade || 'E', corroboration, attr, predicate, ageDays, conflicted: q.conflicted });
  // preserve the exact send ratchet (qualify already applied its cap/neg logic) — certainty's send reading
  // agrees at age 0; when aged, take the lower of the two (never present a stale value as safer than fresh).
  const sendConfidence = ageDays > 0 ? Math.min(q.confidence, c.sendConfidence) : q.confidence;
  return { ...c, grade: q.grade || c.grade, sendConfidence, qualification: q };
}

// Round-trip helpers so callers on either side speak one grade language.
function gradeFromConfidence(p) { return model.gradeFromConfidence(p); }
function gradeToPrior(grade) { return model.gradePrior(grade); }

module.exports = {
  certainty, fromObservations, recencyFactor, gradeFromConfidence, gradeToPrior,
  ATTR_PREDICATE, CONF_FLOOR, CONF_CEIL,
  // re-export the shared vocab so there is ONE certainty import site
  GRADE_PRIOR: model.GRADE_PRIOR, CAP: puller.CAP, NEG_CAP: puller.NEG_CAP,
};
