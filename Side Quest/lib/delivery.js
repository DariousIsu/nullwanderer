'use strict';
/* delivery.js — Spine 3 (delivery binding), docs/DELIVERY_BINDING_SPINE.md.
 *
 * The census disease: a reply PROMISES a deliverable ("I'll pull that roster together", "let me compile
 * the list") and the turn simply ends — no artifact, no tracking, the promise silently dies. This is the
 * delivery analog of the anti-fabrication gate: regex FINDS the promise, a STRUCTURAL check (was a
 * deliverable produced this turn?) decides, and an unkept promise is BOOKED on the recheck queue so it is
 * carried forward instead of dropped.
 *
 * Precision over recall by design: scoped to ARTIFACT-SHAPED promises (compile/assemble/build/draft/send a
 * roster/list/report/file/…), the exact failure shape — not every conversational "I'll". Offers ("want me
 * to?") and already-completed claims (the anti-fab gate's job) are excluded. Pure + injectable — no db, no
 * cloud. Run: node scripts/smoke_delivery.js */

// She is COMMITTING to do it (not offering, not asking). Future intent, first person.
const _PROMISE_LEAD = /\b(?:i'?ll|i will|i'?m going to|i'?m gonna|let me|going to|i'?ll go ahead and)\b/i;
// …but an OFFER or a question is not a debt — leave it open. "let me know" is HER asking THEM.
const _OFFER_RE = /\b(?:want me to|would you like|do you want|should i\b|shall i\b|if you'?d like|let me know|happy to|i can (?:also )?(?:help|do that)\b)|\?\s*$/i;
// the ACT of producing a deliverable
const _DELIVER_VERB = /\b(?:pull(?:ing)?(?: together| up)?|put(?:ting)? together|compil\w+|assembl\w+|build\w*|draft\w*|writ\w*|prepar\w+|generat\w+|creat\w+|send\w*|export\w*|deliver\w*|gather\w+|collect\w+|get you|grab)\b/i;
// …a THING to hand over. Artifact-shaped, or an explicit "that/it/them for you".
const _DELIVERABLE_OBJ = /\b(?:roster|list|spreadsheet|report|file|document|dossier|brief(?:ing)?|summary|table|memo|deck|csv|xlsx?|docx?|pdf|the e-?mails?|the contacts?|the numbers?|the data|the breakdown|the write-?up)\b|\b(?:that|it|them|those|this) for you\b/i;
// already CLAIMED done (past/perfect) → the anti-fabrication gate owns this, not us.
const _DONE_RE = /\b(?:i'?ve|i have|already|just)\b[^.!?\n]*\b(?:pulled|compiled|assembled|built|drafted|wrote|written|prepared|generated|created|sent|exported|put together)\b|\bis (?:saved|ready|done|attached|on your canvas)\b/i;

// Find the delivery PROMISES in a reply. Returns [{ sentence, deliverable }]. A promise requires: a
// committal lead + a deliver-verb + a deliverable object, and is NOT an offer/question and NOT a
// done-claim. Deliverable = the matched object phrase (the dedup subject).
function detectPromise(say) {
  const out = [];
  const sentences = String(say || '').split(/(?<=[.!?])\s+|\n+/);
  for (const sent of sentences) {
    const s = sent.trim();
    if (s.length < 8) continue;
    if (!_PROMISE_LEAD.test(s)) continue;
    if (_OFFER_RE.test(s)) continue;          // an offer/question is not a debt
    if (_DONE_RE.test(s)) continue;           // "I've already compiled it" → anti-fab's job, not ours
    if (!_DELIVER_VERB.test(s)) continue;
    const m = s.match(_DELIVERABLE_OBJ);
    if (!m) continue;
    out.push({ sentence: s.slice(0, 160), deliverable: m[0].replace(/\s+/g, ' ').trim() });
    if (out.length >= 3) break;               // one reply rarely makes more than a few real promises
  }
  return out;
}

// A stable dedup subject for the recheck queue: the deliverable phrase + a short hash of the sentence so
// two genuinely different promises don't collide, but a repeated one coalesces. Pure (no Date/random).
function bookingSubject({ deliverable, sentence }) {
  const base = String(deliverable || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim() || 'deliverable';
  const src = String(sentence || '');
  let h = 0;
  for (let i = 0; i < src.length; i++) { h = (h * 31 + src.charCodeAt(i)) | 0; }
  return `${base}#${(h >>> 0).toString(36)}`;
}

// ACK-ORPHAN (D-orphan, 2026-08-16 drill): the operator RAN but the cloud model ended its final message
// on a content-free acknowledgement ("writing it now — stand by, I'll paste the output shortly") instead
// of the actual result. Delivering that verbatim voices a PROMISE as the deliverable — the answer-orphan.
// True iff the answer is SHORT, LEADS/reads as an ack, and carries NO result payload (digits, a code
// fence, a markdown table row, a notes/ path, an exit code, or "rows"). A real result that merely OPENS
// with "on it, here's the data: <numbers>" carries a payload → NOT an orphan (must not over-fire). An
// honest empty/partial ("the analysis ran but returned 0 rows") carries a payload token → NOT an orphan.
const _ACK_LEAD = /\b(on it|stand ?by|first pass|writing it (?:now|up)|i'?ll (?:get|paste|send|have|share|run|write)|starting (?:on )?(?:that|it|this|now)|working on it|hang tight|bear with me|give me a (?:moment|sec|minute)|let me (?:get|pull|run|write) (?:that|this|it))\b/i;
const _RESULT_PAYLOAD = /\d{2,}|```|\| .+ \||\/notes\/|exit=\d|\brows?\b/;
// LONG-branch signals (G-orphan-long, 2026-08-16 external-extraction drill): the SHORT gate above only
// catches a bare ack (<240 chars). But an EXTERNAL-data task orphans with a LONG plan narration ("let me
// now pull the 990 data for each and rank them, then print revenue minus expenses") that the operator
// shipped verbatim as "the complete result of the task you just ran" (T6/T9). Catch a directed answer that
// (1) ANNOUNCES a fetch in its opening (explore-lead in the first 240 chars) AND (2) queues a FURTHER step
// (plan-chain) AND (3) carries NO strong result token. Precision-over-recall: any real deliverable (money,
// comma-grouped ints, a decimal, %, a code fence, a table row, a /notes/ path, "N rows", or a leading list
// line) exempts it — so a WRITE draft, a prose review, a hedged real answer, and a names roster all survive.
const _EXPLORE_LEAD = /\b(?:let me (?:now )?(?:check|pull|hit|grab|fetch|look ?up)|i(?:'|’)?ll (?:now )?(?:check|pull|hit|grab|fetch|go (?:pull|hit|check))|i need to (?:check|pull|hit|grab|fetch|look ?up)|i(?:'|’)?m going to (?:check|pull|hit|grab|fetch)|then (?:i(?:'|’)?ll |i )?(?:pull|hit|check|grab|fetch)|next,? i(?:'|’)?ll (?:pull|hit|check|grab|fetch))\b/i;
const _PLAN_CHAIN = /\b(?:then (?:i(?:'|’)?ll |i )?(?:hit|pull|check|grab|fetch|call|query|rank|print|aggregate|tally|sum|compute)|next,? i(?:'|’)?ll|first,? i (?:need to|have to|'ll)|once i (?:have|pull|get|fetch)|i (?:still )?need to (?:confirm|check|find|figure out|pull|hit|fetch|grab)|and (?:then )?(?:rank|aggregate|print|tally|sum|compute) the)\b/i;
const _RESULT_STRONG = /```|\| .+ \||\/notes\/|exit=\d|\b\d+\s+rows?\b|\$\s?[\d,]{2,}|\b\d{1,3}(?:,\d{3})+\b|\b\d+\.\d|\b\d+\s?%|^\s*(?:[-*•]|\d+[.)])\s+\S/m;
function isAckOrphan(ans) {
  const s = String(ans == null ? '' : ans).trim();
  if (!s) return false;
  if (s.length < 240 && _ACK_LEAD.test(s) && !_RESULT_PAYLOAD.test(s)) return true;   // SHORT bare ack
  // plan-narration at ANY length (the two-signal AND is self-limiting): announces a fetch in the opening
  // (explore-lead in the first 240) AND queues a further step (plan-chain) AND carries no strong result token.
  return _EXPLORE_LEAD.test(s.slice(0, 240)) && _PLAN_CHAIN.test(s) && !_RESULT_STRONG.test(s);
}

module.exports = { detectPromise, bookingSubject, isAckOrphan, _PROMISE_LEAD, _OFFER_RE, _DELIVER_VERB, _DELIVERABLE_OBJ, _DONE_RE, _ACK_LEAD, _RESULT_PAYLOAD, _EXPLORE_LEAD, _PLAN_CHAIN, _RESULT_STRONG };
