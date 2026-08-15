/**
 * lib/delivery_router.js — THE DELIVERY ROUTER (senses doc §1, 2026-08-15). The moment-gate was
 * BINARY: importance ≥ bar → speak, below → the utterance died with a console line, and channel
 * choice ignored presence entirely. Suppressed near-misses were real observations she chose not
 * to interrupt with — they deserved a shelf, not a grave.
 *
 * Three additions, ZERO new model calls (importance + lane were already scored at the gate):
 *   • HOLD BAND — a suppressed utterance within HOLD_BAND of its lane's bar (and above an
 *     absolute floor, so trivia never sticks) lands on a capped 48h shelf (meta delivery.held).
 *   • AWARENESS SURFACING — heldLine() rides buildAwarenessBlock: she KNOWS she's holding notes
 *     and offers them at a natural moment or when asked what's new. The digest is HER move on a
 *     chat beat (the beat contract: held data terminates in cognition, not a dead key).
 *   • PRESENCE-AWARE DELIVERY — a surfaced utterance while Lucas is AWAY also fires a desktop
 *     notification (lib/presence.notify, local + safe), so "surfaced into a transcript nobody is
 *     watching" stops being silent delivery failure.
 *
 * Fail-soft everywhere; every store read/write is try-wrapped. Deps injectable for smokes.
 */
'use strict';

const HELD_KEY = 'delivery.held';
const HOLD_BAND = 2;          // within this of the lane bar → hold instead of drop
const HOLD_FLOOR = 5;         // absolute importance floor — below this nothing is ever held
const HELD_CAP = 12;
const HELD_SHELF_MS = 48 * 3600e3;

function _db(deps) { return (deps && deps.db) || require('./db'); }

function _readHeld(deps, nowMs) {
  try {
    return (JSON.parse(_db(deps).getMeta(HELD_KEY) || '[]') || [])
      .filter((h) => h && h.text && (nowMs - h.ts) < HELD_SHELF_MS);
  } catch { return []; }
}

/**
 * Route a below-threshold utterance: 'hold' (shelved for the digest) or 'drop'. Dedupes on a
 * cheap normalized prefix so a paraphrase loop can't fill the shelf with one thought.
 */
function holdOrDrop({ text, imp, threshold, lane = 'hers', deps = {}, nowMs = Date.now() } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || !(imp >= HOLD_FLOOR) || !(threshold - imp <= HOLD_BAND)) return 'drop';
  try {
    const held = _readHeld(deps, nowMs);
    const key = t.toLowerCase().slice(0, 60);
    if (held.some((h) => String(h.text).toLowerCase().slice(0, 60) === key)) return 'hold';   // already shelved
    held.push({ ts: nowMs, text: t.slice(0, 240), imp, lane });
    _db(deps).setMeta(HELD_KEY, JSON.stringify(held.slice(-HELD_CAP)));
    return 'hold';
  } catch { return 'drop'; }
}

/** A surfaced utterance while Lucas is away → local desktop notification so it reaches him. */
function noteSurfaced({ away = false, text = '', deps = {} } = {}) {
  if (!away) return false;
  try {
    ((deps.presence) || require('./presence')).notify('Zoe', String(text || '').replace(/\s+/g, ' ').slice(0, 140));
    return true;
  } catch { return false; }
}

/** The awareness line — she knows what she's holding and that offering it is HER move. */
function heldLine({ deps = {}, nowMs = Date.now() } = {}) {
  const held = _readHeld(deps, nowMs);
  if (!held.length) return null;
  const items = held.slice(-3).map((h) => `"${String(h.text).slice(0, 90)}"`).join(' · ');
  return `You are HOLDING ${held.length} smaller note${held.length === 1 ? '' : 's'} for Lucas — things you noticed but chose not to interrupt with: ${items}${held.length > 3 ? ' (+ more)' : ''}. Offer them at a natural moment, or when he asks what's new; once shared (or stale), let them go.`;
}

/** She shared (or they aged out) — clear the shelf. Called when a digest is actually delivered. */
function clearHeld({ deps = {} } = {}) {
  try { _db(deps).setMeta(HELD_KEY, '[]'); return true; } catch { return false; }
}

module.exports = { holdOrDrop, noteSurfaced, heldLine, clearHeld, HELD_KEY, HOLD_BAND, HOLD_FLOOR, HELD_CAP, HELD_SHELF_MS };
