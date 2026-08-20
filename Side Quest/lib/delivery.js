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

// She is COMMITTING to do it (not offering, not asking). Future intent, first person — PLUS the
// present-progressive commitment ("I'm pulling it now", "I'm composing the sheet"), which run-2
// (2026-08-19) showed dangling unbooked: it asserts work-in-motion and is exactly as much a debt as
// "I'll pull it". Progressive form requires a work-verb so "I'm hoping/thinking" never leads.
const _PROMISE_LEAD = /\b(?:i'?ll|i will|i'?m going to|i'?m gonna|let me|going to|i'?ll go ahead and|i'?m (?:now |currently )?(?:pull|grabb|fetch|compil|compos|build|check|gather|runn|quer|writ|draft|prepar)\w*ing)\b/i;
// …but an OFFER or a question is not a debt — leave it open. "let me know" is HER asking THEM.
const _OFFER_RE = /\b(?:want me to|would you like|do you want|should i\b|shall i\b|if you'?d like|let me know|happy to|i can (?:also )?(?:help|do that)\b)|\?\s*$/i;
// the ACT of producing a deliverable (compose/land added 2026-08-19 — "I'll compose the sheet and
// land it at notes/…" dangled unbooked in run 2)
const _DELIVER_VERB = /\b(?:pull(?:ing)?(?: together| up)?|put(?:ting)? together|compil\w+|compos\w+|assembl\w+|build\w*|draft\w*|writ\w*|prepar\w+|generat\w+|creat\w+|send\w*|export\w*|deliver\w*|land\w+|gather\w+|collect\w+|get you|grab)\b/i;
// …a THING to hand over. Artifact-shaped, or an explicit "that/it/them for you". (bare "sheet" +
// "filings"/"990s" + "agent output" added 2026-08-19 — run-2's sponsors-sheet promises missed the net)
const _DELIVERABLE_OBJ = /\b(?:roster|list|spreadsheet|sheets?|report|file|filings?|document|dossier|brief(?:ing)?|summary|table|memo|deck|csv|xlsx?|docx?|pdf|990[\w-]*|agent (?:output|results?)|the e-?mails?|the contacts?|the numbers?|the data|the breakdown|the write-?up)\b|\b(?:that|it|them|those|this) for you\b/i;
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

// The SUBJECT (topic) a delivery promise is ABOUT — what to feed buildReportFromHeld(topic) /
// buildLocalRosterDeliverable(subject) when the backstop DELIVERS the promise instead of nagging. Pure +
// best-effort: take the promise clause (before any "and park/save/send …" tail), strip the commit lead /
// deliver-verb / deliverable-noun / articles / filler, and prefer an explicit "on|about|of|for X" clause.
// A weak/empty result is fine and SAFE — the builder honest-misses on an unknown topic (never fabricates).
function deliverySubjectFrom(say, deliverable) {
  // F23 sanitize (run-2b): a leaked operator tool-call JSON in the say polluted the BOOKED topic —
  // the promise pursued a subject made of JSON keys. Strip machine text before extracting the topic.
  let s = require('./say_filter').stripToolJson(String(say || '')).trim();
  if (!s) return '';
  // keep only the promise clause — drop a "… and park/save/send it" tail (that's the destination, not the topic)
  s = s.split(/\b(?:and (?:then )?(?:park|save|drop|put|stick|store|send|email|share|file)\b)|,\s*then\b|;\s/i)[0].trim();
  s = s.replace(_PROMISE_LEAD, ' ');
  // an explicit topic clause wins: "report ON the Hartfield Foundation", "roster FOR Louisiana"
  const on = s.match(/\b(?:on|about|regarding|covering|of|for)\s+(.+)$/i);
  let subj = on && on[1] ? on[1] : s;
  subj = subj
    .replace(_DELIVER_VERB, ' ')
    .replace(_DELIVERABLE_OBJ, ' ')
    .replace(/\b(?:a|an|the|raw|final|complete|full|whole|updated|latest|current|entire)\b/gi, ' ')
    .replace(/\b(?:for you|together|up|now|please|real quick|right away|that|it|them|those|this)\b/gi, ' ')
    .replace(/[^\w&/,\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:on|about|of|for|and|with|to)\s+/i, '')
    .replace(/[\s,]+(?:on|about|of|for|and|with)$/i, '')
    .trim();
  return subj.slice(0, 120);
}

// GROUND THE DELIVERY CLAIM IN THE ARTIFACT (2026-08-18 live probe). Three artifact-delivery say sites
// (buildCanvasFromOrder, the canvas edit door, the report-cmd) tell the reply-writer to describe "what it
// holds" / "the ONE most substantive finding in it" but hand it only the TITLE + line count — never the
// composed markdown, which was built in a SEPARATE cloud call the reply-writer never saw. So she re-imagines
// the contents: a live Louisiana-energy brief that actually held CCS / offshore-wind / LPSC got announced as
// "the $4.1B gas plant rate recovery and Governor Landry's industrial growth framework" — plausible, real,
// and NOT what landed. holdsDigest returns a compact, FAITHFUL digest of the artifact (its heading, a lead /
// exec-summary sentence, and the item / section labels) to inject into the say so the claim is grounded in
// the artifact by construction — the discipline the directed-dossier announce already uses (main.js ~16986).
// PURE: it only slices/extracts md, so it can introduce nothing md does not already contain. Empty md → ''.
function holdsDigest(md, { cap = 500, maxItems = 8 } = {}) {
  // Strip markdown/structural punctuation to SPACES (never WELD tokens: "2*3" must stay "2 3", not become
  // the fabricated "23"), and drop [] so a composed "]" cannot close the bracketed say-instruction this is
  // injected into (nor smuggle a directive across the content firewall).
  const clean = (s) => String(s).replace(/[*_`#\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
  const text = String(md == null ? '' : md).replace(/\r/g, '').trim();
  if (!text) return '';
  let heading = '', sawHeading = false, inFence = false, stop = false;
  const leadLines = [];
  const items = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }   // fence markers + fenced code are not prose
    if (inFence) continue;
    // TITLE: the first heading of ANY level (# … ######), else the first prose line (a bare/"##" title must
    // still register — else the exec-summary lead below never fires and the finding is re-guessed).
    if (!sawHeading) {
      const h = line.match(/^#{1,6}\s+(.+)$/);
      if (h) { heading = clean(h[1]).slice(0, 120); sawHeading = true; continue; }
      if (!/^(?:[-*]\s|\d+[.)]\s|>|\|)/.test(line)) { heading = clean(line).slice(0, 120); sawHeading = true; continue; }
    }
    if (stop) continue;                                                // everything after Open questions is not a holding
    if (/^#{2,6}\s+open questions?\b/i.test(line)) { stop = true; continue; }
    // LEAD / exec-summary: the consecutive prose lines right after the title (bounded) — where the ONE
    // substantive finding lives. Accumulate (a 2-4 sentence summary can span lines), stop at any structure.
    if (sawHeading && !items.length && leadLines.join(' ').length < 300
        && !/^(?:#{1,6}\s|[-*]\s|\d+[.)]\s|\*\*|>|\|)/.test(line)) { leadLines.push(clean(line)); continue; }
    if (items.length >= maxItems) continue;
    let m = line.match(/^(?:[-*]|\d+[.)])?\s*\*\*([^*]{2,90})\*\*/);   // bolded item / section label
    if (m) { items.push(clean(m[1])); continue; }
    m = line.match(/^#{2,6}\s+(.+)$/);                                 // sub-heading label
    if (m) { const s = clean(m[1]).slice(0, 90); if (s) items.push(s); continue; }
    m = line.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);                       // list-item label: split ONLY on a SPACED
    if (m) {                                                           // dash / " : " — never a bare "." or ":" that
      const s = clean(m[1]).split(/\s[—–-]\s|\s:\s/)[0].trim().slice(0, 90);   // lives inside $1.8B, 3.5%, Dr., U.S.
      if (s) items.push(s); continue;
    }
  }
  const lead = leadLines.join(' ').slice(0, 260);
  const parts = [];
  if (heading) parts.push(`"${heading}"`);
  if (lead) parts.push(lead);
  if (items.length) parts.push(`covering: ${items.slice(0, maxItems).join('; ')}`);
  let out = parts.join(' — ') || clean(text);   // no structure captured → a cleaned prose slice
  return out.length > cap ? out.slice(0, cap).replace(/\s+\S*$/, '') + '…' : out;
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

// FALSE-NON-DELIVERY guard (T10, 2026-08-16 drill): the operator BUILT + saved a deliverable but the reply
// DENIED it ("I couldn't pin down the data … I can't build you a brief from data I don't hold") — a stale
// pre-operator "searched-miss" draft beat the operator's late success. claimsNonDelivery detects that denial
// SHAPE. Apostrophes hardened to straight AND curly ['’] (the cloud writer re-voices with U+2019). EXEMPT
// any answer carrying a strong result token (_RESULT_STRONG: decimal/currency/table/rows/notes/list) — a
// real partial ("0 rows", "$7.6 Million") is never a denial. Used by the main.js operator-success drop.
const _NONDELIVERY_RE = /\b(?:could ?n['’]?t|can ?not|can['’]?t|un(?:able|available)|was ?n['’]?t able|not able|failed to|no way to)\b[^.!?\n]{0,60}\b(?:find|pin ?down|locate|build|compile|assemble|pull|produce|generate|deliver|put together|track down)\b|\bI (?:do ?n['’]?t|don['’]?t) (?:have|hold)\b|\bdata I (?:do ?n['’]?t|don['’]?t) hold\b|\bno (?:data|records?|results?|numbers?)\b(?![^.!?\n]*\brows?\b)|\bsearch (?:failed|came up (?:empty|short))\b|\bcouldn['’]?t pin down\b/i;
function claimsNonDelivery(ans) {
  const s = String(ans == null ? '' : ans).trim();
  if (!s) return false;
  if (_RESULT_STRONG.test(s)) return false;   // a real result / partial is never a denial
  return _NONDELIVERY_RE.test(s);
}

// FALSE-INCOMPLETENESS self-nag (FEC loop, 2026-08-16 audit). The MIRROR of claimsNonDelivery: there the
// reply denied a delivery that HAPPENED; here an UNPROMPTED say re-surfaces a past request as still-owed
// AFTER she already delivered it. Live shape: she gave a complete head-to-head (real FEC numbers + a canvas
// table, turns #12239-40, truncated=0), then the idle rails re-nagged "I never resolved those FEC numbers …
// want me to run that down?" SEVEN times over an hour — every one FALSE. The loop self-reinforces: her own
// unprompted nags sit in the heartbeat replay window (getRecentTurns includes them) and prime the next tick.
//
// WHY THIS IS A COMPREHENSION PROBLEM (adversarial-verify wf_38a9dc28, 3 lenses): a first cut suppressed on
// ≥2 shared subject tokens with a result-bearing delivery. That FALSELY suppressed genuine remaining work —
// a PARTIAL ("I gave you Scott's, still owe you Moody's"), a CORRECTION ("those were last cycle's, I owe you
// current"), a NEW metric — because it resolves debt at the subject level, not the owed-ITEM level; and it
// MISSED the bare canonical nag ("I never resolved those FEC numbers", where "FEC" is 3 chars, below the
// token floor) plus alias nags ("DMP" vs "Mucarsel-Powell"). The false re-nag "I pulled figures but didn't
// get you a clean comparison" is LEXICALLY IDENTICAL to the genuine partial — the only difference is whether
// the claimed-missing thing is actually in a prior delivery. So per detectors-vs-comprehension the decision
// is a bounded MODEL call (lib/renag_judge), GATED behind these two cheap PURE predicates:
//   isOwedClaim(say)              — the say claims HER OWN work is unfinished/owed (broad; a miss fails safe
//                                   to surface, an over-match just costs one gated model call that says OPEN)
//   resultBearingDeliveries(turns)— recent NON-unprompted replies carrying a concrete result token (the only
//                                   things that could contradict the nag; excludes her own prior nags)
// If both fire, renag_judge asks the model "is the owed thing already in these deliveries?" — FAIL-OPEN to
// surface, because suppressing a genuine partial/correction is far worse than letting a nag through.
const _OWED_RE = /\b(?:never\s+(?:actually\s+)?(?:finished|resolved|closed|gave|got|gotten|computed|delivered|completed|answered|sent|wrapped|followed\s+through|circled\s+back)|did\s?n['’]?t\s+(?:finish|get|give|deliver|close|resolve|complete|answer|compute|send)|have\s?n['’]?t\s+(?:finished|closed|delivered|given|gotten|resolved|sent|done)|has\s?n['’]?t\s+been\s+(?:done|finished|delivered|sent)|still\s+(?:owe|outstanding|pending|open|on\s+my\s+(?:end|plate|side)|need\s+to|have\s+to)|i\s+owe\s+you|owe\s+you\s+(?:that|the|a|those)|got\s+cut\s+off|cut\s+off\s+(?:mid|before|partway)|left\s+(?:it|that|this)\s+(?:unfinished|hanging|open|half)|meant\s+to\s+(?:send|give|get|pull|share)|circle\s+back|dropped\s+the\s+ball|keep\s+forgetting|never\s+got\s+(?:you|around\s+to)|want(?:\s+me)?\s+to\s+(?:finish|close|wrap|complete|resolve|run\s+(?:it|that))|want\s+the\s+(?:full|complete))\b/i;
function isOwedClaim(sayText) {
  const s = String(sayText == null ? '' : sayText).trim();
  return !!s && _OWED_RE.test(s);
}
// The recent DELIVERED replies (non-unprompted ai_said carrying a strong result token) — the only turns that
// could prove the nag false. Excludes her own unprompted nags (echo-chamber immunity) and thin one-liners.
// Most-recent first, capped. `turns` is an array of turn rows ({ speaker, unprompted, content }).
function resultBearingDeliveries(turns, max = 3) {
  const out = [];
  const arr = Array.isArray(turns) ? turns : [];
  for (let i = arr.length - 1; i >= 0 && out.length < max; i--) {
    const t = arr[i];
    if (!t || t.speaker !== 'ai_said' || t.unprompted) continue;
    const c = String(t.content || '');
    if (c.length >= 40 && _RESULT_STRONG.test(c)) out.push(c);
  }
  return out;
}

module.exports = { detectPromise, bookingSubject, deliverySubjectFrom, holdsDigest, isAckOrphan, claimsNonDelivery, isOwedClaim, resultBearingDeliveries, _PROMISE_LEAD, _OFFER_RE, _DELIVER_VERB, _DELIVERABLE_OBJ, _DONE_RE, _ACK_LEAD, _RESULT_PAYLOAD, _EXPLORE_LEAD, _PLAN_CHAIN, _RESULT_STRONG, _NONDELIVERY_RE, _OWED_RE };
