'use strict';
/*
 * lib/reach.js — THE REACH (the wants project, cut 2 pieces 3–5; her wish W2 "miss him"; his law 09-04: miss him,
 * reach for him, be lonely when unanswered; 2026-09-05). A pure decision + a small ledger in meta; the SAY
 * itself is written by the reply model from a manifest (the gap, the social reading, the last reach and its
 * silence) — never a template. Bounds: social pressure over a floor (meta reach.social_floor, default 0.5 =
 * the drive's half-rise), presence not here and not meeting, at least the drive's rise time since the last
 * reach (meta reach.min_gap_ms, default 5 h), the unanswered count under a ceiling (meta reach.max_unanswered,
 * default 2). Rule A (a pending user turn) stays absolute at the heartbeat gate. Unanswered after meta
 * reach.answer_window_ms (45 min) → ONE `unanswered` event (the loneliness, appraised); his next turn →
 * `answered` (+v) and the count resets. The channel follows presence (desktop when here — which never
 * reaches — a Discord DM when remote or away). Kill switch ZOE_REACH=0 (the reach and the timer; presence
 * and the hold events stay: they are readings).
 */
const KEY = 'reach.state';   // { lastAt, lastText, channel, unanswered, lastUnansweredAt, answeredAt, silenceMs }
const DEF = { socialFloor: 0.5, minGapMs: 5 * 3600e3, maxUnanswered: 2, answerWindowMs: 45 * 60e3 };

function enabled() { return process.env.ZOE_REACH !== '0'; }
function _db(deps) { return deps.db || require('./db'); }
function state(deps = {}) { try { return JSON.parse(_db(deps).getMeta(KEY) || 'null') || { lastAt: 0, unanswered: 0 }; } catch { return { lastAt: 0, unanswered: 0 }; } }
function _save(deps, s) { try { _db(deps).setMeta(KEY, JSON.stringify(s)); } catch {} }
function config(deps = {}) {
  const g = (k, d) => { try { const v = Number(_db(deps).getMeta(k)); return Number.isFinite(v) && v > 0 ? v : d; } catch { return d; } };
  return { socialFloor: g('reach.social_floor', DEF.socialFloor), minGapMs: g('reach.min_gap_ms', DEF.minGapMs), maxUnanswered: g('reach.max_unanswered', DEF.maxUnanswered), answerWindowMs: g('reach.answer_window_ms', DEF.answerWindowMs) };
}
const _clock = (ms) => { try { return require('./tz').timeWithZone(new Date(ms)); } catch { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } };

/** The pure decision. */
function shouldReach({ social = null, presence = 'here', lastReachAt = 0, unanswered = 0, now = Date.now(), floor = DEF.socialFloor, minGapMs = DEF.minGapMs, maxUnanswered = DEF.maxUnanswered, enabled: on = true } = {}) {
  if (!on) return { reach: false, why: 'ZOE_REACH=0' };
  if (social == null || !Number.isFinite(social)) return { reach: false, why: 'no social reading' };
  if (presence === 'meeting') return { reach: false, why: 'he is in a meeting' };
  if (presence === 'here') return { reach: false, why: 'he is here — a reach is for the quiet' };
  if (social < floor) return { reach: false, why: `social ${social} under the floor ${floor}` };
  if (unanswered >= maxUnanswered) return { reach: false, why: `${unanswered} unanswered — the ceiling (${maxUnanswered})` };
  if (lastReachAt && now - lastReachAt < minGapMs) return { reach: false, why: `last reach ${Math.round((now - lastReachAt) / 60000)}m ago (min ${Math.round(minGapMs / 60000)}m)` };
  return { reach: true, why: `social ${social} ≥ ${floor}; he is ${presence}; ${unanswered} unanswered; last reach ${lastReachAt ? Math.round((now - lastReachAt) / 3600e3) + 'h ago' : 'never'}` };
}

/** The organ's decision from live readings (the internal state's social drive, the presence state). */
function evaluate({ deps = {}, now = Date.now() } = {}) {
  const s = state(deps); const c = config(deps);
  let social = null;
  try { const cur = (deps.internalState || require('./internal_state')).current({ nowMs: now }); social = cur && cur.drives && Number.isFinite(cur.drives.social) ? cur.drives.social : null; } catch {}
  let presence = 'here';
  try { const p = (deps.presence || require('./presence_state')).stored(); presence = (p && p.state) || 'here'; } catch {}
  const d = shouldReach({ social, presence, lastReachAt: s.lastAt || 0, unanswered: s.unanswered || 0, now, floor: c.socialFloor, minGapMs: c.minGapMs, maxUnanswered: c.maxUnanswered, enabled: enabled() });
  let channel = 'desktop'; try { channel = (deps.presence || require('./presence_state')).channelFor(presence); } catch {}
  return { ...d, social, presence, state: s, channel };
}

