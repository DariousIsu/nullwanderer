'use strict';
/* internal_action.js — INTERNAL THOUGHTS → INTERNAL ACTIONS (Lucas 2026-08-16).
 *
 * The disease (screenshots 08-16): a self-noticed tension about HER OWN work surfaced as an unprompted,
 * user-facing "want me to …?" NAG — "Parish clean-up doc stalled, want me to pull it up?" and, the one
 * that slipped the first cut, "I never resolved those FEC numbers … want me to run that down properly?"
 * Lucas: "her internal thoughts need to be internal actions … 'I haven't finished the task you gave me,
 * would you like me to do that?' is not great behavior." She can just DO her own work — asking permission
 * to act on it is a nag, not a question. So a self-directed permission-offer must route to an autonomous
 * INTERNAL ACTION (open a line of inquiry she pursues in the idle loop) and stay silent.
 *
 * THE GOVERNING RULE (Lucas 2026-08-16, sharpening it): "it should only be asking permission [if] is it
 * something NEW. Finding that she fucked up an old paper she should just fix it and present it — I can give
 * her updates if I want something changed." So: continuing / finishing / FIXING her OWN work is never new
 * → just do it and present the result. Permission is for something genuinely NEW he must decide, an OUTWARD
 * action with a real side effect, or an offer to STOP. ("run that down" is one of HIS own frequent phrases
 * — it must internalize, and the blocklist below does so without ever having to enumerate it.)
 *
 * classifyUnpromptedAsk(text) → 'act' | 'surface':
 *   'act'     — a permission-OFFER opener ("want me to / should I / do you want me to …?") whose action is
 *               HER OWN internal work, with NO genuine-decision marker and NO external side effect.
 *               Internalize — and this is now the DEFAULT for an offer opener, so an unenumerated self-work
 *               verb ("run that down", "nail down the totals", "reconcile the figures") internalizes too.
 *   'surface' — everything that genuinely needs Lucas: a GENUINE decision/preference/info question
 *               ("which cycle — 2022 or 2024?", "formal or casual?"); an OUTWARD action with a real side
 *               effect or that needs his sign-off ("want me to send / post / pay / delete it?", "run it by
 *               the committee?"); an offer to STOP/PAUSE ("want me to hold off?"); and any plain info-share.
 *
 * WHY A BLOCKLIST, NOT AN ALLOWLIST (the fix): the first cut gated on _SELF_WORK_RE — an allowlist of
 * self-work verbs — so it leaked every verb it hadn't listed (that is exactly how "run that down" got out).
 * The safe set to PRESERVE is small and bounded (his decisions, outward side effects, stop-offers); the set
 * of ways to name her own work is open-ended. So we invert: internalize by default, surface only on an
 * explicit preserve-marker. This matches Lucas's priority — a leaked nag is the failure he named; an
 * over-internalized borderline just means she picks a reasonable path and pursues it silently (recoverable).
 * Regex fast-path with an INJECTABLE model-confirm seam (the detectors-vs-comprehension cure shape). Pure;
 * offline-testable. Run: node scripts/smoke_internal_action.js
 */

