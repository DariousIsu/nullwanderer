'use strict';
/**
 * lib/puller_supersession.js — F5.2: route a Puller BELIEF FLIP through the D2 supersession machinery.
 *
 * A Puller belief is single-valued per (target, attribute) — a person has ONE current email, ONE current
 * employer. So a flip (email A → email B after A bounced, or an enrichment finding a newer address) is
 * exactly a REPLACEMENT of a FUNCTIONAL predicate — the same shape lib/supersession already adjudicates for
 * the KG. Rather than let the Puller flip beliefs on its own ad-hoc rule, this expresses the flip as two
 * synthetic edges (subject = the target, predicate = the attribute, value = the email) and runs them through
 * `replacementCandidates`, inheriting the D2 LAW for free:
 *
 *   • decided on WORLD-TIME valid_from, never ingest order — a late-arriving OLD value can NOT overwrite a
 *     newer one (the anti-pattern guard: the whole reason the KG supersession exists).
 *   • confidence-FLOORED — never supersede a live value on a weak new guess.
 *   • same value → no-op; proposal-first — the caller decides whether to apply.
 *
 * So the Puller's belief revision and the KG's edge replacement are now ONE model of "this fact was
 * replaced" — the certainty story (lib/certainty) and the supersession story now speak the same law.
 */

const S = require('./supersession');

// Puller attributes that are single-valued per person → functional predicates for the D2 adjudicator.
const PULLER_FUNCTIONAL = new Set(['EMAIL', 'PHONE', 'ROLE', 'EMPLOYER', 'ADDRESS', 'AFFILIATION']);
const DEFAULT_CONF_FLOOR = 0.5;

// Stable non-negative integer key for a value string (so identical values share a target_id → the D2
// "same value → not a replacement" skip fires). Different values → different keys.
function _valueKey(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h || 1;
}

/**
 * supersessionForFlip({ targetId, attr, from, to, confFloor }) → { approved, reason, candidate }
 *   from/to: { value, validFrom, confidence } — validFrom is world-time (epoch/year/ISO; _num-comparable).
 * approved === true only when `to` is a genuine D2 replacement of `from`: a DIFFERENT value, a LATER
 * valid_from, and `to.confidence` clearing the floor. Otherwise `reason` says why the flip is refused
 * (same-value / stale-would-regress / weak-new / not-orderable).
 */
function supersessionForFlip({ targetId, attr, from, to, confFloor = DEFAULT_CONF_FLOOR } = {}) {
  const pred = String(attr || '').toUpperCase();
  if (!from || !to || from.value == null || to.value == null) return { approved: false, reason: 'missing-value', candidate: null };
  if (_valueKey(from.value) === _valueKey(to.value)) return { approved: false, reason: 'same-value', candidate: null };
  const fv = from.validFrom, tv = to.validFrom;
  if (fv == null || tv == null) return { approved: false, reason: 'not-orderable', candidate: null };

  const edges = [
    { id: 'from', source_id: targetId, target_id: _valueKey(from.value), relation: pred, validFrom: fv, confidence: from.confidence, targetName: from.value },
    { id: 'to', source_id: targetId, target_id: _valueKey(to.value), relation: pred, validFrom: tv, confidence: to.confidence, targetName: to.value },
  ];
  const functional = new Set([...PULLER_FUNCTIONAL, pred]);
  const cands = S.replacementCandidates(edges, { functional, confFloor });
  const win = cands.find((c) => c.supersededId === 'from' && c.supersededBy === 'to');
  if (win) return { approved: true, reason: 'newer_valid_from', candidate: win };
  // a candidate the OTHER way means `to` is the STALE one — refuse (anti-pattern guard did its job)
  const regress = cands.find((c) => c.supersededId === 'to' && c.supersededBy === 'from');
  if (regress) return { approved: false, reason: 'stale-would-regress', candidate: regress };
  // no candidate at all → the winner failed the confidence floor (weak new value)
  return { approved: false, reason: 'weak-new-value', candidate: null };
}

/**
 * flipViaSupersession(db, opts) — apply a belief flip ONLY if the D2 adjudicator approves. Reads the current
 * belief as `from`, adjudicates against the proposed `to`, and on approval marks the old value superseded on
 * the append-only observation trail (the history), then upserts the new active belief. Refusals are returned,
 * not thrown (a stale/weak flip is a legitimate "don't"). Reversible: the old observation stays; the belief
 * row can be re-flipped. `from.validFrom` defaults to the current belief's updated_at; `to.validFrom` to now.
 *   opts: { targetId, attr, toValue, toConfidence, toValidFrom?, reason?, now? }
 */
function flipViaSupersession(db, { targetId, attr = 'email', toValue, toConfidence = null, toValidFrom = null, reason = null, now = null } = {}) {
  const belief = db.getBelief(targetId, attr);
  const from = belief ? { value: belief.value, validFrom: belief.updated_at || 1, confidence: belief.confidence } : null;
  const nowMs = Number(now) || Date.now();
  const to = { value: toValue, validFrom: toValidFrom != null ? toValidFrom : nowMs, confidence: toConfidence };

  if (!from) {   // no prior belief → not a replacement, just a first assertion
    db.addObservation(targetId, { attr, value: toValue, kind: 'derived', source: 'supersession-first', confidence: toConfidence });
    db.upsertBelief(targetId, attr, { value: toValue, confidence: toConfidence, derivation: 'first-assert' });
    return { applied: true, superseded: false, reason: 'first-assert' };
  }

  const adj = supersessionForFlip({ targetId, attr, from, to });
  if (!adj.approved) return { applied: false, superseded: false, reason: adj.reason, from: from.value, to: toValue };

  // record the supersession on the append-only trail, then flip the (single-valued) belief to the new truth
  db.addObservation(targetId, { attr, value: from.value, kind: 'superseded', source: 'supersession',
    meta: { supersededBy: toValue, reason: reason || adj.reason, at: nowMs } });
  db.addObservation(targetId, { attr, value: toValue, kind: 'derived', source: 'supersession',
    confidence: toConfidence, meta: { supersedes: from.value } });
  db.upsertBelief(targetId, attr, { value: toValue, confidence: toConfidence,
    derivation: `superseded:${from.value}`, status: 'active' });
  return { applied: true, superseded: true, reason: adj.reason, from: from.value, to: toValue, candidate: adj.candidate };
}

module.exports = { PULLER_FUNCTIONAL, DEFAULT_CONF_FLOOR, supersessionForFlip, flipViaSupersession, _valueKey };
