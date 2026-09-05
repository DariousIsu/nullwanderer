'use strict';
/**
 * lib/ask_door.js — THE ASK DOOR (cut 3 of the wants project; the conversational-awareness law, Lucas 09-04).
 *
 * Measured the night the law was written: of 1,683 prompted replies in 30 days, 248 ended with a question and
 * every sampled one was an OFFER ("Want me to pull dossiers…?") — the assistant reflex, not curiosity. The door
 * makes a real question possible and keeps it rare: on a social or personal turn, at most one learning question
 * per `minGapTurns` turns, chosen from the person model's top gap, weighted by the social reading; the prompt
 * carries the gap and says a question is WELCOME — never that she must ask (anti-performance). The reply's
 * question is detected in code and classed: a `learning` question (about him, his people, his day) or an
 * `offer` (about her doing something); offers never count as learning. Kill switch ZOE_ASK_DOOR=0. Pure.
 */

const OFFER_RE = /^(want me to|do you want me to|should i|shall i|can i|could i|would you like me to|want me|need me to|you want me to|let me know if|i can|i could)\b/i;
const YOU_RE = /\b(you|your|yours|you're|you've|you'd|you'll)\b/i;

/** May a learning question ride this reply? { ask, gap, why } */
function decide({ socialTurn = false, gap = null, turnsSinceLastAsk = Infinity, minGapTurns = 6, social = 0.5, enabled = true } = {}) {
  if (!enabled) return { ask: false, gap: null, why: 'ZOE_ASK_DOOR=0' };
  if (!socialTurn) return { ask: false, gap: null, why: 'a work turn — the door opens on personal ground' };
  if (!gap) return { ask: false, gap: null, why: 'no open gap' };
  if (turnsSinceLastAsk < minGapTurns) return { ask: false, gap: null, why: `asked ${turnsSinceLastAsk} turn(s) ago (min ${minGapTurns})` };
  if (gap.carried && turnsSinceLastAsk < minGapTurns * 5) return { ask: false, gap: null, why: 'that question is carried — not re-asked yet' };
  if (social < 0.25) return { ask: false, gap: null, why: `the social reading is low (${social})` };
  return { ask: true, gap, why: `top gap "${gap.id}" (${gap.why}), ${turnsSinceLastAsk === Infinity ? 'never asked' : turnsSinceLastAsk + ' turns since the last'}` };
}

/** The prompt block: the gap, and that a question is welcome — never an instruction to ask. */
function promptBlock(gap, { who = 'Lucas' } = {}) {
  if (!gap) return '';
  return `[Something you do not know about ${who} that someone close to him would: ${gap.question}. If it fits this moment, a real question about it is welcome — one, in your own words, only if you actually want to know. It is equally fine not to ask.]`;
}

/**
 * Detect a question aimed at him at the reply's tail and class it. Returns null when there is none.
 * A trailing question = the last sentence ends with '?'; `learning` when it is about him/his world and not an
 * offer of her own doing; `offer` otherwise.
 */
function detectQuestion(replyText) {
  const t = String(replyText || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || !/\?\s*$/.test(t)) return null;
  const parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  const q = parts[parts.length - 1] || t;
  const kind = classify(q);
  return { question: q.slice(0, 300), kind };
}
function classify(q) {
  // An OFFER is a question about HER doing something; everything else aimed at him — his day, his people, his
  // drive back — is a LEARNING question (the law's measure: every question she used to ask was an offer).
  const s = String(q || '').trim();
  if (OFFER_RE.test(s)) return 'offer';
  if (/(want|like) me to/i.test(s) || /should i (pull|draft|run|check|look|dig|send|make|build|write|start)/i.test(s)) return 'offer';
  if (/I (could|can|will|'ll|'d) (pull|draft|run|check|look|dig|send|make|build|write|start)/i.test(s) || /want that\??$/i.test(s)) return 'offer';
  return 'learning';
}

function enabled() { return process.env.ZOE_ASK_DOOR !== '0'; }

module.exports = { decide, promptBlock, detectQuestion, classify, enabled, OFFER_RE };
