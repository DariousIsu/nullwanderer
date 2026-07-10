/* studio/puller_revise.js — Puller single-dossier WRITE engine (the negative-signal loop in action).
 *
 * Three operator actions, all deterministic over the store (lib/puller_db) + the pure math
 * (puller_beliefs) + the qualification ratchet (puller_confidence). No model. The xlsx/CSV/API
 * readers are separate — they all funnel into applyVerification, which is the single pathway.
 *
 *   applyVerification   one verify result → record evidence, nudge the domain pattern belief,
 *                       re-qualify the held value; on a negative, derive the next pattern and
 *                       PROPOSE a flip (operator approves) + enqueue a retest. Catch-all gated.
 *   decideRevision      accept → apply the proposed flip (new held value, re-qualified) ;
 *                       reject → keep the (now-conflicted) current value, tombstone the proposal.
 *   markDedicatedSource grade-A path: record an official source (business card / directory) →
 *                       set it as the held value → qualification ratchets to 100%.
 *
 * Promotion / Echo-write live in the IPC layer (Slice 5) — kept out so this stays offline-testable.
 */
'use strict';
const db = require('../lib/puller_db');
const B = require('./puller_beliefs');
const Q = require('./puller_confidence');
const SS = require('../lib/puller_supersession');   // F5.2: belief flips obey the D2 supersession law
const PF = require('../lib/email_prefilter');        // FP2: role-address detection

const IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;          // FP13: a re-uploaded identical result within 24h = duplicate

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const domainOf = (email, fallback) => { const e = norm(email); const i = e.indexOf('@'); return i > 0 ? e.slice(i + 1) : (fallback || null); };
const localOf = (email) => { const e = norm(email); const i = e.indexOf('@'); return i > 0 ? e.slice(0, i) : e; };

// verify raw status → (observation kind, is-negative, is-catch-all)
const KIND = { valid: 'verified', deliverable: 'verified', invalid: 'bounce', undeliverable: 'bounce',
               accept_all: 'accept_all', 'catch-all': 'accept_all', catchall: 'accept_all',
               unknown: 'unknown', risky: 'unknown' };

// Re-qualify a target's email belief for the value it currently holds, and persist the confidence.
function requalifyEmail(targetId, heldValue) {
  const obs = db.listObservations(targetId, { attr: 'email' });
  const q = Q.qualify(obs, heldValue);
  db.upsertBelief(targetId, 'email', {
    value: heldValue, confidence: q.confidence,
    derivation: `qualified:${q.grade || 'none'}${q.conflicted ? '/conflict' : ''}`,
  });
  return q;
}

// Apply one verification result to a contact's email (the funnel for manual / file / API negatives).
function applyVerification(targetId, { value, result, idempotent = false } = {}) {
  const t = db.getTarget(targetId);
  if (!t) throw new Error(`applyVerification: no target ${targetId}`);
  const email = norm(value);
  const r = norm(result);
  const domain = domainOf(email, t.domain);
  let obsKind = KIND[r] || 'unknown';
  const out = { result: r, observationId: null, confidence: null, grade: null,
                revisionId: null, retestId: null, patternFlip: null, catchAll: false, infraSuspect: false };

  // FP13 (re-upload idempotency): when applied from a BATCH upload, an identical verification result already
  // recorded for this value in the last 24h is a duplicate (a re-uploaded file / repeated webhook) — skip so
  // it doesn't re-count the miss, re-propose a flip, or re-enqueue a retest. Manual marks pass idempotent=false.
  if (idempotent) {
    const dup = db.listObservations(targetId, { attr: 'email' }).some((o) =>
      o.source === 'verification' && String(o.value || '').toLowerCase() === email
      && o.meta && o.meta.result === r && (Date.now() - (o.captured_at || 0)) < IDEMPOTENCY_MS);
    if (dup) { out.skipped = 'duplicate'; return out; }
  }

  // domain pattern belief — catch-all marks the domain untrustworthy; otherwise credit hit/miss
  let st = db.getPatternState(domain);
  // FP8 (dirty-list guard): on a CATCH-ALL domain a "valid/delivered" proves nothing — the server accepts
  // every address — so it must NOT grade the mailbox as independently-verified. Downgrade to an ungradeable
  // observation (qualify() ignores 'catchall_accept') so a test-send to a catch-all can't fabricate a grade-B.
  if (obsKind === 'verified' && B.isCatchAll(st)) { obsKind = 'catchall_accept'; out.catchAll = true; }

  out.observationId = db.addObservation(targetId, { attr: 'email', value: email, kind: obsKind, source: 'verification', meta: { result: r } });
  if (obsKind === 'accept_all') {
    st = B.updateBelief(st, null, 'accept_all'); db.savePatternState(domain, st); out.catchAll = true;
  } else if (domain && (r === 'valid' || r === 'deliverable' || r === 'invalid' || r === 'undeliverable') && !B.isCatchAll(st)) {
    const pat = B.detectPatternUsed(email, t.name, domain);
    if (pat) { st = B.updateBelief(st, pat, r); db.savePatternState(domain, st); }
  }

  // re-qualify the value the dossier holds (may differ from the just-verified value)
  const cur = db.getBelief(targetId, 'email');
  const heldValue = cur && cur.value ? cur.value : email;
  const q = requalifyEmail(targetId, heldValue);
  out.confidence = q.confidence; out.grade = q.grade;

  // negative on the HELD value → propose the next-pattern flip + enqueue a retest (unless catch-all).
  // FP2 (role-address guard): a bounce on a shared role mailbox (info@/support@) is NOT a name-pattern miss —
  // there's no personal pattern to flip to — so don't derive a next pattern or enqueue a retest for it.
  if ((r === 'invalid' || r === 'undeliverable') && norm(heldValue) === email && domain && !B.isCatchAll(st) && PF.isRole(localOf(heldValue))) {
    out.roleAddress = true;
  } else if ((r === 'invalid' || r === 'undeliverable') && norm(heldValue) === email && domain && !B.isCatchAll(st)) {
    if (B.looksInfraBlocked(st)) {
      // Gateway-block: a strong-prior domain that only bounces is a sender-reputation/infra problem,
      // not a pattern miss — pausing beats burning retests + chasing the wrong fix. No flip, no retest.
      out.infraSuspect = true;
    } else {
      const usedPat = B.detectPatternUsed(heldValue, t.name, domain);
      const tried = usedPat ? [usedPat] : [];
      const nc = B.nextCandidate(st, t.name, domain, tried);   // skips non-derivable (e.g. middle-name) patterns
      if (nc) {
        out.patternFlip = { from: heldValue, fromPattern: usedPat, toPattern: nc.pattern, to: nc.email };
        out.revisionId = db.proposeRevision({
          subjectKind: 'belief', subjectRef: String(cur ? cur.id : targetId), targetId, attr: 'email',
          fromValue: heldValue, toValue: nc.email, triggerObsId: out.observationId,
          rationale: `${heldValue} bounced; next pattern ${nc.pattern} → ${nc.email}`,
        });
        out.retestId = db.enqueueRetest({
          targetId, person: t.name, company: t.company, domain,
          patternsTried: tried, nextPattern: nc.pattern,
          previousAttempts: [{ email: heldValue, result: r }],
        });
      }
    }
  }
  return out;
}

