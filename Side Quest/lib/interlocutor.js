'use strict';
/**
 * lib/interlocutor.js — WHO is at the keyboard right now (run-2 F9, 2026-08-20).
 *
 * Run-2: Lucas handed the chat to Claude for a 3-hour live test and TOLD her so — her
 * conversational model of the handoff was perfect, but every fast path and interceptor kept
 * addressing "Lucas": the fast-path thought said "Lucas is asking about my taste", a reply opened
 * "Lucas —", and intake typed Claude's direct address as reported speech. The owner name
 * (meta user_name) was the only identity the plumbing knew.
 *
 * This organ separates two things the code conflated:
 *   OWNER        — whose machine/memory/persona this is (meta user_name; never changes here).
 *   INTERLOCUTOR — who she is talking to RIGHT NOW (defaults to the owner; a declared handoff
 *                  overrides it until a handback or the TTL).
 *
 * MEASURED, NEVER GUESSED: the interlocutor only changes on an EXPLICIT declaration in the user
 * turn ("you'll be engaging with Claude", "this is Claude speaking", "you're talking to Claude
 * now") — style inference would misfire constantly. A handback ("it's Lucas again", "I'm back",
 * "testing has concluded") or a 24h TTL restores the owner. Fail-safe: no declaration → owner.
 *
 * Pure detection + injectable meta so it smoke-tests offline (scripts/smoke_interlocutor.js).
 */

let _db = null;
const db = () => (_db || (_db = require('./db')));

const META_NAME = 'interlocutor.name';
const META_TS = 'interlocutor.ts';
const TTL_MS = 24 * 60 * 60 * 1000;   // a handoff without a handback goes stale after a day

// Words a capture must never mistake for a person (sentence openers, pronouns, fillers).
const _NAME_STOP = new Set(['the', 'a', 'an', 'i', 'it', 'this', 'that', 'you', 'me', 'we', 'they',
  'he', 'she', 'him', 'her', 'them', 'us', 'someone', 'somebody', 'everyone', 'nobody', 'here',
  'there', 'now', 'then', 'today', 'tonight', 'testing', 'over', 'back', 'again', 'done']);

function _validName(raw, ownerName) {
  const n = String(raw || '').trim().replace(/[.,!?;:]+$/, '');
  if (!n || n.length < 2 || n.length > 40) return null;
  if (_NAME_STOP.has(n.toLowerCase())) return null;
  if (ownerName && n.toLowerCase() === String(ownerName).toLowerCase()) return null;   // the owner "handing off" to themself is a handback
  return n;
}

