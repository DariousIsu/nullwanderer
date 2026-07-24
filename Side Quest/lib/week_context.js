/**
 * lib/week_context.js — HIS WEEK: the calendar as ambient conversational context.
 *
 * Lucas, 2026-07-22: he mentioned Bloomberg in casual chat — no instruction, nothing to research —
 * and the expectation was that she'd already KNOW his week: last week's meeting in DC, this week's
 * Teams call, who it's with — and connect conversationally ("how did DC go?", a follow-up about the
 * people in Thursday's call). The calendar was a connected surface that never reached a casual turn.
 *
 * This builds a compact HIS-WEEK block from the primary calendar (−7d … +8d): recent meetings and
 * upcoming ones, each with its people. Two consumers:
 *   • the CHAT awareness block (appended per turn — cached, zero added latency: a stale cache
 *     refreshes in the background and the NEXT turn has it)
 *   • the AUTONOMY manifest (the people he's about to meet are prime research/engage material)
 *
 * Fail-soft everywhere: Google not connected / fetch error → empty block, never a broken turn.
 * The cold-start race (boot-time "not connected") self-heals — every stale read retries.
 * Pure formatting is separated from IO → offline-smokeable (scripts/smoke_week_context.js).
 */
'use strict';

const TTL_MS = 15 * 60 * 1000;
const PAST_DAYS = 7, AHEAD_DAYS = 8;
let _cache = { text: '', lines: '', at: 0 };
let _refreshing = false;

// Eastern rendering, without coupling to lib/tz's API surface: Intl with the house zone IS the rule.
// ALL-DAY events are zone-less calendar DATES ("2026-07-27") — Date.parse reads them as UTC
// midnight, which is the PREVIOUS evening Eastern (the repo's recurring UTC-midnight bug). Render
// those in UTC so the calendar date survives; timed events render in the house zone.
function _fmt(ms, { withTime = true, utcDate = false } = {}) {
  try {
    return new Date(ms).toLocaleString('en-US', {
      timeZone: utcDate ? 'UTC' : 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
      ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
    });
  } catch { return new Date(ms).toISOString().slice(0, 16); }
}