// Cascade (§4.4 r2): after a domain's belief shifts, re-derive every QUEUED retest at that domain so a
// pending guess reflects the current best pattern. Returns the list of items whose next-pattern changed.
function cascadeForDomain(domain) {
  const st = db.getPatternState(domain);
  const updated = [];
  for (const item of db.listRetests({ status: 'queued' }).filter(r => r.domain === domain)) {
    const nc = B.nextCandidate(st, item.person, domain, item.patterns_tried || []);
    if (nc && nc.pattern !== item.next_pattern) {
      db.updateRetest(item.id, { nextPattern: nc.pattern });
      updated.push({ id: item.id, person: item.person, from: item.next_pattern, to: nc.pattern, email: nc.email });
    }
  }
  return updated;
}

// Operator decides a proposed revision. Accept applies the flip (new held value, re-qualified);
// reject tombstones it and the current (conflicted) value stands.
function decideRevision(revisionId, decision) {
  const rev = db.decideRevision(revisionId, decision);
  if (!rev) return null;
  const out = { id: revisionId, decision, applied: false, superseded: false, confidence: null, grade: null };
  if (decision === 'accepted' && rev.subject_kind === 'belief' && rev.attr === 'email' && rev.target_id && rev.to_value) {
    const newV = norm(rev.to_value);
    // F5.2: a belief flip is a REPLACEMENT of a functional attribute — adjudicate it with the SAME D2 law
    // the KG uses (world-time newer + clears the confidence floor + anti-pattern guard). A stale/weak flip
    // is refused, not silently applied. The next-pattern guess grades as a best-guess (D → cap 0.50).
    const cur = db.getBelief(rev.target_id, 'email');
    const from = cur ? { value: cur.value, validFrom: cur.updated_at || 1, confidence: cur.confidence } : null;
    const to = { value: newV, validFrom: Date.now(), confidence: Q.cap('D') };
    const adj = from ? SS.supersessionForFlip({ targetId: rev.target_id, attr: 'email', from, to })
                     : { approved: true, reason: 'first-assert' };
    if (adj.approved) {
      db.addObservation(rev.target_id, { attr: 'email', value: newV, kind: 'derived', source: 'revision-accept',
        meta: { supersedes: from && from.value, reason: adj.reason } });
      const q = requalifyEmail(rev.target_id, newV);
      out.applied = true; out.superseded = !!from; out.confidence = q.confidence; out.grade = q.grade; out.supersessionReason = adj.reason;
    } else {
      out.applied = false; out.rejectedReason = adj.reason;   // stale-would-regress / weak-new / same-value
    }
  }
  return out;
}

// Grade-A path: an official dedicated source (business card / directory / owner-confirmed). Sets that
// value as held and ratchets qualification to 100% (capped ratchet — A is the only path to 100).
function markDedicatedSource(targetId, { value, note } = {}) {
  const t = db.getTarget(targetId);
  if (!t) throw new Error(`markDedicatedSource: no target ${targetId}`);
  const v = norm(value);
  if (!v) throw new Error('markDedicatedSource: value required');
  db.addObservation(targetId, { attr: 'email', value: v, kind: 'business_card', source: note || 'dedicated source' });
  const q = requalifyEmail(targetId, v);
  return { confidence: q.confidence, grade: q.grade };
}

module.exports = { applyVerification, decideRevision, markDedicatedSource, requalifyEmail, cascadeForDomain };
