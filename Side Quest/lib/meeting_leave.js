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

// 2c) FIRST-PERSON LEAVER (2026-08-12 review H5, confirmed live-shaped): "I have to leave the
// meeting early", "im going to leave the call now but you stay" — the leaver is LUCAS, not her.
// LEAVE_ORDER's second-person prefix is OPTIONAL, so these fired 'ordered' and she hung up exactly
// when he wanted her to stay and cover — the most natural real-world use of the lane. A first-person
// subject shortly before the leave verb vetoes the order — unless the message ALSO carries an
// explicit second-person order ("I'm heading out — you can drop off too").
const FIRST_PERSON_LEAVER = new RegExp(String.raw`\b(?:i|i'?m|i'?ve|i'?ll|we|we'?re)\b[^.?!]{0,25}\b${LEAVE_VERB}\s+${MEETING}\b`, 'i');
const SECOND_PERSON_ORDER = new RegExp(String.raw`\b(?:you\s+(?:can|may|should|go\s+ahead)|please|(?:want|need)\s+you\s+to)\b[^.?!]{0,25}\b(?:${LEAVE_VERB}|end)\b`, 'i');

// 2d) STAY-PUT CUES that don't mention the meeting (H5's second hole): "keep taking notes for me",
// "…but you stay" — the old NEGATED stay-branch required "in/on … meeting" AFTER the cue, so a bare
// trailing "you stay" could never rescue. An explicit stay instruction vetoes everything (asymmetric
// doctrine: staying on a contradiction costs a minute; leaving on one ends her attendance).
const STAY_PUT = new RegExp(String.raw`\byou\s+stay\b|\bstay\s+(?:on|in|put|till|until)\b|\bkeep\s+(?:taking\s+notes|listening|watching|covering|recording)\b|\btake\s+notes\s+for\s+me\b|\bcover\s+(?:for\s+me|the\s+rest)\b`, 'i');

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
  if (STAY_PUT.test(t)) return null;                    // an explicit "you stay / keep taking notes" wins over everything (H5)
  if (MODAL_REQUEST.test(t)) return { reason: 'ordered' };
  // The LEAVER IS LUCAS ("I have to leave the meeting") → not a directive to her, unless a
  // second-person order rides along in the same message (H5).
  if (FIRST_PERSON_LEAVER.test(t) && !SECOND_PERSON_ORDER.test(t)) return null;
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
