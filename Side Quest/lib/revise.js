/**
 * lib/revise.js — the shared BELIEF-REVISION pipeline (reconciliation §7). The one place a producer
 * (chat correction, directed-research finding, later: news) hands a Claim and gets back "what to write."
 *
 * The Pam Bondi law: new information must ACCRETE back into the substrate, RECONCILED — not appended as a
 * loose note. reconcile.js is the deterministic decision (new|merge|supersede|append|reject|ask); this
 * module runs a Claim through it against the current belief and, when the decision says write, produces the
 * verified_fact record — shaped exactly like learning.js's so the LIVE precedence gate + retrieval boost
 * consume it unchanged. The winning fact carries its corroboration + a supersedes_ref so the overnight
 * promotion (promote.js §6) can emit the SUPERSEDES edge into Echo long-term.
 *
 * Pure orchestration; ALL I/O injected (lookupIncumbent / writeFact) → fully offline-testable. No cloud in
 * the decision (reconcile is deterministic); the producer does any NL extraction before calling in.
 */
'use strict';

const VERIFIED_IMPORTANCE = 0.9;   // matches learning.js — dated facts get the retrieval boost weight

function _slug(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
// The supersede SLOT key — a verified_fact for the same subject fills the same slot (learning.js semantics).
function subjectKeyOf(claim, { slugify = _slug } = {}) {
  const s = claim && claim.subject;
  return slugify((s && (s.key || s.name)) || (claim && claim.value) || '');
}

// A passing Claim → the verified_fact memory record. Provenance carries what the LIVE consumers need:
// as_of (staleness/precedence), subject_key (the slot), capturedBy (precedence authority — 'chat-correction'
// / 'directed-research' etc. → authoritative), plus the reconcile corroboration + supersedes_ref for promote.
function toVerifiedRecord(claim, decision, { subjectKey, capturedBy, now = Date.now(), importance = VERIFIED_IMPORTANCE } = {}) {
  const cites = (claim && Array.isArray(claim.citations) ? claim.citations : []).filter(Boolean);
  const url = (cites.find(c => c && c.url) || {}).url || (claim && claim.provenance === 'told' ? 'chat (Lucas)' : null);
  const asOf = (claim && claim.as_of) || null;
  return {
    kind: 'note', content: String((claim && claim.value) || '').trim(), source: 'verified_fact',
    importance, level: 'fact',
    provenance: {
      url, as_of: asOf, dated: !!asOf,
      subject: (claim && claim.subject && claim.subject.name) || null,
      subject_key: subjectKey,
      capturedBy: capturedBy || (claim && claim.lane) || 'revise',
      lane: (claim && claim.lane) || null,
      citations: cites.slice(0, 6).map(c => ({ url: c.url || null, title: c.title || null, authority_tier: c.authority_tier || 0 })),
      corroboration: decision && decision.corroboration ? decision.corroboration : null,
      supersedes: (decision && decision.supersedes_ref != null) ? decision.supersedes_ref : null,
      action: decision && decision.action,
    },
  };
}

// THE PIPELINE. claim → reconcile(claim, incumbent) → on new|merge|supersede|append, produce + write the
// verified_fact record. reject|ask → write nothing (the caller may surface an ASK). Returns the outcome so a
// producer/UI can report ("superseded the stale record", "asked which entity", "rejected — no citation").
async function reviseBelief(claim, { lookupIncumbent = null, writeFact = null, onSupersede = null, capturedBy = null, now = Date.now(), importance = VERIFIED_IMPORTANCE, ambient = false, deps = {} } = {}) {
  const R = deps.reconcile || require('./reconcile');
  const subjectKey = subjectKeyOf(claim, deps);
  let incumbent = null;
  if (lookupIncumbent && subjectKey) { try { incumbent = await lookupIncumbent(subjectKey, claim); } catch { incumbent = null; } }
  const resolution = (claim && claim.subject && claim.subject.resolution) || undefined;
  // ambient=true marks a fire-and-forget single-read lane (realtime capture) → reconcile guards stable supersede.
  const decision = R.reconcile(claim, incumbent, { deps, now, resolution, ambient });
  const doWrite = decision.action === 'new' || decision.action === 'merge' || decision.action === 'supersede' || decision.action === 'append';
  if (!doWrite) return { action: decision.action, reason: decision.reason, wrote: false, record: null, decision, subjectKey };
  const record = toVerifiedRecord(claim, decision, { subjectKey, capturedBy, now, importance });
  let wrote = false;
  if (writeFact) { try { await writeFact(record, decision, incumbent); wrote = true; } catch (e) { return { action: decision.action, wrote: false, error: e.message, record, decision, subjectKey }; } }
  // On SUPERSEDE, RETIRE the stale incumbent so it stops competing in recall (the correction sticks, not
  // just out-ranks). onSupersede(incumbentRef, record, incumbent) is the caller's demote/tag — fail-soft.
  let retired = false;
  if (decision.action === 'supersede' && onSupersede && decision.supersedes_ref != null) {
    try { await onSupersede(decision.supersedes_ref, record, incumbent); retired = true; } catch {}
  }
  return { action: decision.action, reason: decision.reason, wrote, retired, record, decision, subjectKey, supersedes: record.provenance.supersedes };
}

module.exports = { reviseBelief, toVerifiedRecord, subjectKeyOf, VERIFIED_IMPORTANCE, _slug };
