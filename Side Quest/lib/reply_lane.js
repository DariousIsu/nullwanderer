'use strict';
// ── THE REPLY LANE IS SINGLE-VOICE ──────────────────────────────────────────────────────────────
// Phase 0 of the document-production plan (failure #7, live 2026-08-21): the renderer funnels
// every s:'reply' token into ONE live bubble (chat.js liveSayBuffer). Two reply-stamped
// generations streaming at once therefore ZIP character-by-character into a single garbled
// message. Live shape: a slow async tool-followup (cloud generation, 30-60s) was still streaming
// when the next prompted turn began — the entry-time gen guard in fireToolFollowup passed when
// the followup STARTED, and nothing re-checked per token.
//
// This module is the arbiter. Every reply-stamped streaming generation opens a CLAIM:
//   • the lane belongs to whoever streams first (lazy claim on the first token);
//   • a 'turn' claim (the prompted reply Lucas is waiting for) TAKES the lane from anyone —
//     a reply he is waiting for never queues behind stale async work;
//   • a 'followup' claim that finds the lane held goes MUTED: its tokens drop, its generation
//     still completes, and the caller demotes its delivery (sheep rail / DB row, never the live
//     bubble). Mute is STICKY — a muted stream never resumes, so a freed lane cannot replay a
//     stale tail into a fresh bubble.
// Sequential flows (main say → tool followup → chain hops) never collide: each completes and
// clears the lane before the next opens. Only true concurrency is arbitrated.
// Pure state machine — no timers, no IPC — so the smoke drives every branch directly.

let _seq = 0;
let _active = null;            // { id, kind } — the claim currently allowed to stream
const _muted = new Set();      // claim ids sticky-muted (dispossessed or born blocked)

/** A new prompted turn is starting — whatever async stream is live is stale by definition.
 *  Mutes it so his thinking-dots window is quiet and the stale tail never rides the new turn. */
function preemptForTurn() {
  if (_active) {
    console.warn(`[reply-lane] prompted turn preempts live ${_active.kind} stream #${_active.id} — muted, delivery demoted`);
    _muted.add(_active.id);
    _active = null;
  }
}

/** Open a claim for one streaming generation. kind: 'turn' | 'followup'. */
function open(kind) {
  const id = ++_seq;
  return {
    id,
    kind,
    /** Wrap the raw token sender; returns a sender that emits only while this claim owns the lane. */
    feed(send) {
      return (payload) => {
        if (_muted.has(id)) return false;
        if (_active && _active.id !== id) {
          if (kind === 'turn') {
            console.warn(`[reply-lane] turn stream #${id} takes the lane from ${_active.kind} #${_active.id} — the loser is muted`);
            _muted.add(_active.id);
            _active = { id, kind };
          } else {
            console.warn(`[reply-lane] followup stream #${id} MUTED — ${_active.kind} #${_active.id} holds the lane (say still recorded, delivery demoted)`);
            _muted.add(id);
            return false;
          }
        }
        if (!_active) _active = { id, kind };
        send(payload);
        return true;
      };
    },
    /** Close the claim. 'live' → send the normal s:'reply' complete; 'demoted' → the caller
     *  routes the finished say through the unprompted door instead (never the live bubble). */
    complete() {
      if (_muted.has(id)) { _muted.delete(id); return 'demoted'; }
      if (_active && _active.id === id) _active = null;
      return 'live';
    },
  };
}

/** Test/introspection only. */
function _state() { return { active: _active ? { ..._active } : null, muted: [..._muted] }; }
function _reset() { _seq = 0; _active = null; _muted.clear(); }

module.exports = { open, preemptForTurn, _state, _reset };
