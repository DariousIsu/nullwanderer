/**
 * lib/belief_correction.js — the CHAT-correction adapter (reconciliation §7, chat lane). When Lucas corrects
 * a FACT ("no — Bondi stepped down in April"), that correction must become a HIGH-AUTHORITY verified_fact so
 * recall leads with it next time. The gap it fills: capture only ever ran on text she READ (the enrich loop)
 * — a user's spoken correction was never banked at all, so it evaporated after the turn.
 *
 * (Distinct from lib/correction.js, which reshapes an active RESEARCH RUN's work-list. This corrects a
 * BELIEF/fact and feeds the reconciliation substrate.)
 *
 * Detect a correction cue (cheap, pure) → extract the asserted CLAIM|SUBJECT|AS_OF (cloud, injected) → emit
 * a Claim{provenance:'told', authority 3, lane:'chat'} → the shared revise.js pipeline reconciles it against
 * the current belief and writes the verified_fact (capturedBy:'chat-correction' → precedence authority 3).
 * Non-corrections and cue-without-a-claim bank nothing. Fire-and-forget from the turn; never blocks the reply.
 */
'use strict';

// Correction / operator-assertion cues. A false positive is harmless — extraction gates the actual write
// (no claim → nothing banked) — so this can be generous, but we still require substance (below) to avoid
// firing on "no thanks".
const _CORRECTION_RE = /\b(no,|not\s+(?:quite|right|correct|true|anymore|any\s+more)|that'?s\s+(?:not\s+right|wrong|incorrect|inaccurate|outdated|out\s+of\s+date|old)|actually,?|in\s+fact\b|correction\b|to\s+correct\b|\bwrong\b|\bincorrect\b|it'?s\s+(?:actually|now)\b|(?:he|she|they|it)'?s\s+no\s+longer\b|no\s+longer\b|as\s+of\b|for\s+the\s+record\b|remember\s+that\b|note\s+that\b|update:)/i;

// Is this user message a factual correction/assertion worth banking? Pure + cheap. Requires a cue AND
// substance (a multi-word assertion or a proper-noun/year) so "no thanks" / "actually nvm" don't trigger.
function detectCorrection(msg, { priorAnswer = '' } = {}) {
  const t = String(msg || '').trim();
  if (!t) return { isCorrection: false, cue: null };
  const m = t.match(_CORRECTION_RE);
  if (!m) return { isCorrection: false, cue: null };
  const words = t.split(/\s+/).filter(Boolean).length;
  const hasAnchor = /[A-Z][a-z]+/.test(t.replace(/^\W*(no|actually|correction|wrong|update)\b/i, '')) || /\b\d{4}\b/.test(t);
  if (words < 4 && !hasAnchor) return { isCorrection: false, cue: null };
  return { isCorrection: true, cue: m[0].trim().toLowerCase() };
}

// An extracted claim candidate ({claim, subject, asOf}) → a chat-lane Claim for the revise pipeline. The
// operator telling her IS one authoritative report (provenance 'told', authority_tier 3). undated → as_of
// today (a correction is asserted NOW) so it can out-date a stale undated incumbent.
function buildCorrectionClaim(cand, { now = Date.now() } = {}) {
  if (!cand || !cand.claim) return null;
  const asOf = _normAsOf(cand.asOf) || new Date(now).toISOString().slice(0, 10);
  return {
    kind: cand.kind || 'entity',
    subject: { name: String(cand.subject || '').trim() || String(cand.claim).slice(0, 60), type: cand.type || null },
    predicate: cand.predicate || null,
    object: cand.object || null,
    value: String(cand.claim).trim(),
    as_of: asOf,
    ttl_class: cand.ttl_class || null,
    citations: [{ source_id: 'chat', title: 'operator correction', authority_tier: 3, fetched_at: now }],
    provenance: 'told',
    lane: 'chat',
  };
}
function _normAsOf(raw) { const m = String(raw || '').trim().match(/^(\d{4}(?:-\d{2}(?:-\d{2})?)?)/); return m ? m[1] : null; }

// The adapter: detect → extract (injected cloud) → build Claim → reviseBelief. Returns a per-correction
// outcome. Fail-soft: any miss returns {captured:0}. extractFn(userMessage, {priorAnswer}) → [candidate].
async function captureCorrection({ userMessage, priorAnswer = '', extractFn = null, lookupIncumbent = null, writeFact = null, onSupersede = null, now = Date.now(), deps = {} } = {}) {
  const det = detectCorrection(userMessage, { priorAnswer });
  if (!det.isCorrection) return { captured: 0, skipped: 'not-a-correction' };
  if (!extractFn) return { captured: 0, skipped: 'no-extractor' };
  let cands = [];
  try { cands = (await extractFn(userMessage, { priorAnswer })) || []; } catch { cands = []; }
  if (!cands.length) return { captured: 0, skipped: 'no-claim', cue: det.cue };
  const revise = deps.reviseBelief || require('./revise').reviseBelief;
  const out = [];
  for (const cand of cands.slice(0, 3)) {
    const claim = buildCorrectionClaim(cand, { now });
    if (!claim) continue;
    try { out.push(await revise(claim, { lookupIncumbent, writeFact, onSupersede, capturedBy: 'chat-correction', now, deps })); } catch {}
  }
  return { captured: out.filter(r => r && r.wrote).length, cue: det.cue, outcomes: out };
}

module.exports = { detectCorrection, buildCorrectionClaim, captureCorrection, _CORRECTION_RE };
