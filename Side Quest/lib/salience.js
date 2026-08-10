/**
 * lib/salience.js — THE CARRIED SALIENCE FRAME (spec: docs/CARRIED_SALIENCE_MANIFEST.md).
 *
 * The disease this exists to cure (live 2026-08-10): "who is the mayor of Shreveport?" → "Tom
 * Arceneaux." → "have we found HIS contact info?" → non-answer. The turn manifest resolves each turn's
 * named mentions in isolation and MINTS a new empty coordinate for anything unresolved, so "his" became
 * a fresh "person in question" instead of dereferencing the Arceneaux coordinate resolved one turn ago.
 * lib/referent.js patched a few phrasings with regex nets (elliptical, demonstrative) — one net per way
 * of pointing. This is the structural cure: carry the recently-resolved coordinates, and let a reference
 * DEREFERENCE against them (the model flags a mention as referential + typed; code does the keyed lookup).
 *
 * Pure + injectable store, so it is exhaustively offline-smokeable. The default store is an in-memory
 * per-session Map (enough for the hot path; a checkpoint alongside convo_state is a later option).
 *
 * WHAT ENTERS THE FRAME: only RESOLVED antecedents — held/owner objects. Gaps (minted-new) and ambiguous
 * mentions are NOT things a later pronoun should bind to. Self (Zoe) is always mounted by the manifest
 * separately and is never a "his/that" antecedent, so it never enters here.
 */
'use strict';

const _store = new Map();                                   // sessionId -> { entries:[...], lastTouch }
// Resolved, owner-world, OR named-but-thin: a minted coordinate still carries a real surface ("Tom
// Arceneaux") to bind — a person named in her reply but not yet in the graph is still a valid antecedent.
// Never self (Zoe is not a "his"/"that") and never ambiguous (no clean referent).
const ANTECEDENT_STATUS = new Set(['held', 'owner', 'minted-new']);
const CAP = 8;                                              // most-recent N coordinates on the table
const MAX_IDLE_MS = 30 * 60 * 1000;                         // a long gap means the discourse moved on — expire

function _frame(store, sessionId) {
  let f = store.get(sessionId);
  if (!f) { f = { entries: [], lastTouch: 0 }; store.set(sessionId, f); }
  return f;
}

/**
 * Fold one turn's RESOLVED manifest objects into the frame. Most-recent-first ordering; a repeated
 * coordinate moves to the front and bumps its hit count; the frame is capped by recency. A long idle gap
 * clears the frame first so "him" can never bind an entity from a conversation that already moved on.
 * `objects` is the manifest.objects array ({coord,type,status,surface,gloss,salient}). Returns the frame.
 */
function fold(sessionId, objects, { turn = null, now = Date.now(), cap = CAP, store = _store } = {}) {
  const f = _frame(store, sessionId);
  if (f.lastTouch && (now - f.lastTouch) > MAX_IDLE_MS) f.entries = [];
  f.lastTouch = now;
  for (const o of (Array.isArray(objects) ? objects : [])) {
    // a REFERENCE's own (mis)resolution is never an antecedent — else a ref-miss "his" (minted
    // person:short/his) would pollute the frame and a later "his" would bind the pronoun, not a person.
    if (!o || !o.coord || o.ref === true) continue;
    if (!ANTECEDENT_STATUS.has(String(o.status || ''))) continue;
    const at = f.entries.findIndex((e) => e.coord === o.coord);
    const prevHits = at >= 0 ? f.entries[at].hits : 0;
    if (at >= 0) f.entries.splice(at, 1);                   // move-to-front on repeat
    f.entries.unshift({
      coord: o.coord,
      type: String(o.type || 'thing'),
      surface: String(o.surface || ''),
      gloss: o.gloss || null,
      lastTurn: turn,
      lastTouch: now,
      hits: prevHits + 1,
      salient: !!o.salient,
    });
  }
  if (f.entries.length > cap) f.entries.length = cap;       // evict oldest beyond the cap
  return f.entries;
}

/**
 * Dereference a reference to the most-recent COMPATIBLE antecedent on the table. `type` is the wanted
 * canonical type the model flagged ("person" for his/her/them; "document" for that-list/pull-it-up);
 * null means an untyped reference ("it"/"that") → the most-recent real thing. Returns the frame entry
 * or null (→ the caller surfaces an honest gap+clarify, never a guess). A stale (idle-expired) frame
 * binds nothing.
 */
function dereference(sessionId, { type = null, now = Date.now(), store = _store } = {}) {
  const f = store.get(sessionId);
  if (!f || !f.entries.length) return null;
  if (f.lastTouch && (now - f.lastTouch) > MAX_IDLE_MS) return null;
  const want = type ? String(type).toLowerCase() : null;
  for (const e of f.entries) {                              // most-recent-first
    if (want) { if (e.type === want) return e; }
    else return e;                                          // untyped: the most-recent thing on the table
  }
  return null;
}

// The most-recent entry of a given type (or null). Convenience over dereference for callers that already
// hold the type and want the raw entry.
function topOfType(sessionId, type, { now = Date.now(), store = _store } = {}) {
  return dereference(sessionId, { type, now, store });
}

// Inspect the current frame (most-recent-first). For tests / diagnostics. Never mutates.
function peek(sessionId, { store = _store } = {}) {
  const f = store.get(sessionId);
  return f ? f.entries.slice() : [];
}

// Drop a session's frame (topic reset / session end).
function clear(sessionId, { store = _store } = {}) { store.delete(sessionId); }

// Guard so the last assistant reply is folded into the frame at most ONCE (main.js folds what SHE just
// named so a pronoun next turn can bind it — but only the first time it sees that reply). Returns true the
// first time this key is seen for the session, false after.
function shouldFoldReply(sessionId, key, { store = _store } = {}) {
  if (!key) return false;
  const f = _frame(store, sessionId);
  if (f.lastReplyKey === key) return false;
  f.lastReplyKey = key;
  return true;
}

module.exports = { fold, dereference, topOfType, peek, clear, shouldFoldReply, _store, CAP, MAX_IDLE_MS, ANTECEDENT_STATUS };
