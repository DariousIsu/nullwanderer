'use strict';
/*
 * lib/voice_addressed.js — the ADDRESSED-TO-HER gate for the always-on ear (campaign §22 catch,
 * 2026-08-21 12:21/12:29: Lucas's dictation and nearby speech landed as her USER TURNS — the
 * speaker gate passed because it WAS him; what was missing is whether he was talking TO HER.
 * "disregard error pick up" confirmed both as errors; they also pollute blind-week turn counts).
 *
 * The verdict is PURE and rides stt:transcribe's result exactly like the speaker gate: the
 * renderer drops a non-addressed utterance at the same seam it drops a non-operator one. Main
 * shelves the dropped text on room.overheard (labelled) — room awareness survives, only the
 * false TURN is stopped. Push-to-talk and typed input never come here: tapping the mic IS
 * addressing her.
 *
 * The load-bearing observation: Windows dictation types into the FOCUSED app. Hands-free speech
 * arriving while her window is NOT focused and doesn't name her is ambient by construction —
 * that is the exact dictation specimen. With her window focused the gray zone is a person in the
 * room / a phone call: long declarative prose (dictation-shaped) and sub-4-word fragments
 * ("yeah exactly") drop; everything else passes — the gate exists to stop the obvious pollution,
 * never to make her hard to reach. Inside a live exchange window everything flows (follow-ups
 * don't re-address her by name; barge-in stays natural).
 */

const EXCHANGE_WINDOW_MS = 90000;   // she spoke / he turned within this → conversation is flowing

// An ask or an instruction aimed at the listener — interrogative or command-verb lead (a few
// leading discourse particles allowed: "okay so can you…").
const _ASK_LEAD = /^(?:(?:so|okay|ok|hey|um|uh|well|and|also|now|alright|please)[,\s]+){0,3}(?:what|what's|when|where|who|whose|why|how|can|could|would|will|do|does|did|is|are|was|were|should|shall|tell|give|show|pull|open|build|check|play|read|search|find|run|start|stop|remind|schedule|look|grab|send|make|write|add|list|summarize|explain|remember|save|set)\b/i;
const _SECOND_PERSON = /\b(?:you|your|you're|yours)\b/i;

function _wordCount(t) { return (String(t).trim().match(/\S+/g) || []).length; }

/** Does the text say her name? `name` = the chosen name (falls back to "zoe"); matched per token. */
function namesHer(text, name) {
  const t = String(text || '');
  const toks = new Set(String(name || 'zoe').toLowerCase().split(/\s+/).filter((w) => w.length >= 3));
  toks.add('zoe');
  for (const w of toks) {
    if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) return true;
  }
  return false;
}

/**
 * verdict({ text, name, inExchangeWindow, appFocused }) → { turn, reason }.
 * turn=false means: not a user turn — shelve as room awareness, never send to her brain.
 */
function verdict({ text = '', name = 'zoe', inExchangeWindow = false, appFocused = true } = {}) {
  const t = String(text || '').trim();
  if (!t) return { turn: false, reason: 'empty' };
  if (namesHer(t, name)) return { turn: true, reason: 'named' };
  if (inExchangeWindow) return { turn: true, reason: 'exchange-window' };
  // COLD OPEN, her name absent:
  if (!appFocused) return { turn: false, reason: 'unfocused-cold' };   // dictation targets the focused app — this speech wasn't for her
  const words = _wordCount(t);
  const askShaped = _ASK_LEAD.test(t) || _SECOND_PERSON.test(t);
  if (askShaped) return { turn: true, reason: 'ask-shape' };
  if (words < 4) return { turn: false, reason: 'fragment' };            // "yeah exactly" — a conversation she's not in
  if (words >= 12) return { turn: false, reason: 'dictation-shaped' };  // long declarative prose, nothing aimed at her
  return { turn: true, reason: 'benefit-of-doubt' };                    // short-ish statement while she's fronted — fail open
}

module.exports = { verdict, namesHer, EXCHANGE_WINDOW_MS, _ASK_LEAD, _SECOND_PERSON };