// (1) The permission-OFFER opener — she is asking whether to do something (not stating a fact).
const _OFFER_RE = /\b(?:want me to|wanna me to|would you like me to|do you want me to|would you want me to|should i|shall i|shall we|want me to go ahead and)\b/i;
// (2) GENUINE-QUESTION markers — a real ask for HIS decision / preference / info. Any hit → surface.
const _GENUINE_RE = /\b(\d{4}\s+or\s+\d{4}|which\s+(?:one|of|cycle|version|option|way|approach|format)|prefer|formal\s+or\s+casual|instead\s+of|until\s+you|before\s+you|do\s+you\s+mean|did\s+you\s+mean|what(?:'|’)?s?\s+your|how\s+(?:do|would)\s+you\s+want|or\s+(?:should|do|would|shall)\s+(?:i|we|you)\b|\bor\s+(?:keep|hold|wait|leave|shelve)\b)\b/i;
// (3) OUTWARD actions — a real external side effect or something that needs HIS sign-off. Preserve: she
// must NOT do these autonomously (safety), and offering them IS a genuine ask. Deliver-to-a-person,
// publish/broadcast, transact/commit, phone, destructive, or seek-external-approval ("run it by …").
const _OUTWARD_RE = new RegExp([
  '\\b(?:send|e-?mail|message|text|dm|ping|reply|respond|forward|cc|bcc|loop\\s+in|copy\\s+in)\\b',
  '\\b(?:post|publish|tweet|share|upload|broadcast|announce)\\b',
  '\\b(?:submit|sign|pay|buy|purchase|order|book|schedule|invite|rsvp)\\b',
  '\\b(?:call|phone|ring)\\b',
  '\\b(?:delete|remove|archive|merge|purge|wipe)\\b',
  '\\brun\\s+(?:\\w+\\s+)?by\\b',                                   // "run it by the committee", "run by legal"
  '\\b(?:check|confirm|clear|square)\\s+(?:it|that|this\\s+)?\\s*with\\b',
].join('|'), 'i');
// (4) STOP/PAUSE offers — "want me to hold off / wait / shelve it?" is a genuine "should I stop?" check,
// not self-work she should just barrel ahead on. Preserve.
const _DEFER_RE = /\b(?:hold\s+off|hold\s+on|hang\s+on|pause|wait|sit\s+on\s+(?:it|that|this)|set\s+(?:it|that|this)\s+aside|shelve|leave\s+(?:it|that|this)(?:\s+(?:be|alone|as\s+is))?|drop\s+(?:it|that|this)|back\s+off|put\s+(?:it|that|this)\s+on\s+hold|park\s+(?:it|that|this)|table\s+(?:it|that|this)|stop)\b/i;
// (5) Self-work verbs — NO LONGER the gate (the blocklist above is), kept only so tensionToInquiry can
// strip the "…, want me to <verb> it up?" clause off the seed. Broadened for cleaner seeds; harmless.
const _SELF_WORK_RE = /\b(pull\s+(?:it|that|them|this|those|the\s+\w+)\s+up|pull\s+up|bring\s+(?:it|that|them|this|the\s+\w+)\s+up|resume|pick\s+(?:it|that|this)\s+back\s+up|finish(?:\s+(?:it|that|up))?|complete\s+(?:it|that|the\s+\w+)|wrap\s+(?:it|that)\s+up|keep\s+going\s+on|dig\s+(?:in|into)|look\s+into|investigate|chase\s+(?:it|that|down)|run\s+(?:it|that|this|them)\s+down|track\s+(?:it|that|this|them)\s+down|nail\s+(?:it|that|this|them|down)|sort\s+(?:it|that|this|them)?\s*out|straighten\s+(?:it|that|this)?\s*out|reconcile|re-?run\s+(?:it|that)?|rerun|refresh\s+(?:it|that|the\s+\w+)|check\s+on|follow\s+up\s+on|work\s+on|get\s+back\s+(?:on|to)\s+(?:it|that)|unstick|push\s+(?:it|that)\s+(?:through|forward)|take\s+another\s+(?:pass|crack|look)|circle\s+back|keep\s+digging)\b/i;

function _isQuestion(s) {
  // question-shaped: ends in '?' (allowing trailing quote/paren) or contains a '?' clause.
  return /\?["'”’)\]]?\s*$/.test(s) || s.includes('?');
}

function classifyUnpromptedAsk(text, { confirm = null } = {}) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s || !_isQuestion(s)) return 'surface';          // a plain info-share is not a nag — leave it alone
  if (_GENUINE_RE.test(s)) return 'surface';            // needs Lucas's decision/preference/info → preserve
  if (!_OFFER_RE.test(s)) return 'surface';             // not a permission-offer opener → preserve
  if (_OUTWARD_RE.test(s)) return 'surface';            // real external side effect / needs his sign-off → preserve
  if (_DEFER_RE.test(s)) return 'surface';              // an offer to STOP/pause is a genuine check → preserve
  // A permission-offer for HER OWN internal work — no genuine marker, no external side effect, not a
  // stop-offer. Internalize by default (this is the polarity flip). Optional bounded model confirm for the
  // ambiguous tail (detectors-vs-comprehension); default trusts the conservative blocklist above.
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
  return `Advance a self-noticed tension without being asked — ${subject.slice(0, 200)} — work out what it takes to move it forward, and do it.`;
}

module.exports = { classifyUnpromptedAsk, tensionToInquiry, _OFFER_RE, _SELF_WORK_RE, _GENUINE_RE, _OUTWARD_RE, _DEFER_RE };
