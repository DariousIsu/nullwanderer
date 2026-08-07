/*
 * lib/meeting_leave.js — the CHAT leave directive, polarity-safe. PURE + offline-testable.
 *
 * Why (program review Disease G, fixed 2026-08-07): leaving a live meeting is IRREVERSIBLE, and
 * the old chat trigger was a bare phrasing match — "is the meeting over?" (a question about state)
 * and "don't leave the meeting yet" (an explicit negation) both set the leave flag. It was also
 * wired for Google Meet only: in a Teams call, "you can leave the meeting" did nothing at all.
 *
 * The rules, in order (each one earns its place from a measured false positive):
 *   1. NEGATION near the leave verb → never a directive ("don't leave", "stay in the meeting").
 *   2. QUESTION ABOUT STATE → never a directive ("is the meeting over?", "did the call end?").
 *      BUT a second-person modal REQUEST is a polite imperative and DOES fire ("can you leave
 *      the meeting" is Lucas giving an order, not asking about the world).
 *   3. Only then do the directive shapes match: an order to leave, or a DECLARATIVE statement
 *      that the meeting is over.
 * Anything ambiguous falls through to null — in a live meeting, staying put on a miss costs a
 * minute of notes; leaving on a false positive ends her attendance. Asymmetric, so the detector
 * is asymmetric.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));

const MEETING = String.raw`(?:the\s+)?(?:meeting|call)`;
const LEAVE_VERB = String.raw`(?:leave|exit|drop\s*off(?:\s+of)?|hang\s*up(?:\s+on)?|step\s*out\s*of|get\s+out\s+of|disconnect\s+from)`;
const OVER = String.raw`(?:over|done|ended|finished|wrapped(?:\s*up)?|adjourned|complete)`;

// 1) Negation / stay-put near the leave verb or the whole message.
const NEGATED = new RegExp(String.raw`\b(?:don'?t|do\s+not|never|not\s+yet|no\s+need\s+to|without)\b[^.?!]{0,30}\b${LEAVE_VERB}\b|\b(?:stay|remain|keep\s+(?:listening|watching|taking\s+notes))\b[^.?!]{0,20}\b(?:in|on)\b[^.?!]{0,15}${MEETING}|\bhold\s+on\b|\bwait\b[^.?!]{0,20}\b(?:before|to)\s+${LEAVE_VERB}`, 'i');

// 2) A question about STATE — leading auxiliary/wh-word, or a trailing '?', asking whether the
//    meeting is over / ended. ("is the meeting over?", "when does the call end?", "did it wrap up?")
const STATE_QUESTION = new RegExp(String.raw`^\s*(?:is|are|was|were|has|have|had|did|does|do|when|why|how|what|who)\b[^?]*\b(?:${MEETING}|it)\b[^?]*\b${OVER}\b`, 'i');

// 2b) …but a second-person modal request to leave IS an order, question mark or not.
const MODAL_REQUEST = new RegExp(String.raw`\b(?:can|could|would|will)\s+you\b[^.?!]{0,30}\b(?:${LEAVE_VERB}\s+${MEETING}|end\s+${MEETING})`, 'i');

// 3) The directive shapes.
const LEAVE_ORDER = new RegExp(String.raw`\b(?:you\s+can\s+|you\s+may\s+|please\s+|go\s+ahead\s+and\s+)?${LEAVE_VERB}\s+${MEETING}\b|\bend\s+${MEETING}\b`, 'i');
const DECLARED_OVER = new RegExp(String.raw`\b${MEETING}(?:'?s|\s+is|\s+was)?\s*${OVER}\b|\bwe(?:'re| are)\s+${OVER}\s*(?:here|now)?\b|\bthat'?s\s+a\s+wrap\b`, 'i');

/**
 * detectChatLeave(text) → { reason: 'ordered'|'declared-over' } when the message is a genuine
 * leave directive, else null.
 */
function detectChatLeave(text) {
  const t = str(text).trim();
  if (!t || t.length > 400) return null;
  if (NEGATED.test(t)) return null;
  if (MODAL_REQUEST.test(t)) return { reason: 'ordered' };
  // A question about state never triggers — unless it carried the modal request handled above.
  if (STATE_QUESTION.test(t)) return null;
  if (/\?\s*$/.test(t) && !MODAL_REQUEST.test(t)) {
    // Any other trailing question mark: only the unambiguous order shape may fire ("leave the
    // meeting, ok?"); a bare state mention does not.
    return LEAVE_ORDER.test(t) ? { reason: 'ordered' } : null;
  }
  if (LEAVE_ORDER.test(t)) return { reason: 'ordered' };
  if (DECLARED_OVER.test(t)) return { reason: 'declared-over' };
  return null;
}

module.exports = { detectChatLeave };