// Explicit handoff declarations — the speaker names WHO she'll be talking to.
const _HANDOFF_RES = [
  // The lead-in words are case-tolerant by bracketing (the nets stay flagless so the NAME capture
  // keeps its meaningful [A-Z] requirement — a lowercase word after "with" is never a person).
  /\b[Yy]ou(?:'ll| will)\s+(?:only\s+)?(?:be\s+)?(?:engag|talk|speak|chatt|work)\w*\s+(?:only\s+)?with\s+([A-Z][\w-]{1,30})\b/,
  /\b[Yy]ou(?:'re| are)\s+(?:now\s+)?(?:talking|speaking|chatting|working)\s+(?:to|with)\s+([A-Z][\w-]{1,30})\b(?:\s+now)?/,
  /\b[Tt]his is ([A-Z][\w-]{1,30})\b[^.!?\n]{0,40}\b(?:speaking|typing|here|taking over|running|conducting|driving|at the keyboard)\b/,
  /\b[Hh]and(?:ing)?\s+(?:you\s+)?(?:over|off)\s+to\s+([A-Z][\w-]{1,30})\b/,
  // F9b (run 4, 2026-08-20): "Claude on deck — …" and "Claude checking in — …" are the same
  // arrival declaration as "Claude here," — the net was one phrase family wide.
  /^([A-Z][\w-]{1,30})\s+(?:here|on deck|checking in|at the keyboard|taking over)\b\s*[,.!—:;-]/,
  /\b[Ii](?: am|'?m)\s+([A-Z][\w-]{1,30})\s*[,.—-]\s*[^.!?\n]{0,60}\b(?:tak(?:ing|e)\s+over|driving|running|conducting|testing)\b/,
];

// Handback — the owner reclaims the keyboard, or the handoff is declared over.
function _handbackRes(ownerName) {
  const o = String(ownerName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const res = [
    // F9b (run 4): "the pass/run/cycle is done" is the same closure declaration as "testing is done",
    // and "handing THE KEYBOARD back" is the same handback as "handing back" — both missed live.
    /\b(?:testing|(?:the\s+)?(?:test|verification|saturation)?\s*(?:pass|run|cycle))\b[^.!?\n]{0,16}\b(?:concluded|over|done|complete[d]?|finished|wrapped(?: up)?)\b/i,
    /\bhand(?:ing)?\s+(?:it\s+|you\s+|the\s+(?:keyboard|keys|wheel|controls)\s+)?back\b/i,
    /\bi'?m back\b/i,
  ];
  if (o) {
    res.push(new RegExp(`\\b(?:it'?s|this is)\\s+${o}\\s+(?:again|back|now)\\b`, 'i'));
    res.push(new RegExp(`^${o}\\s+(?:here|again|back)\\b`, 'i'));
    res.push(new RegExp(`\\bback to\\s+(?:me|${o})\\b`, 'i'));
    res.push(new RegExp(`\\b${o}\\s+(?:has|takes|gets)\\s+the\\s+(?:keyboard|keys|wheel|controls)\\b`, 'i'));
  }
  return res;
}

// Pure: classify one user turn. Returns { handoff: name } | { handback: true } | null.
function detect(text, { ownerName = 'Lucas' } = {}) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const re of _handbackRes(ownerName)) { if (re.test(t)) return { handback: true }; }
  for (const re of _HANDOFF_RES) {
    const m = re.exec(t);
    if (m) {
      const name = _validName(m[1], ownerName);
      if (name) return { handoff: name };
      if (m[1] && String(m[1]).toLowerCase() === String(ownerName).toLowerCase()) return { handback: true };
    }
  }
  return null;
}

function set(name) { try { db().setMeta(META_NAME, String(name)); db().setMeta(META_TS, String(Date.now())); } catch {} }
function clear() { try { db().setMeta(META_NAME, ''); db().setMeta(META_TS, ''); } catch {} }

// { owner, name, active } — name is the LIVE addressee (owner unless a fresh handoff stands).
function current({ getMeta = null } = {}) {
  const gm = getMeta || ((k) => { try { return db().getMeta(k); } catch { return null; } });
  const owner = gm('user_name') || 'Lucas';
  const n = (gm(META_NAME) || '').trim();
  const ts = parseInt(gm(META_TS) || '0', 10);
  const active = !!n && !!ts && (Date.now() - ts) < TTL_MS;
  return { owner, name: active ? n : owner, active };
}

// The one-call swap for every ADDRESSING site: who to speak to right now.
function liveName(fallback = 'them') {
  try { const c = current(); return c.name || c.owner || fallback; } catch { return fallback; }
}

// Awareness line — only while a handoff is live, so the prompt layer knows too (fail-absent).
function awarenessLine() {
  try {
    const c = current();
    if (!c.active) return null;
    const mins = Math.round((Date.now() - parseInt(db().getMeta(META_TS) || '0', 10)) / 60000);
    const ago = mins < 60 ? `${mins} min ago` : `${(mins / 60).toFixed(1)}h ago`;
    return `HANDOFF ACTIVE (declared ${ago}): you are talking with ${c.name} right now, NOT ${c.owner}. Address ${c.name} directly, attribute what they type to ${c.name}, and never call them ${c.owner}. ${c.owner} is still your person — this is who's at the keyboard, nothing more.`;
  } catch { return null; }
}

module.exports = { detect, set, clear, current, liveName, awarenessLine, TTL_MS };
