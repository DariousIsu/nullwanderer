'use strict';
/* internal_action.js — INTERNAL THOUGHTS → INTERNAL ACTIONS (Lucas 2026-08-16).
 *
 * The disease (screenshot 08-16): a self-noticed tension about HER OWN work surfaced as an unprompted,
 * user-facing "want me to pull it up?" NAG ("Parish clean-up doc stalled, want me to pull it up?").
 * Lucas: "her internal thoughts need to be internal actions." She can just DO her own work — asking
 * permission to act on it is a nag, not a question. So a self-directed permission-offer must route to
 * an autonomous INTERNAL ACTION (open a line of inquiry she pursues in the idle loop) and stay silent.
 *
 * classifyUnpromptedAsk(text) → 'act' | 'surface':
 *   'act'     — a clear self-directed permission-offer: an offer opener ("want me to / should I / do
 *               you want me to") + a verb naming HER OWN executable work ("pull it up / resume / finish
 *               / dig into / look into / follow up on X"), with NO genuine-decision marker. Internalize.
 *   'surface' — everything else, and CRUCIALLY every GENUINE question that needs Lucas's decision,
 *               preference, or information only he holds ("which cycle — 2022 or 2024?", "formal or
 *               casual?"). Preserve it — surface unchanged. Also: a plain info-share (not a question).
 *
 * CONSERVATIVE by design — over-suppressing a genuine question is worse than an occasional nag, so it
 * returns 'act' ONLY on a clear self-work offer with no genuine marker; ANY doubt → 'surface'. Regex
 * fast-path with an INJECTABLE model-confirm seam (the detectors-vs-comprehension cure shape). Pure;
 * offline-testable. Run: node scripts/smoke_internal_action.js
 */

// (1) The permission-OFFER opener — she is asking whether to do something (not stating a fact).
const _OFFER_RE = /\b(?:want me to|wanna me to|would you like me to|do you want me to|would you want me to|should i|shall i|shall we|want me to go ahead and)\b/i;
// (2) The offered action is HER OWN autonomous work — verbs she can execute WITHOUT Lucas. Kept to the
// unambiguous self-work verbs; anything outward-facing or approval-seeking ("run it by", "send") is left
// OUT so it stays a genuine ask.
const _SELF_WORK_RE = /\b(pull\s+(?:it|that|them|this|those|the\s+\w+)\s+up|pull\s+up|bring\s+(?:it|that|them|this|the\s+\w+)\s+up|resume|pick\s+(?:it|that|this)\s+back\s+up|finish(?:\s+(?:it|that|up))?|complete\s+(?:it|that|the\s+\w+)|wrap\s+(?:it|that)\s+up|keep\s+going\s+on|dig\s+(?:in|into)|look\s+into|investigate|chase\s+(?:it|that|down)|re-?run\s+(?:it|that)?|rerun|refresh\s+(?:it|that|the\s+\w+)|check\s+on|follow\s+up\s+on|work\s+on|get\s+back\s+(?:on|to)\s+(?:it|that)|unstick|push\s+(?:it|that)\s+(?:through|forward)|take\s+another\s+(?:pass|crack|look)|circle\s+back|keep\s+digging)\b/i;
// (3) GENUINE-QUESTION markers — a real ask for HIS decision / preference / info. Any hit → surface.
const _GENUINE_RE = /\b(\d{4}\s+or\s+\d{4}|which\s+(?:one|of|cycle|version|option|way|approach|format)|prefer|formal\s+or\s+casual|instead\s+of|until\s+you|before\s+you|do\s+you\s+mean|did\s+you\s+mean|what(?:'|’)?s?\s+your|how\s+(?:do|would)\s+you\s+want|or\s+(?:should|do|would|shall)\s+(?:i|we|you)\b|\bor\s+(?:keep|hold|wait|leave|shelve)\b)\b/i;

function _isQuestion(s) {
  // question-shaped: ends in '?' (allowing trailing quote/paren) or contains a '?' clause.
  return /\?["'”’)\]]?\s*$/.test(s) || s.includes('?');
}

function classifyUnpromptedAsk(text, { confirm = null } = {}) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s || !_isQuestion(s)) return 'surface';          // a plain info-share is not a nag — leave it alone
  if (_GENUINE_RE.test(s)) return 'surface';            // needs Lucas's decision/preference/info → preserve
  if (!(_OFFER_RE.test(s) && _SELF_WORK_RE.test(s))) return 'surface';   // not a clear self-work offer → preserve
  // Regex says self-directed nag. Optional bounded model confirm (detectors-vs-comprehension): the caller
  // may inject a classifier for the ambiguous tail; default trusts the conservative regex.
  if (typeof confirm === 'function') { try { return confirm(s) ? 'act' : 'surface'; } catch { return 'act'; } }
  return 'act';
}

// Turn the noticed tension into a durable line-of-inquiry seed — strip the offer/self-work clause so the
// QUESTION is about the work itself, not about asking permission. Returns null if nothing substantive left.
function tensionToInquiry(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  let subject = s.replace(_OFFER_RE, ' ').replace(_SELF_WORK_RE, ' ').replace(/\?+/g, ' ').replace(/\s+/g, ' ').trim();
  subject = subject.replace(/^[\s,;:.\-–—]+|[\s,;:.\-–—]+$/g, '').trim();
  if (subject.length < 6) return null;
  return `Advance a self-noticed tension without being asked — ${subject.slice(0, 160)} — work out what it takes to move it forward, and do it.`;
}

module.exports = { classifyUnpromptedAsk, tensionToInquiry, _OFFER_RE, _SELF_WORK_RE, _GENUINE_RE };
