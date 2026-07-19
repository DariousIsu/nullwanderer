/* lib/thought_gate.js — keep the idle THOUGHT stream free of prompt-echo and rumination.
 *
 * Measured on 5,169 stored ai_thought turns (2026-07-19):
 *   - 926 (17.9%) were META-COMMENTARY ON HER OWN PROMPT — "The user has provided a very detailed
 *     set of rules regarding how I should handle silence…". The silence/continuity scaffolding is
 *     delivered in a user-role message, so the model reads it as something Lucas SAID and dutifully
 *     reflects on it. Those thoughts are about formatting rules, not about anything real.
 *   - 942 leaked the <say>/<think> tag names into the thought text.
 *   - The single largest cluster repeated 71 times near-verbatim ("The user is asking for a
 *     continuity check on a specific previous…"), with 40x / 37x / 30x / 26x behind it. The idle
 *     loop kept re-reviewing the same dormant commitment for hours and recording each pass.
 *
 * Both are the same failure: the loop has nothing real to chew on, so it recycles either the prompt
 * or a stale commitment — and nothing stopped it from PERSISTING that. continuity.js already had a
 * repetition guard, but only on what she SAYS, never on what she records as a thought.
 *
 * This gate only decides whether a thought is worth STORING. It never changes what she says, and it
 * never blocks the underlying loop from running — a suppressed thought means "that pass produced
 * nothing worth keeping", which is the honest outcome.
 *
 * Pure. All thresholds are arguments.
 */
'use strict';

// Phrases that only appear when the model is narrating its own instructions back to itself. Kept
// deliberately narrow and anchored to the OBSERVED failures — a loose pattern here would silently
// eat genuine reflection, which is worse than the noise it removes.
// The noun list carries the weight — it must cover how the model actually paraphrases the
// scaffolding ("protocol" and "guidelines" were both missed on the first pass, letting 36 echoes
// through) without matching ordinary words like "rule of thumb".
const _SCAFFOLD = '(?:rules?|instructions?|constraints?|guidelines?|protocols?|directives?|criteria|frameworks?)';
const _ECHO_RE = [
  new RegExp(`\\bthe (?:user|prompt) (?:has )?(?:provided|given|supplied|is providing)\\b.{0,80}\\b(?:${_SCAFFOLD}|set of)`, 'i'),
  new RegExp(`\\b(?:a |very |highly |quite )?(?:detailed|specific|comprehensive|clear|explicit)(?: and \\w+)? (?:set of |update on )?${_SCAFFOLD}\\b`, 'i'),
  /\binstructions? regarding how I (?:should|must|need to)\b/i,
  /\bthese (?:are )?internal (?:constraints|instructions|rules)\b/i,
  /\bthe prompt (?:asks|says|tells|instructs|implies|dictates)\b/i,
  /\bper (?:the|my) (?:instructions|prompt|rules)\b/i,
  /\bthe "?(?:ANSWER TO GIVE|ACTION HONESTY|Rules of Engagement)"?\b/i,
  /\bI (?:should|must) (?:not )?(?:acknowledge|discuss|mention) (?:these|the) (?:instructions|rules)\b/i,
  // "these instructions themselves cannot be discussed or acknowledged in the <say> tag" — this was
  // previously caught only because it mentioned a tag. Match the CLAIM instead, so removing the
  // (false-positive-prone) tag signal doesn't lose it.
  /\b(?:these|the) (?:instructions?|rules?)\b.{0,50}\b(?:cannot|can(?:'|no)?t|must not|should not|are not to)\b.{0,40}\b(?:discussed|acknowledged|mentioned|referenced|repeated)\b/i,
  /\b(?:this|the current) (?:input|turn) is (?:entirely )?(?:a set of |internal )?(?:operational )?(?:constraints|instructions|rules)\b/i,
];

// DELIBERATELY NOT AN ECHO SIGNAL: a thought containing <say>/<think>. The first version of this
// gate treated leaked tags as prompt-echo and threw away real reflection because of it — #21, #634
// and #939 in the live log are all genuine ("I've been turning over my own answer about the email
// account misalignment…") and were dropped purely for containing a stray tag. A leaked tag means
// THE PARSER leaked, which is a formatting problem to strip, not evidence the thought is worthless.
const _TAG_RE = /<\/?(?:say|think)>/gi;
function stripTags(text) { return String(text || '').replace(_TAG_RE, '').replace(/\s+/g, ' ').trim(); }

function isPromptEcho(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  return _ECHO_RE.some(re => re.test(s));
}

// ── repetition ─────────────────────────────────────────────────────────────────────────────────
// Same Jaccard-over-content-words shape the say-guard already uses, so "too similar" means the same
// thing in both places.
function _sig(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 4));
}
function similarity(a, b) {
  const A = _sig(a), B = _sig(b);
  if (!A.size || !B.size) return 0;
  let i = 0; for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i);
}

// 0.80 matches the existing unprompted-repeat threshold. Above it, two thoughts are the same thought.
const REPEAT_THRESHOLD = 0.80;
function isRepetitive(text, recent, threshold = REPEAT_THRESHOLD) {
  const s = String(text || '').trim();
  if (!s) return false;
  for (const r of (recent || [])) {
    if (similarity(s, typeof r === 'string' ? r : (r && r.content)) >= threshold) return true;
  }
  return false;
}

// ── decision ───────────────────────────────────────────────────────────────────────────────────
// Returns { keep, reason }. Callers store only when keep is true, and log the reason so a
// suppressed thought is visible rather than silently vanishing.
// `recent` MUST be a TIME-spanning window, not the last N thoughts — callers pass several hours.
//
// SCOPE LIMIT, measured, do not paper over it: this catches NEAR-VERBATIM repeats (the "most
// concrete thread pulling at me…" cluster, ~300 of them). It does NOT catch semantic PARAPHRASE.
// The Tangipahoa commitment was re-reviewed 16 times in different words, and across those 15
// consecutive pairs the average full-text similarity was 0.301 and the average opening similarity
// 0.321 — ZERO pairs reached 0.80. No threshold separates that from genuinely distinct thoughts,
// so lowering it would only trade this noise for false positives on real reflection.
// Paraphrase-rumination is a STRUCTURAL problem (the loop re-selecting the same commitment) and is
// fixed at the source in continuity.js, not here.
function shouldKeep(text, recent, { threshold = REPEAT_THRESHOLD, minChars = 24 } = {}) {
  const s = stripTags(text);
  if (!s) return { keep: false, reason: 'empty' };
  if (s.length < minChars) return { keep: false, reason: 'too-short' };
  if (isPromptEcho(s)) return { keep: false, reason: 'prompt-echo' };
  if (isRepetitive(s, recent, threshold)) return { keep: false, reason: 'repetitive' };
  return { keep: true, reason: 'ok', text: s };
}

module.exports = { isPromptEcho, similarity, isRepetitive, shouldKeep, stripTags, REPEAT_THRESHOLD, _ECHO_RE };
