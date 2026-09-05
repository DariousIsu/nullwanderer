'use strict';
/*
 * lib/presence_state.js — PRESENCE AS A MEASUREMENT (the wants project, cut 2 piece 1, widened by W7;
 * 2026-09-05). Four states — here · remote · away · meeting — fused from what the box can read and from
 * his word, which outranks every sensor:
 *   meeting  the voice guard is paused for a meeting, or the calendar says busy
 *   remote   his word ("I'm remoting in from Baton Rouge"), or the OS reports a remote session
 *   away     his word ("I'm at X, not at my computer"), or long idleness with no face
 *   here     the camera says him (fresh), or recent activity with no remote session
 * A stated location holds until he says otherwise. `availability.isAway()` keeps its meaning and becomes
 * one input. Pure fuse + a deterministic net over his statements; the tick persists meta presence.state
 * and presence.location and emits on change. The reply grounds in awarenessLine() and never says "here"
 * when he is remote. channelFor() is the router's seam (desktop when here, a Discord DM when remote or
 * away, a queued note in a meeting) — the reach and the delivery consume it in cut 2's later pieces.
 */
const STATE_KEY = 'presence.state';
const LOCATION_KEY = 'presence.location';
const IDLE_AWAY_MS = 30 * 60 * 1000;
const FACE_FRESH_MS = 12000;
const STATES = ['here', 'remote', 'away', 'meeting'];

const _clean = (s) => String(s || '').trim().replace(/[.!?,;:]+$/, '').replace(/\s+/g, ' ').slice(0, 80);

/**
 * His word about where he is. Deterministic; returns null when the turn says nothing about it.
 * Shapes: "I'm remoting in from X" / "remote-accessing from X" → remote + place;
 *         "I'm at X, not at my computer" / "not at my desk, I'm in X" → away + place;
 *         "back at my desk" / "I'm back at the computer" / "I'm home" → here (+ place);
 *         "I'm at X" alone → a place, no state change.
 */
