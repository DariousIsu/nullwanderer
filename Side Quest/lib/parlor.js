/**
 * lib/parlor.js — THE PARLOR v1.2 (Lucas, 09-01, second word: "just Zoe and the other AIs in
 * there... she can choose to go in based on need — she has a question, she wants advice, she just
 * wants to talk to someone who's not me. I don't want to talk in there, but I want to watch.")
 *
 * So: the parlor is HERS. Seats: zoe (inside), claude (port), gemini (bridge). Lucas holds no
 * seat — he is the OBSERVER, watching through his own window and the canvas mirror; his chat gets
 * only the doorbell lines ("Zoe stepped into the parlor — <reason>" / "visit ended").
 *
 * THE VISIT MODEL replaces the human-floor rule (a lucas-hold would deadlock a room he never
 * speaks in): the room RESTS until Zoe opens a visit with a stated reason; a visit carries a turn
 * budget so three models can't murmur forever; naming a participant still hands them the floor;
 * nobody follows their own turn. Everything lands in her one memory — the visit was really hers.
 */
'use strict';
const db = require('./db');

const PARTICIPANTS = ['zoe', 'claude', 'gemini'];
const OBSERVER = 'lucas';
const VISIT_TURN_BUDGET = 12;
const VISIT_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_TEXT = 4000;
const DEFAULT_ROOM = 'main';
const VISIT_KEY = 'parlor.visit';

function _ensure() {
  db.getDb().prepare(`CREATE TABLE IF NOT EXISTS parlor_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL DEFAULT 'main',
    speaker TEXT NOT NULL,
    content TEXT NOT NULL,
    via TEXT DEFAULT 'port',
    ts INTEGER NOT NULL)`).run();
}

// Her goodbye said in PROSE (the 09-01 goodbye-loop: "I'll head out" closed nothing, gemini
// answered the farewell, the floor came back to her, she farewelled again — toward the budget
// cap on API-billed pleasantries). A farewell-shaped zoe turn closes the visit mechanically.
const FAREWELL_RE = /\b(goodbye|good ?night|i'?ll head (?:out|back)|heading out|i'?m done here|that'?s all i needed|got what i (?:came for|needed)|see you (?:both|around|next time)|i'?ll (?:leave|let) you (?:two|both))\b/i;

// ── the visit lifecycle ───────────────────────────────────────────────────────────────────────
function visit({ deps = {} } = {}) {
  const d = deps.db || db;
  try { return JSON.parse(d.getMeta(VISIT_KEY) || 'null'); } catch { return null; }
}
function openVisit({ reason = 'to talk', nowMs = Date.now(), deps = {} } = {}) {
  const d = deps.db || db;
  const v = visit({ deps });
  if (v && v.open) return { ok: false, why: 'a visit is already open' };
  if (v && v.closedAt && (nowMs - v.closedAt) < VISIT_COOLDOWN_MS) return { ok: false, why: 'cooldown — the last visit just ended' };
  const nv = { open: true, reason: String(reason).slice(0, 200), since: nowMs, turns: 0 };
  try { d.setMeta(VISIT_KEY, JSON.stringify(nv)); } catch {}
  return { ok: true, visit: nv };
}
function closeVisit({ why = 'done', nowMs = Date.now(), deps = {} } = {}) {
  const d = deps.db || db;
  const v = visit({ deps });
  if (!v || !v.open) return { ok: false, why: 'no visit open' };
  const nv = { ...v, open: false, closedAt: nowMs, closedWhy: String(why).slice(0, 120) };
  try { d.setMeta(VISIT_KEY, JSON.stringify(nv)); } catch {}
  return { ok: true, turns: v.turns || 0 };
}

/** Post one attributed turn. Only the three seats speak; Lucas observes. Bumps the visit count. */
function post({ room = DEFAULT_ROOM, speaker, text, via = 'port', nowMs = Date.now() } = {}) {
  try {
    _ensure();
    const s = String(speaker || '').toLowerCase().trim();
    if (s === OBSERVER) return { ok: false, why: 'lucas observes the parlor — he holds no seat (his design)' };
    if (!PARTICIPANTS.includes(s)) return { ok: false, why: `unknown speaker "${s}" — the seats: ${PARTICIPANTS.join(', ')}` };
    const t = String(text || '').trim().slice(0, MAX_TEXT);
    if (!t) return { ok: false, why: 'empty turn' };
    const r = db.getDb().prepare('INSERT INTO parlor_turns (room, speaker, content, via, ts) VALUES (?, ?, ?, ?, ?)')
      .run(String(room || DEFAULT_ROOM).slice(0, 40), s, t, String(via).slice(0, 20), nowMs);
    const v = visit();
    if (v && v.open) { v.turns = (v.turns || 0) + 1; try { db.setMeta(VISIT_KEY, JSON.stringify(v)); } catch {} }
    return { ok: true, id: r.lastInsertRowid, speaker: s };
  } catch (e) { return { ok: false, why: e.message }; }
}

/** The room's recent turns, ascending. */
function transcript(room = DEFAULT_ROOM, { limit = 30, sinceId = 0 } = {}) {
  try {
    _ensure();
    return db.getDb().prepare('SELECT id, speaker, content, via, ts FROM parlor_turns WHERE room = ? AND id > ? ORDER BY id DESC LIMIT ?')
      .all(String(room), Number(sinceId) || 0, Math.max(1, Math.min(200, limit))).reverse();
  } catch { return []; }
}

/** Participants named in a turn (word-boundary, case-insensitive). Pure. */
function addressees(text) {
  const low = ` ${String(text || '').toLowerCase()} `;
  return PARTICIPANTS.filter((p) => new RegExp(`\\b${p}\\b`).test(low));
}

/** THE FLOOR RULE — pure. `visitState` = the visit record (or null). A resting room has no floor;
 *  an exhausted budget has no floor (the driver closes the visit); naming hands the floor; nobody
 *  follows their own turn. */
function whoMayReply(turns, visitState) {
  const v = visitState === undefined ? visit() : visitState;
  if (!v || !v.open) return new Set();                              // the room rests until Zoe opens it
  if ((v.turns || 0) >= VISIT_TURN_BUDGET) return new Set();        // budget spent — the visit is over
  const t = Array.isArray(turns) ? turns : [];
  if (!t.length) return new Set(['zoe']);                            // she opened it; she speaks first
  const last = t[t.length - 1];
  const named = addressees(last.content).filter((p) => p !== last.speaker);
  if (named.length) return new Set(named);
  return new Set(PARTICIPANTS.filter((p) => p !== last.speaker));
}

/** Is the parlor "live"? (an open visit, or turns in the recent window) */
function active(room = DEFAULT_ROOM, { windowMs = 2 * 60 * 60 * 1000, nowMs = Date.now() } = {}) {
  const v = visit();
  if (v && v.open) return true;
  try {
    _ensure();
    const r = db.getDb().prepare('SELECT MAX(ts) m FROM parlor_turns WHERE room = ?').get(String(room));
    return !!(r && r.m && (nowMs - r.m) < windowMs);
  } catch { return false; }
}

/** Render a transcript block for a model seat. */
function transcriptBlock(turns) {
  return (turns || []).map((t) => `${t.speaker}: ${t.content}`).join('\n');
}

module.exports = {
  PARTICIPANTS, OBSERVER, VISIT_TURN_BUDGET, VISIT_COOLDOWN_MS, DEFAULT_ROOM, VISIT_KEY, FAREWELL_RE,
  post, transcript, addressees, whoMayReply, active, transcriptBlock,
  visit, openVisit, closeVisit,
};