function _startMs(ev) {
  const s = (ev && ev.start) || {};
  const v = s.dateTime || s.date;
  const ms = v ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
function _endMs(ev) {
  const e = (ev && ev.end) || {};
  const v = e.dateTime || e.date;
  const ms = v ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : _startMs(ev);
}

function _people(ev, max = 6) {
  const raw = (ev && ev.attendees) || [];
  const names = raw
    .filter((a) => a && !a.self && !a.resource && a.responseStatus !== 'declined')
    .map((a) => (a.displayName || String(a.email || '').split('@')[0] || '').trim())
    .filter(Boolean);
  if (!names.length) return '';
  const shown = names.slice(0, max);
  return shown.join(', ') + (names.length > max ? ` (+${names.length - max} more)` : '');
}

function _venue(ev) {
  const conf = ev && ev.conferenceData && ev.conferenceData.conferenceSolution && ev.conferenceData.conferenceSolution.name;
  if (conf) return conf;
  const hay = `${(ev && ev.location) || ''} ${(ev && ev.description) || ''}`;
  if (/\bteams\b|teams\.microsoft/i.test(hay)) return 'Teams';
  if ((ev && ev.hangoutLink) || /meet\.google/i.test(hay)) return 'Google Meet';
  if (/\bzoom\b|zoom\.us/i.test(hay)) return 'Zoom';
  return (ev && ev.location) ? String(ev.location).slice(0, 60) : '';
}

/** PURE: Google events → { lines, text }. lines = the facts; text = lines + the conversational
 *  guidance (chat gets text; the autonomy manifest gets lines — no chat-voice in a manifest). */
function formatWeek(items, { now = Date.now() } = {}) {
  const evs = (items || [])
    .filter((e) => e && e.status !== 'cancelled' && _startMs(e) != null)
    .map((e) => ({ ev: e, start: _startMs(e), end: _endMs(e) }))
    .sort((a, b) => a.start - b.start);
  const past = evs.filter((x) => x.end < now).slice(-5);
  const upcoming = evs.filter((x) => x.end >= now).slice(0, 6);
  if (!past.length && !upcoming.length) return { lines: '', text: '' };

  const line = (x, isPast) => {
    const e = x.ev;
    const who = _people(e);
    const where = _venue(e);
    const allDay = !((e.start || {}).dateTime);
    return `  ${isPast ? 'Past' : 'Coming'}: ${_fmt(x.start, { withTime: !allDay, utcDate: allDay })} — "${String(e.summary || '(untitled)').slice(0, 80)}"`
      + (where ? ` (${where})` : '') + (who ? `, with ${who}` : '');
  };
  const lines = [
    ...past.map((x) => line(x, true)),
    ...upcoming.map((x) => line(x, false)),
  ].join('\n');

  const text = `HIS WEEK (live from his calendar — you can see this):\n${lines}\n`
    + `When he talks about his day or week, these are the real events behind it — connect to them naturally: `
    + `ask how a past one went, or about the substance or people of a coming one. One thread at a time, `
    + `conversationally; never recite the list. A person or meeting here you know nothing about is a real `
    + `question worth asking him.`;
  return { lines, text };
}

/** Refresh the cache from the live calendar (TTL-guarded, single-flight). Fail-soft. */
async function refresh({ gcalOpts = {}, deps = {}, now = Date.now(), force = false } = {}) {
  if (!force && (now - _cache.at) < TTL_MS) return _cache;
  if (_refreshing) return _cache;
  _refreshing = true;
  try {
    const gcal = deps.gcal || require('./gcal');
    // NOT CONNECTED (cold boot: Echo token bridge not warm yet) → empty, but back off only ~1min and
    // retry, mirroring the fetch-error branch below. Stamping `at: now` here (the old bug) marked the
    // empty block FRESH for the full 15-min TTL, so blockFor kept serving '' and HIS WEEK stayed blank
    // for 15 minutes after boot — contradicting this file's "self-heals every stale read" promise.
    if (!gcal.isConnected(gcalOpts)) { _cache = { text: '', lines: '', at: now - TTL_MS + 60e3 }; return _cache; }
    const r = await gcal.listEvents({
      calendarId: 'primary',
      timeMin: new Date(now - PAST_DAYS * 86400e3).toISOString(),
      timeMax: new Date(now + AHEAD_DAYS * 86400e3).toISOString(),
      maxResults: 50,
    }, gcalOpts);
    const { lines, text } = formatWeek((r && r.items) || [], { now });
    _cache = { text, lines, at: now };
    if (text) console.log(`[week] calendar context refreshed — ${lines.split('\n').length} event line(s)`);
  } catch (e) {
    console.error('[week] refresh failed (keeping stale):', e.message);
    _cache.at = now - TTL_MS + 60e3;   // back off ~1 min, then retry — never hot-loop a dead API
  } finally { _refreshing = false; }
  return _cache;
}

/** Zero-latency read for the chat turn: cached text now; stale → background refresh, next turn has it. */
function blockFor({ gcalOpts = {}, now = Date.now() } = {}) {
  if ((now - _cache.at) >= TTL_MS) refresh({ gcalOpts, now }).catch(() => {});
  return _cache.text;
}

function cached() { return _cache; }
function _resetCache() { _cache = { text: '', lines: '', at: 0 }; }   // tests

/**
 * Is this message a question about HIS schedule/calendar — one answerable from the events she
 * already holds (HIS WEEK), NOT a records/web lookup? "when is the BGov meeting", "my next
 * meeting", "what's on my calendar", "what do I have today", "what time is the standup". Pure.
 *
 * Why this exists: without it, "when is the BGov meeting today?" fell through to the cognition
 * ladder (records → web excavation), which has no calendar in its grounding — so it treated the
 * meeting as a NEW ENTITY to research, missed, and said "I couldn't pin down the BGov meeting"
 * while the answer (BGOV 10:00 Teams) sat right there in HIS WEEK. This routes it home.
 *
 * Tuned to fire on a PERSONAL schedule ask (anchored on "my"/a meeting noun/a calendar noun) and
 * stay quiet on a general "when did X happen" history/current-events question ("when is the next
 * election" has no meeting/my/calendar anchor → false).
 */
function isScheduleQuestion(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return false;
  // His calendar/schedule as a whole ("what's on my calendar", "today's schedule", "my agenda").
  if (/\b(my|the|today'?s|tomorrow'?s|this week'?s)\s+(schedule|calendar|agenda|itinerary)\b/.test(t)) return true;
  // His meetings/calls as possessions ("my next meeting", "my meetings", "my call with Sam").
  if (/\bmy\s+(next\s+|last\s+|first\s+|1st\s+)?(meeting|call|appointment|standup|sync|huddle|interview|demo|briefing)s?\b/.test(t)) return true;
  if (/\bnext\s+meeting\b/.test(t)) return true;
  // Availability.
  if (/\bam i\s+(free|busy|booked|available|open)\b/.test(t)) return true;
  if (/\bdo i have\b.*\b(meeting|call|appointment|anything|plans|scheduled|standup|sync|today|tomorrow|this (morning|afternoon|evening|week)|on my (calendar|schedule))\b/.test(t)) return true;
  // "when / what time is <the … meeting/call/standup/…>" — a scheduled-event TIME ask.
  if (/\b(when'?s|when is|when are|when do i|what time( is|'?s| does| do)?)\b.*\b(meeting|call|appointment|standup|sync|huddle|demo|interview|briefing|session)\b/.test(t)) return true;
  // "what meetings / what do I have … today / this week / on my calendar".
  if (/\bwhat\b.*\b(meetings?|do i have|going on|happening|planned|scheduled)\b.*\b(today|tomorrow|this (week|morning|afternoon)|on my (calendar|schedule))\b/.test(t)) return true;
  return false;
}

/**
 * Grounding block for a schedule question — the held HIS WEEK event LINES (facts, no chat guidance),
 * framed as the authoritative source so the cognition draft answers FROM them instead of searching.
 * Async so it can fetch when the cache is stale OR force through a fresh-but-empty (cold-boot) cache;
 * a schedule question is worth the one round-trip to be right. Fail-soft: no calendar → '' (caller
 * degrades to normal grounding, no worse than before). gcalOpts carries Echo's token bridge.
 */
async function scheduleGrounding({ gcalOpts = {}, now = Date.now(), deps = {} } = {}) {
  let lines = String((_cache && _cache.lines) || '').trim();
  if (!lines || (now - _cache.at) >= TTL_MS) {
    try { const c = await refresh({ gcalOpts, now, force: !lines, deps }); lines = String((c && c.lines) || '').trim(); } catch {}
  }
  if (!lines) return '';
  return 'His calendar — live, the authoritative source for his schedule (all times Eastern). Answer '
    + 'his schedule question from THESE events; pick the one he means by name/day/time, and give the '
    + 'time (and place/platform if shown). Do not say you could not find it — it is here:\n' + lines;
}

module.exports = { formatWeek, refresh, blockFor, cached, _resetCache, isScheduleQuestion, scheduleGrounding, TTL_MS };