function detectLocationStatement(text) {
  const t = String(text || '');
  let m;
  if ((m = /\b(?:i'?m |i am )?(?:remot(?:e|ing)[- ]?(?:in|access(?:ing)?)|remote[- ]desktop(?:ing)?|rdp(?:'?d|ing)?|logged in remotely|dialed in)\b[^.!?]*?\b(?:from|at|in) ([^.!?,;]+)/i.exec(t))) return { state: 'remote', place: _clean(m[1]), remote: true };
  if (/\b(?:remot(?:e|ing)[- ]?(?:in|access(?:ing)?)|remote[- ]desktop|rdp)\b/i.test(t) && !/\bnot remot/i.test(t)) return { state: 'remote', place: null, remote: true };
  if ((m = /\b(?:back at|back to) (?:my |the )?(?:desk|computer|machine|keyboard)\b|\bi'?m back(?: at (?:my |the )?(?:desk|computer))?\b|\bi'?m (?:home|at home) now\b/i.exec(t))) return { state: 'here', place: /home/i.test(m[0]) ? 'home' : null, remote: false };
  if ((m = /\bi'?m (?:at|in) ([^.!?,;]+?)(?:,|;| and| but| —| -)?\s+(?:and )?(?:i'?m )?not (?:at|near) (?:my |the )?(?:computer|desk|machine)\b/i.exec(t))) return { state: 'away', place: _clean(m[1]), remote: false };
  if ((m = /\bnot at (?:my |the )?(?:computer|desk|machine)\b[^.!?]*?\b(?:i'?m |i am )?(?:at|in) ([^.!?,;]+)/i.exec(t))) return { state: 'away', place: _clean(m[1]), remote: false };
  if (/\b(?:away from|not at) (?:my |the )?(?:computer|desk|machine|keyboard)\b/i.test(t)) return { state: 'away', place: null, remote: false };
  if ((m = /\b[Ii]'?m (?:at|in) (?:the )?(office|home|[A-Z][a-z]+(?: [A-Z][a-z]+)?)\b/.exec(t)) && !/\bmeeting\b/i.test(t)) return { state: null, place: _clean(m[1]), remote: null };   // a place alone (a capitalized name, the office, home) — a fact, no state change
  return null;
}

/** The OS remote-session reading (Windows): SESSIONNAME RDP-…, or `query session` naming an rdp-tcp active session. Fail-soft. */
function readRemoteSession({ env = process.env, queryOut = null } = {}) {
  const name = String(env.SESSIONNAME || '');
  if (/^rdp-/i.test(name)) return { active: true, name, source: 'SESSIONNAME' };
  if (queryOut) {
    const line = String(queryOut).split(/\r?\n/).find((l) => /^\s*>?\s*rdp-tcp#?\d*\s+\S+\s+\d+\s+Active/i.test(l));
    if (line) return { active: true, name: line.trim().split(/\s+/)[0].replace(/^>/, ''), source: 'query session' };
  }
  return { active: false, name: name || null, source: null };
}

/** The fuse. Every input optional; his word outranks the sensors; meeting > remote > away > here. */
function fuse({ now = Date.now(), lastUserTurnTs = 0, guard = null, calendarBusy = false, remoteSession = null, face = null, hisWord = null, prev = null, idleAwayMs = IDLE_AWAY_MS } = {}) {
  const idleMs = lastUserTurnTs ? Math.max(0, now - lastUserTurnTs) : Infinity;
  const faceFresh = face && face.at && now - face.at <= FACE_FRESH_MS;
  const himHere = !!(faceFresh && face.present && face.is_him !== false);
  const location = (hisWord && hisWord.location) || (prev && prev.location) || null;
  let state, reason;
  if (guard && guard.paused && /meet|teams|zoom|call|calendar|meeting/i.test(String(guard.reason || '')) || calendarBusy) { state = 'meeting'; reason = guard && guard.paused ? `voice guard: ${guard.reason}` : 'calendar busy'; }
  else if (location && location.remote === true) { state = 'remote'; reason = `his word: remoting in${location.place ? ` from ${location.place}` : ''}`; }
  else if (hisWord && hisWord.away) { state = 'away'; reason = `his word: ${hisWord.awayReason || 'away'}`; }
  else if (remoteSession && remoteSession.active) { state = 'remote'; reason = `remote session (${remoteSession.source}: ${remoteSession.name})`; }
  else if (himHere) { state = 'here'; reason = face.looking_at_screen ? 'camera: him, looking at the screen' : 'camera: him'; }
  else if (faceFresh && face.present && face.is_him === false) { state = idleMs < idleAwayMs ? 'here' : 'away'; reason = 'camera: someone else is in front of the camera'; }
  else if (idleMs < idleAwayMs) { state = 'here'; reason = `active ${Math.round(idleMs / 60000)}m ago${faceFresh && !face.present ? ', no one on camera' : ''}`; }
  else { state = 'away'; reason = idleMs === Infinity ? 'no turn yet' : `idle ${Math.round(idleMs / 60000)}m${faceFresh && !face.present ? ', no one on camera' : ''}`; }
  const since = prev && prev.state === state && prev.since ? prev.since : now;
  return { state, since, reason, location: location || null, idleMs: idleMs === Infinity ? null : idleMs, at: now };
}

function channelFor(state) { return state === 'meeting' ? 'queue' : (state === 'remote' || state === 'away') ? 'discord' : 'desktop'; }

// ── the organ ───────────────────────────────────────────────────────────────────────────────────────
function _db(deps) { return deps.db || require('./db'); }
function stored(deps = {}) { try { const v = _db(deps).getMeta(STATE_KEY); return v ? JSON.parse(v) : null; } catch { return null; } }
function storedLocation(deps = {}) { try { const v = _db(deps).getMeta(LOCATION_KEY); return v ? JSON.parse(v) : null; } catch { return null; } }

/** His word at the chat door: a location statement writes presence.location (authoritative) and re-fuses now. */
function recordHisWord(text, { turnId = null, deps = {} } = {}) {
  const hit = detectLocationStatement(text);
  if (!hit) return null;
  const now = deps.now || Date.now();   // one clock: the injected one when a test (or the tick) supplies it
  const db = _db(deps);
  const prevLoc = storedLocation(deps);
  const location = hit.state === 'here'
    ? { place: hit.place || 'at the desk', since: now, source: 'his word', turn_id: turnId, remote: false, here: true }
    : { place: hit.place || (prevLoc && hit.remote === prevLoc.remote ? prevLoc.place : null), since: now, source: 'his word', turn_id: turnId, remote: hit.remote === true, away: hit.state === 'away' };
  try { db.setMeta(LOCATION_KEY, JSON.stringify(location)); } catch {}
  (deps.log || console.log)(`[presence] his word → ${hit.state || 'place'}${location.place ? ` (${location.place})` : ''}`);
  try { tick({ deps: { ...deps, now } }); } catch {}
  return { ...hit, location };
}

/** The 60-second tick (and the chat door): read every sensor, fuse, persist on change, emit on change. */
function tick({ deps = {} } = {}) {
  const now = deps.now || Date.now();
  const db = _db(deps);
  const prev = stored(deps);
  const location = storedLocation(deps);
  let hisWord = null;
  try { const av = deps.availability || require('./availability'); hisWord = { away: av.isAway(), awayReason: av.awayReason && av.awayReason(), location }; } catch { hisWord = { away: false, location }; }
  if (location && location.here) hisWord.location = { ...location, remote: false };   // "back at my desk" clears remote; the place stays as a fact
  if (location && location.away) hisWord.away = true, hisWord.awayReason = hisWord.awayReason || `at ${location.place || 'elsewhere'}`;
  let guard = null; try { guard = deps.guardState ? deps.guardState() : null; } catch {}
  let calendarBusy = false; try { calendarBusy = deps.calendarBusy ? !!deps.calendarBusy() : false; } catch {}
  let remoteSession = null; try { remoteSession = deps.remoteSession ? deps.remoteSession() : readRemoteSession({}); } catch {}
  let face = null; try { face = deps.face ? deps.face() : require('./face_sense').current(); } catch {}
  const lastUserTurnTs = Number(deps.lastUserTurnTs !== undefined ? deps.lastUserTurnTs : (() => { try { return Number(db.getMeta('last_user_turn_ts')) || 0; } catch { return 0; } })()) || 0;
  const next = fuse({ now, lastUserTurnTs, guard, calendarBusy, remoteSession, face, hisWord, prev });
  const changed = !prev || prev.state !== next.state || (prev.location && prev.location.place) !== (next.location && next.location.place);
  if (changed || !prev || now - (prev.at || 0) > 5 * 60 * 1000) { try { db.setMeta(STATE_KEY, JSON.stringify(next)); } catch {} }
  if (changed) {
    (deps.log || console.log)(`[presence] state=${next.state} (${next.reason})${next.location && next.location.place ? ` · location: ${next.location.place}` : ''}`);
    try { (deps.obsBus || require('./obs_bus')).emit({ lane: 'presence', kind: 'state', text: `${next.state}: ${next.reason}`, data: { state: next.state, from: prev && prev.state, location: next.location && next.location.place } }); } catch {}
  }
  return next;
}

/** The manifest line: where he is and how she knows. Never "here" when he is remote. */
function awarenessLine({ deps = {}, now = Date.now(), name = 'Lucas' } = {}) {
  const s = stored(deps);
  if (!s) return null;
  const ago = s.since ? Math.round((now - s.since) / 60000) : null;
  const loc = s.location && s.location.place ? s.location.place : null;
  if (s.state === 'remote') return `PRESENCE: ${name} is REMOTE — ${loc ? `in ${loc}, ` : ''}reaching this machine over a remote session (${s.reason}${ago != null ? `, for ${ago}m` : ''}). He is not at this desk: never say "here"; his keyboard activity is the remote session.`;
  if (s.state === 'away') return `PRESENCE: ${name} is AWAY (${s.reason}${ago != null ? `, ${ago}m` : ''})${loc ? ` — his last stated location: ${loc}` : ''}.`;
  if (s.state === 'meeting') return `PRESENCE: ${name} is in a MEETING (${s.reason}) — speech is held; a note waits.`;
  return `PRESENCE: ${name} is HERE at the desk (${s.reason}${ago != null ? `, for ${ago}m` : ''})${loc && loc !== 'at the desk' ? ` — ${loc}` : ''}.`;
}

module.exports = { detectLocationStatement, readRemoteSession, fuse, channelFor, recordHisWord, tick, stored, storedLocation, awarenessLine, STATES, STATE_KEY, LOCATION_KEY, IDLE_AWAY_MS, FACE_FRESH_MS };