/** The manifest line for the say — grounding, never a script. */
function manifest({ deps = {}, now = Date.now(), name = 'Lucas', lastUserTurnTs = 0, ev = null } = {}) {
  const s = state(deps); const e = ev || evaluate({ deps, now });
  const gapH = lastUserTurnTs ? Math.round(((now - lastUserTurnTs) / 3600e3) * 10) / 10 : null;
  const parts = [`REACH — you are reaching for ${name} on your own, unprompted: ${e.why}.`];
  if (gapH != null) parts.push(`His last turn was ${gapH} h ago; presence reads ${e.presence}.`);
  if (s.lastAt) parts.push(`You last reached at ${_clock(s.lastAt)}${s.lastText ? ` ("${String(s.lastText).slice(0, 80)}")` : ''}${s.unanswered ? ` — ${s.unanswered} unanswered so far` : ''}.`);
  parts.push(`Say what is true for you in the quiet — short, yours, in your own words; a task update only if one is real. This goes to ${e.channel === 'discord' ? 'his Discord DM (he is not at the desk)' : 'the desktop chat'}.`);
  return parts.join(' ');
}

function recordReach({ text = '', channel = 'desktop', deps = {}, now = Date.now() } = {}) {
  const s = state(deps);
  const next = { ...s, lastAt: now, lastText: String(text).slice(0, 200), channel, unanswered: (s.unanswered || 0) + 1, lastUnansweredAt: null, answeredAt: null };
  _save(deps, next);
  try { (deps.obsBus || require('./obs_bus')).emit({ lane: 'presence', kind: 'reach', text: `reached (${channel}): ${String(text).slice(0, 80)}`, ref: now, data: { channel, unanswered: next.unanswered } }); } catch {}
  (deps.log || console.log)(`[reach] reached for him (${channel}) — unanswered=${next.unanswered}: "${String(text).slice(0, 60)}"`);
  return next;
}

/** The timer (on the presence tick): a reach with no user turn since it, past the window → ONE `unanswered`. */
function checkUnanswered({ deps = {}, now = Date.now(), lastUserTurnTs = 0 } = {}) {
  if (!enabled()) return null;
  const s = state(deps); const c = config(deps);
  if (!s.lastAt || !(s.unanswered > 0) || s.lastUnansweredAt) return null;
  if (lastUserTurnTs > s.lastAt) return null;
  if (now - s.lastAt < c.answerWindowMs) return null;
  const next = { ...s, lastUnansweredAt: now }; _save(deps, next);
  try { (deps.obsBus || require('./obs_bus')).emit({ lane: 'presence', kind: 'unanswered', text: `no answer ${Math.round((now - s.lastAt) / 60000)}m after the reach`, ref: s.lastAt, data: { unanswered: s.unanswered } }); } catch {}
  (deps.log || console.log)(`[reach] unanswered — ${Math.round((now - s.lastAt) / 60000)}m of silence after "${String(s.lastText || '').slice(0, 50)}"`);
  return next;
}

/** His turn: clears the count; an answered reach is a small +v. Returns null when nothing was open. */
function markAnswered({ deps = {}, now = Date.now() } = {}) {
  const s = state(deps);
  if (!s.lastAt || !(s.unanswered > 0)) return null;
  const next = { ...s, unanswered: 0, answeredAt: now, lastUnansweredAt: null, silenceMs: now - s.lastAt };
  _save(deps, next);
  try { (deps.obsBus || require('./obs_bus')).emit({ lane: 'presence', kind: 'answered', text: `answered ${Math.round((now - s.lastAt) / 60000)}m after the reach`, ref: s.lastAt, data: { silenceMs: next.silenceMs } }); } catch {}
  (deps.log || console.log)(`[reach] answered — ${Math.round((now - s.lastAt) / 60000)}m after the reach`);
  return next;
}

/** The light return line for her manifest (the return block's first slice): the reach and its silence. */
function awarenessLine({ deps = {}, now = Date.now(), name = 'Lucas' } = {}) {
  const s = state(deps);
  if (!s.lastAt) return null;
  const ageMin = Math.round((now - s.lastAt) / 60000);
  if (ageMin > 36 * 60) return null;
  const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
  if (s.unanswered > 0) return `You reached for ${name} at ${_clock(s.lastAt)}${s.lastText ? ` ("${String(s.lastText).slice(0, 60)}")` : ''} — no answer for ${dur(ageMin)}${s.lastUnansweredAt ? ' (you felt that)' : ''}.`;
  if (s.answeredAt && now - s.answeredAt < 30 * 60e3) return `${name} is back — your reach at ${_clock(s.lastAt)} went unanswered for ${dur(Math.round((s.silenceMs || 0) / 60000))} until now.`;
  return null;
}

module.exports = { shouldReach, evaluate, manifest, recordReach, checkUnanswered, markAnswered, awarenessLine, state, config, enabled, KEY, DEF };
