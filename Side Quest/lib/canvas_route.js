/**
 * canvas_route — decide WHERE a deliverable answer goes: chat, the Canvas, or ASK the user.
 *
 * The boundary (docs/ZOE_CANVAS_HANDOFF.md §7.2 + Lucas 2026-06-29): her ANSWERS live in chat
 * (a count, a specific entity), COMPLETE WORKS populate the Canvas (the full dossier / big list),
 * and — because she's canvas-aware — when the medium is genuinely AMBIGUOUS she ASKS which, exactly
 * like the priority-gate "ask for the colour near the 7/8 boundary" pattern. Better a one-line
 * question than guessing wrong.
 *
 * PURE: regex + the kind from lib/track.classifyQuery. No I/O. Returns { target, reason }, never throws.
 *   target: 'chat' | 'canvas' | 'ask'
 */
'use strict';

// Explicit medium in the request — always honored, overrides everything.
const ON_CANVAS_RE = /\b(on (?:the )?canvas|to (?:the )?canvas|onto (?:the )?canvas|show (?:me |it )?on (?:the )?(?:canvas|board)|display (?:it|this|that|them)|open (?:the )?canvas|put (?:it|this|that|them) on (?:the )?(?:canvas|board)|pull (?:it|that|them) up on|on (?:the )?board)\b/i;
const IN_CHAT_RE = /\b(just tell me|in (?:the )?chat|right here|here in (?:the )?chat|tell me here|say it|in a (?:sentence|line|few words)|quick(?:ly)?|tl;?dr)\b/i;
// A clearly-COMPLETE work → the Canvas (these are documents, not chat answers).
const COMPLETE_WORK_RE = /\b(full (?:dossier|report|write[- ]?up|document|brief|breakdown)|the (?:whole|entire|complete) (?:thing|report|dossier|document|writeup|brief)|complete (?:report|dossier|document|write[- ]?up)|write (?:it|this|that) up|put together (?:a|the) (?:report|brief|document|dossier)|everything you (?:have|found|got|know))\b/i;

// Decide the target. kind is the lib/track.classifyQuery kind (count|list|sample|facet|status) or null.
function routeDeliverable({ text = '', kind = null } = {}) {
  const s = String(text || '');
  // 1) explicit medium wins
  if (IN_CHAT_RE.test(s)) return { target: 'chat', reason: 'explicit-chat' };
  if (ON_CANVAS_RE.test(s)) return { target: 'canvas', reason: 'explicit-canvas' };
  // 2) a clearly-complete work → canvas regardless of kind
  if (COMPLETE_WORK_RE.test(s)) return { target: 'canvas', reason: 'complete-work' };
  // 3) by kind: short, specific answers stay in chat
  if (kind === 'count' || kind === 'sample' || kind === 'status' || kind === 'find' || kind === 'rank') return { target: 'chat', reason: kind };
  // 4) big enumerations with no stated medium → genuinely unsure → ask
  if (kind === 'list' || kind === 'facet') return { target: 'ask', reason: `${kind}-medium-unspecified` };
  return { target: 'chat', reason: 'default' };
}

module.exports = { routeDeliverable, ON_CANVAS_RE, IN_CHAT_RE, COMPLETE_WORK_RE };
