'use strict';
/**
 * lib/intake_type.js — INTAKE TYPING (2026-08-13, Block 2 of the false-loop cure).
 *
 * Lucas: "everything seems to get built into a task, maybe that's causing confusion." Measured: every
 * user turn — a question, a complaint about late work, a "thanks" — flowed into the open-thread goal
 * extractor, and the extractor's model over-extracts, so orders and complaints minted WORK THREADS
 * (the morning's #3867/#3868 came from a control verb; the 10:00 complaint nearly re-armed a hold).
 *
 * Cure shape (detectors-vs-comprehension): a deterministic type gate IN FRONT of the extractor, with
 * the extractor's own bounded LLM call remaining as the second filter behind it. The gate only vetoes
 * turns that are CLEARLY not work assignment; anything ambiguous fails OPEN (mints: true) so a real
 * goal is never dropped — the win is the vetoes, not the catches.
 *
 * Types, checked in order:
 *   reported  — complaint / past-reference about work ("you were supposed to…") → the thread already
 *               exists; a complaint must never mint a sibling. (work_hold.REPORTED_RE, the same
 *               pattern that keeps a complaint from re-arming a hold.)
 *   control   — a hold/resume order or the paper-FINALIZE verb → those lanes already change state;
 *               minting a thread beside them is the duplicate reflex.
 *   work-ask  — an assignment cue is present → extract (even in question form: "can you compile…").
 *   question  — interrogative with NO assignment cue → answer it, don't work it.
 *   ack       — short, no assignment cue ("thanks", "looks great", "ok") → conversation.
 *   open      — everything else → fail open to the extractor.
 *
 * Pure text → decision; no I/O, no state. Distinct from lib/intake.js (the LLM research-contract
 * classifier: isProject/kind/shape) — this is the deterministic turn-TYPE gate in front of minting.
 */
const workHold = require('./work_hold');
const { PAPER_VERB_RE } = require('./paper_finalize');

// Assignment cues — verbs and need-phrases that carry work. Deliberately broad: a false "work-ask"
// just returns the turn to the status-quo extractor path; a false veto would drop a real goal.
const WORK_CUE_RE = /\b(?:research|build|compile|draft|write|track|monitor|investigate|summarize|create|prepare|gather|collect|validate|verify|update|fix|analyze|review|map\s+out|put\s+together|look\s+into|dig\s+into|follow\s+up|check\s+on|work\s+on|keep\s+current|set\s+up|find\s+(?:out|me|all|the)|pull\s+(?:together|up|the)|get\s+me|make\s+(?:a|an|the|me)|i\s+need|i\s+want\s+you\s+to|needs?\s+to\s+be\s+(?:done|finished|completed|built|written)|by\s+(?:tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|the\s+end)|add\s+(?:a|an|the|it|this|that)\b)/i;

// Interrogative shape: opens with a question word/auxiliary, or ends in "?".
const QUESTION_OPEN_RE = /^\s*(?:what|who|whom|whose|where|when|why|how|which|is|are|was|were|am|do|does|did|can|could|will|would|should|shall|have|has|had)\b/i;
// A STATUS ASK about existing work ("any update on X?") — checked BEFORE the work cues, because
// nouns like "update"/"progress" would otherwise read as assignment verbs and mint a sibling.
const STATUS_ASK_RE = /^\s*(?:any|got\s+any|is\s+there\s+any)\s+(?:updates?|news|word|progress|movement|luck)\b/i;

// Conversational acknowledgment / sentiment openers (only consulted on short cue-less turns).
const ACK_RE = /^\s*(?:thanks?|thank\s+you|ty|thx|nice|great|perfect|awesome|good\s+(?:job|work|morning|night|evening)|ok(?:ay)?|sounds\s+good|got\s+it|lol|ha+|love\s+it|looks\s+great|well\s+done|goodnight|good\s+morning|hey|hi|hello|yo|yes|yep|yeah|no|nope|sure|k)\b/i;

const ACK_MAX_LEN = 80;   // a cue-less turn longer than this may still carry work → fail open

// A sentence is VETOED when it is itself a complaint, a control order, or a status ask — those
// shapes may contain work verbs ("you were supposed to WORK ON that paper") without assigning work.
function _sentenceVeto(s) {
  if (workHold.REPORTED_RE.test(s)) return 'reported';
  if (workHold.detect(s)) return 'control';
  if (PAPER_VERB_RE.test(s)) return 'control';
  if (STATUS_ASK_RE.test(s)) return 'question';
  return null;
}

/** classify(text) → { type, mints, via } */
function classify(text) {
  const t = String(text || '').trim();
  if (t.length < 4) return { type: 'ack', mints: false, via: 'too-short' };
  // PER-SENTENCE pass (pre-land sweep Q2): a mixed turn — "why isn't X done? also add Y to the
  // tracker" — must still mint from the un-vetoed work sentence; a whole-turn veto would drop it.
  const sentences = t.split(/[.?!\n]+/).map((s) => s.trim()).filter((s) => s.length >= 4);
  const vetoes = [];
  for (const s of sentences) {
    const v = _sentenceVeto(s);
    if (v) { vetoes.push(v); continue; }
    if (WORK_CUE_RE.test(s)) return { type: 'work-ask', mints: true, via: 'work-cue' };
  }
  // No sentence carried an un-vetoed work cue past this point — so any veto sentence types the
  // turn (cue-less neutral sentences beside it assign nothing; fail-open is for cue-free turns).
  if (vetoes.length > 0) {
    return { type: vetoes[0], mints: false, via: vetoes[0] === 'reported' ? 'reported-speech' : vetoes[0] === 'control' ? 'control-order' : 'status-ask' };
  }
  if (QUESTION_OPEN_RE.test(t) || /\?\s*$/.test(t)) return { type: 'question', mints: false, via: 'interrogative' };
  if (t.length <= ACK_MAX_LEN && ACK_RE.test(t)) return { type: 'ack', mints: false, via: 'ack-lexicon' };
  return { type: 'open', mints: true, via: 'fail-open' };
}

module.exports = { classify, WORK_CUE_RE, QUESTION_OPEN_RE, STATUS_ASK_RE, ACK_RE };
