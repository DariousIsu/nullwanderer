/*
 * lib/report_command.js — detect an EXPLICIT "build/print the report on X" instruction and pull the
 * topic out of it. PURE + offline-testable.
 *
 * Why this exists: Lucas repeatedly asked "build the final report on the Hartfield Foundation" and got
 * a conversational placeholder ("I'm on it — pulling everything now") instead of a document. The
 * promised-lookup net ran a LIVE WEB lookup on that promise; the delivery-promise net only materializes
 * a ROSTER (held_roster). Neither composes a REPORT from the research docs she already holds. This
 * detector lets the chat lane recognize the command up front and route it to a real compose-from-held
 * path — so an explicit report order lands a file, never a promise.
 *
 * Deliberately STRICT: it fires only on an imperative to PRODUCE a report-shaped artifact about a named
 * subject. "what does the report say", "review the report", "is the report ready" are NOT build orders.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));

// The artifact nouns a "report" can be phrased as.
const ARTIFACT = 'report|brief|briefing|dossier|write-?up|writeup|document|summary|memo|profile|one-?pager';
// Imperatives that mean PRODUCE it.
const BUILD = /\b(build|compose|write|create|draft|generate|assemble|produce|print|prepare|put\s+together|make)\b/i;
// Requests that, paired with the artifact noun, also mean "hand me the produced artifact".
const REQUEST = /\b(give me|can i (?:have|get)|i(?:'| a)?m? ?want(?:ed)?|i need|hand me|let me have|send me|where(?:'s| is) (?:my|the))\b/i;
// Non-build framings to EXCLUDE even when a report noun appears (asking ABOUT a report, not for one).
const NOT_BUILD = /\b(what (?:does|is|are)|is (?:the|my|it|that) [a-z ]{0,20}(?:report|brief|dossier|document) (?:ready|done|finished)|review (?:the|my|your)|read (?:the|my)|how(?:'s| is) (?:the|my) [a-z ]{0,20}(?:report|brief) (?:going|coming))\b/i;

/**
 * detect(text) → { topic } when text is an explicit order to build/print a report about a subject,
 * else null. `topic` is the cleaned subject phrase.
 */
function detect(text) {
  const t = str(text).trim();
  if (!t) return null;
  const artifactRe = new RegExp(`\\b(?:${ARTIFACT})\\b`, 'i');
  if (!artifactRe.test(t)) return null;
  if (NOT_BUILD.test(t)) return null;
  if (!(BUILD.test(t) || REQUEST.test(t))) return null;

  // Topic = the subject after "on|about|for|covering|regarding|of|into" that follows the artifact noun.
  const m = t.match(new RegExp(`\\b(?:${ARTIFACT})\\b[^.?!]*?\\b(?:on|about|for|covering|regarding|of|into)\\s+(.+?)\\s*(?:\\bplease\\b|\\bnow\\b|\\basap\\b|\\bthanks?\\b|\\bthank you\\b|[.?!]|$)`, 'i'));
  let topic = m ? m[1] : '';
  topic = cleanTopic(topic);
  if (topic.length < 3 || topic.length > 120) return null;
  return { topic };
}

// Strip a leading article / filler and trailing courtesy so the topic is a clean subject phrase.
function cleanTopic(s) {
  return str(s)
    .replace(/^\s*(?:the|a|an|our|my|this|that|all|everything (?:on|about) )\s+/i, '')
    .replace(/\s+(?:please|now|asap|thanks|thank you|for me|when you can)\s*$/i, '')
    .replace(/[\s"'.,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { detect, cleanTopic };
