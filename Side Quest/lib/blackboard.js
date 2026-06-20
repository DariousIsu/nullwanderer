/**
 * The Blackboard — Side Quest's shared, append-only timeline.
 *
 * Problem it solves: today every idle loop (monologue, heartbeat, reflection,
 * self-dialogue) rebuilds its context from the DB independently each time it
 * fires, so a thought in tick N is invisible to tick N+1 except as a diluted
 * row re-retrieved among everything else. There is no live "what just happened"
 * state shared across loops or across time. That is why she can't form an
 * intention and carry it forward.
 *
 * The blackboard is that shared state: ONE timeline of events. Every loop writes
 * one event at the END of its tick (write-bottom) and reads recent events at the
 * TOP of its tick (read-top). This is the substrate the StuckDetector reads and
 * the focus layer (Phase B) hangs off.
 *
 * Design borrowed from OpenHands' EventStream (append-only, monotonic integer id,
 * `cause` links, single-writer discipline) — adapted to single-process Electron +
 * better-sqlite3 with a synchronous projection instead of a thread-pool fan-out.
 *
 * REFERENCE-NOT-COPY: an event stores a short snippet + a normalized signature for
 * cheap equality; the canonical full content lives in its source row (refTable/
 * refId), exactly like the knowledge store.
 */

const db = require('./db');

// --- signature: the normalized equality key (OpenHands' _eq_no_pid, simplified) ---
// Two events are "the same" for loop-detection if their signatures match. We
// lowercase, strip everything but alphanumerics+spaces, collapse whitespace, and
// cap length so volatile tails (timestamps, ids, trailing punctuation) don't
// defeat the compare. Empty/trivial content → '' (the detector ignores blanks).
function signature(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')        // drop any leaked tags
    .replace(/[^a-z0-9 ]+/g, ' ')    // punctuation/symbols → space
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

// The single writer. Every loop calls this (and only this) to record what it did.
// `content` is the human-readable snippet used to derive the signature when one
// isn't supplied; the full text should live in the referenced source row.
function append({ source, kind, focusId = null, causeId = null, refTable = null, refId = null, content = null, signature: sig = null }) {
  if (!source || !kind) throw new Error('blackboard.append requires source and kind');
  const finalSig = sig != null ? sig : signature(content);
  return db.insertAgentEvent({ source, kind, focusId, causeId, refTable, refId, content, signature: finalSig });
}

// Convenience: record a user message so the StuckDetector resets (a fresh
// instruction must never be read as part of a spiral).
function markUser(content = null, refId = null) {
  return append({ source: 'user', kind: 'user_msg', refTable: 'turns', refId, content });
}

// --- read side (all return oldest→newest) ---
function recent(n = 40) { return db.getRecentAgentEvents(n); }
function forFocus(focusId, n = 60) { return db.getAgentEventsForFocus(focusId, n); }
function sinceLastUser(n = 40) { return db.getAgentEventsSinceLastUser(n); }

module.exports = { signature, append, markUser, recent, forFocus, sinceLastUser };
