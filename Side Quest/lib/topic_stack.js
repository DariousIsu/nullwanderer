'use strict';
/*
 * lib/topic_stack.js — elastic memory E3: conversational multi-thread steering.
 *
 * E3a — ANAPHORIC RETURN resolver. In a multi-topic conversation, "circle back to the first thing we
 * talked about" / "what we were saying earlier" points BACK to an earlier topic. The measured defect
 * (drill T4, 2026-08-18): "what was the weakest part of that FIRST thing we talked about?" resolved by
 * EMOTIONAL SALIENCE to an old sycophancy critique from another day — not to the conversationally-first
 * topic (Louisiana energy) of THIS session. The cure is STRUCTURAL: resolve the referent by turn ORDER
 * within this session, and steer the reply to it.
 *
 * PURE + injectable: main.js passes this session's ordered USER turns; this returns the referent + a
 * directive. No db, no I/O, never throws. Directive-only — it rides in composedUserMessage and steers
 * the answer; it deletes no context, so a false positive is soft (the directive says "if this doesn't
 * fit, treat it as noise").
 */

// A RETURN points back to an earlier point in THIS conversation. Two safe shapes only:
//  (1) an explicit return verb ("circle back / back to / going back to …") near an ordinal/anchor, and
//  (2) "(the|that) <ordinal> <topic-noun> (we|you|that we) …" — the ordinal + an explicit conversational
//      reference, so the idiom "the last thing I need" (noun NOT followed by we/you) never fires.
// Second alternation requires a RECALL verb after "you" (not a bare "you"), so imperatives/corrections/
// forward-refs don't fire: "the first thing you NEED to do", "the last thing you SAID was wrong", "the
// first report you GENERATED yesterday". "we" stays broad ("the first thing we talked about").
const RETURN_RE = /\b(?:back to|circle back(?:\s+to)?|coming back to|returning to|go(?:ing)?\s+back to)\b[^.?!]{0,24}?\b(?:first|earlier|previous|original|initial|last|second|other|thing|topic|point|subject)\b|\b(?:the|that|this)\s+(?:first|original|initial|earlier|previous|last|second)\s+(?:thing|topic|one|subject|point|matter|question|report|thread)\s+(?:we\b|you\s+(?:mentioned|raised|brought\s+up|discussed|talked\s+about|were\s+(?:saying|discussing)|covered|went\s+over)|(?:that|which)\s+we)|\bwhat\s+we\s+were\s+(?:saying|discussing|talking about)\s+(?:earlier|before|first|at the (?:start|beginning))\b/i;

function detectReturn(text) {
  const m = RETURN_RE.exec(String(text || ''));
  if (!m) return { isReturn: false, ordinal: null };
  const hit = m[0];
  let ordinal = 'earlier';
  if (/\b(?:first|original|initial)\b/i.test(hit) || /\bat the (?:start|beginning)\b/i.test(hit)) ordinal = 'first';
  else if (/\bsecond\b/i.test(hit)) ordinal = 'second';
  else if (/\b(?:last|previous)\b/i.test(hit)) ordinal = 'last';
  return { isReturn: true, ordinal };
}

// userTurns: this session's USER turns in ASC order, each {id, content}. The LAST entry is the current
// turn (the return utterance itself) and is excluded. Returns {id, content} or null.
function referentForOrdinal(userTurns, ordinal) {
  const prior = (Array.isArray(userTurns) ? userTurns : []).slice(0, -1)
    .filter((t) => t && t.content && String(t.content).trim());
  if (!prior.length) return null;
  const pick = (i) => ({ id: prior[i].id, content: prior[i].content });
  if (ordinal === 'first') return pick(0);
  if (ordinal === 'second') return pick(Math.min(1, prior.length - 1));
  // 'last' | 'earlier' → the topic immediately before the current turn
  return pick(prior.length - 1);
}

function returnDirective(userName, referent, ordinal) {
  const topic = String(referent.content || '').replace(/\s+/g, ' ').replace(/[[\]]/g, '').slice(0, 180);
  const which = ordinal === 'first' ? 'the FIRST thing you two discussed this conversation'
    : ordinal === 'second' ? 'the SECOND thing you discussed this conversation'
    : ordinal === 'last' ? 'the topic just before this one'
    : 'an earlier point in this conversation';
  return `[${userName} is RETURNING to ${which}. Structurally, by the ORDER of THIS conversation, that is: "${topic}". Resume THAT topic — pick up what you were saying about it — do NOT answer about a more emotionally-salient memory from another day. Recall what was discussed about it if you need to. If this genuinely does not fit what he's asking, treat this note as noise.]`;
}

module.exports = { detectReturn, referentForOrdinal, returnDirective, RETURN_RE };
