/**
 * lib/unprompted_gate.js — STRUCTURAL backstops for autonomous (unprompted) utterances.
 *
 * WHY (2026-07-17 "conversation imploded"): the idle lanes (heartbeat, continuity) surface
 * reflections while a user question sits UNANSWERED, and monologue N times into an empty room.
 * Similarity/importance guards are meaning-level and mis-calibrate (a paraphrase at cosine ~0.80
 * slips a 0.88 threshold), so they can't be the only backstop. These two rules are STRUCTURAL —
 * they read the turn tape, not the wording — so they hold regardless of how a clone is phrased:
 *
 *   (A) PENDING USER TURN — the newest user message has no PROMPTED assistant reply after it.
 *       The user is waiting; an autonomous reflection would BURY a live question (the implosion:
 *       "UK PM background?" #8527 was never answered while reflections flooded). The floor belongs
 *       to the pending question — surface NOTHING autonomous (not even an inbound) until it's answered.
 *   (B) UNPROMPTED STREAK — she has already spoken `maxStreak` times unprompted since the user last
 *       spoke. Past that she's monologuing into an empty room; go quiet until the user returns.
 *       (Inbounds — real external events, not her own musing — are exempt from B, never from A.)
 *
 * Pure + deps-injected (pass `turns`) so it's offline-testable with a synthetic tape and no db.
 * Fail-soft everywhere: any error → allow (never block a genuine utterance on an infra hiccup).
 */
'use strict';

const MAX_UNPROMPTED_STREAK = require('./config').getInt('UNPROMPTED_MAX_STREAK', 3);

// Decide whether an autonomous utterance may surface right now.
//   turns:    oldest-first turn rows (defaults to db.getRecentTurns(40)); rows carry {speaker, unprompted}.
//   isInbound: an external inbound (chat-bot/email) — exempt from the streak cap (B), never from (A).
//   maxStreak: override the streak cap (defaults to config UNPROMPTED_MAX_STREAK, 3).
// Returns { allow, reason, streak, pending }.
function evaluate({ turns, isInbound = false, maxStreak = MAX_UNPROMPTED_STREAK } = {}) {
  let tape;
  try {
    tape = Array.isArray(turns) ? turns : require('./db').getRecentTurns(40);
  } catch (e) {
    return { allow: true, reason: 'fail-open(no-tape)', streak: 0, pending: false };
  }
  if (!Array.isArray(tape) || tape.length === 0) return { allow: true, reason: 'empty-tape', streak: 0, pending: false };

  // Index of the newest user turn in-window.
  let lastUserIdx = -1;
  for (let i = tape.length - 1; i >= 0; i--) { if (tape[i].speaker === 'user') { lastUserIdx = i; break; } }
  const after = tape.slice(lastUserIdx + 1);

  // (A) pending user turn — a user spoke and got no PROMPTED reply since (ai_thought doesn't answer).
  let pending = false;
  if (lastUserIdx >= 0) {
    const answered = after.some(t => t.speaker === 'ai_said' && !t.unprompted);
    pending = !answered;
    if (pending) return { allow: false, reason: 'pending-user-turn', streak: 0, pending: true };
  }

  // (B) unprompted streak since the user last spoke.
  const streak = after.filter(t => t.speaker === 'ai_said' && t.unprompted).length;
  if (!isInbound && streak >= maxStreak) {
    return { allow: false, reason: `unprompted-streak(${streak}>=${maxStreak})`, streak, pending: false };
  }

  return { allow: true, reason: 'ok', streak, pending: false };
}

// Always-on, structured decision log for the unprompted say-paths. The 2026-07-17 audit found the
// heartbeat say-path logged ZERO lines during a 20-utterance flood — a blind spot. This makes EVERY
// autonomous say-decision observable (console) AND queryable across a restart (meta last-decision),
// so guard behaviour can be confirmed without guessing which instance produced a row.
function logDecision(source, decision) {
  const rec = {
    ts: Date.now(),
    source,                                   // 'heartbeat' | 'continuity'
    outcome: decision && decision.allow ? (decision.outcome || 'surfaced') : 'suppressed',
    reason: (decision && decision.reason) || 'unknown'
  };
  try { console.log(`[${source}][say] ${rec.outcome} — ${rec.reason}`); } catch {}
  try { require('./db').setMeta('unprompted_last_decision', JSON.stringify(rec)); } catch {}
  return rec;
}

module.exports = { evaluate, logDecision, MAX_UNPROMPTED_STREAK };
