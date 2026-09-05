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

// ── THE ROUTE (the wants project, cut 2 + W7; Lucas 2026-09-05: "just as long as it's really only when I am
// not at my desk") ─────────────────────────────────────────────────────────────────────────────────────
// Where an unprompted delivery to him goes: the desktop chat when he is here; his Discord DM ONLY when he is
// genuinely not at the desk — his own word (away, remoting in), the OS remote session, or the camera seeing
// no one for a stretch. Plain keyboard idleness alone NEVER routes to Discord (he may be reading): that stays
// a desktop bubble + the desktop notification above. A meeting = a queued note: the bubble lands, nothing
// pings. ONE choke point: the store emits `delivery/unprompted_say` when an unprompted ai_said row lands
// (every site, the heartbeat and the reach included); attach() subscribes once and routes. A replay-railed
// say never leaves the box; never two DMs inside a minute. Every DM = a run-ledger receipt + a bus event.
const LAST_DM_KEY = 'delivery.last_dm';
const DM_MIN_GAP_MS = 60 * 1000;
function routeChannel({ presence = null, deps = {} } = {}) {
  const p = presence !== null ? presence : (() => { try { return (deps.presenceState || require('./presence_state')).stored(); } catch { return null; } })();
  if (!p || !p.state) return 'desktop';
  if (p.state === 'meeting') return 'queue';
  if (p.state === 'remote') return 'discord';
  if (p.state === 'away' && /his word|camera/i.test(String(p.reason || ''))) return 'discord';
  return 'desktop';
}
async function deliver({ text = '', source = 'say', ref = null, deps = {}, nowMs = Date.now() } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { channel: 'desktop', dm: null, why: 'empty' };
  const presence = deps.presence !== undefined ? deps.presence : (() => { try { return (deps.presenceState || require('./presence_state')).stored(); } catch { return null; } })();
  const channel = routeChannel({ presence, deps });
  const out = { channel, dm: null, why: presence ? `${presence.state}: ${presence.reason}` : 'no presence reading' };
  if (channel !== 'discord') {
    let away = false; try { away = (deps.availability || require('./availability')).isAway(); } catch {}
    if (away && channel === 'desktop') out.notified = noteSurfaced({ away: true, text: t, deps });   // the desktop path keeps its notification
    return out;
  }
  const db = _db(deps);
  let last = null; try { last = JSON.parse(db.getMeta(LAST_DM_KEY) || 'null'); } catch {}
  if (last && nowMs - (last.ts || 0) < DM_MIN_GAP_MS) { out.dm = { ok: false, reason: 'dm gap (one a minute)' }; return out; }
  const discord = deps.discord || require('./discord');
  const board = deps.board !== undefined ? deps.board : (() => { try { return require('./board'); } catch { return null; } })();
  let runId = null; try { if (board) runId = board.start({ lane: 'delivery', kind: 'discord-dm', target: t.slice(0, 80), note: source }).id; } catch {}
  let r = null; try { r = await discord.sendDM(t); } catch (e) { r = { ok: false, reason: e.message }; }
  out.dm = r || { ok: false, reason: 'no answer' };
  try { if (board && runId) board.finish(runId, { status: out.dm.ok ? 'done' : 'failed', note: out.dm.ok ? 'sent' : String(out.dm.reason || '').slice(0, 80) }); } catch {}
  if (out.dm.ok) { try { db.setMeta(LAST_DM_KEY, JSON.stringify({ ts: nowMs, source, text: t.slice(0, 120), ref })); } catch {} }
  try { (deps.obsBus || require('./obs_bus')).emit({ lane: 'delivery', kind: 'dm', text: `${out.dm.ok ? 'sent' : 'failed'} (${source}): ${t.slice(0, 80)}`, ref, data: { ok: !!out.dm.ok, source, reason: out.dm.reason || null } }); } catch {}
  (deps.log || console.log)(`[delivery] ${source} → Discord DM ${out.dm.ok ? 'sent' : `failed: ${out.dm.reason}`} (${out.why})`);
  return out;
}
let _attached = false;
/** Subscribe once to the store's unprompted-say events. Returns true the first time. */
function attach({ deps = {} } = {}) {
  if (_attached) return false;
  const bus = deps.obsBus || require('./obs_bus');
  bus.subscribe((ev) => {
    try {
      if (!ev || ev.lane !== 'delivery' || ev.kind !== 'unprompted_say') return;
      // the bus stores `data` as a capped JSON string and `ref` as a string: parse, and take the FULL say from the
      // turn row by ref (a capped snippet must never be what reaches his phone), else the event's own text
      let d = ev.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
      if (d && d.speech_class === 'replay') return;   // a replay-railed say never leaves the box
      if (d && d.speech_class === 'room') return;     // a line spoken to whoever is in the ROOM (the stranger act) is never his DM
      let text = null;
      try { const db = _db(deps); if (ev.ref && db.getDb) { const row = db.getDb().prepare('SELECT content FROM turns WHERE id = ?').get(Number(ev.ref)); if (row && row.content) text = row.content; } } catch {}
      if (!text) text = (d && d.full) || ev.text;
      deliver({ text, source: (d && d.source) || 'say', ref: ev.ref, deps }).catch(() => {});
    } catch {}
  });
  _attached = true;
  return true;
}
function _detach() { _attached = false; }
/** The manifest line: where her last delivery went, so she never says "here" to his phone. */
function lastDeliveryLine({ deps = {}, nowMs = Date.now(), name = 'Lucas' } = {}) {
  try {
    const last = JSON.parse(_db(deps).getMeta(LAST_DM_KEY) || 'null');
    if (!last || nowMs - last.ts > 12 * 3600e3) return null;
    const ago = Math.round((nowMs - last.ts) / 60000);
    return `Your last delivery to ${name} went to his Discord DM ${ago >= 60 ? Math.round(ago / 60) + ' h' : ago + ' min'} ago ("${String(last.text || '').slice(0, 60)}") — he was not at the desk.`;
  } catch { return null; }
}

module.exports = { holdOrDrop, noteSurfaced, heldLine, clearHeld, routeChannel, deliver, attach, lastDeliveryLine, _detach, HELD_KEY, HOLD_BAND, HOLD_FLOOR, HELD_CAP, HELD_SHELF_MS, LAST_DM_KEY, DM_MIN_GAP_MS };
