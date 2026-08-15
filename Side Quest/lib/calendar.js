/**
 * lib/calendar.js — calendar awareness for the time model (Pillar 0 of the verifiable research track).
 *
 * "Track effort, speak wall-clock": a run carries WORK-REMAINING (the invariant); the spoken ETA is
 * `now + work-remaining`, made MEETING-AWARE here — known future events are subtracted, so "3h of work,
 * but you have the 1030 meeting" projects realistically. Also resolves deadline phrases ("for the 1030
 * meeting", "by 4pm") to a real timestamp so a request can be scoped to fit the window before it.
 *
 * CONNECTED (2026-08-15): main.js registers a cache-serving provider over lib/gcal at boot (5-min
 * refresh timer, 30-min disconnected backoff) and the intake readback speaks etaSuffix() — the seam
 * shipped stubbed 06-30 and sat dark with zero setProvider callers until the senses sweep found it.
 * This module still does NOT fetch or auth anything itself — the event SOURCE stays a swappable
 * provider (stub → [] → naive ETA), so the math remains pure and offline-testable.
 *
 * The MATH is PURE + offline-testable (events in as data). Fail-safe: every function returns a value,
 * never throws on bad input; no calendar / a dead provider → [] → naive ETA, no crash.
 */
'use strict';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// --- event normalization (tolerant of field-name / unit variation) -----------

// Coerce a start/end value to ms-epoch. Accepts unix SECONDS, ms, or an ISO string.
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? Math.round(v * 1000) : Math.round(v);   // < 1e12 ⇒ seconds
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    if (!Number.isNaN(n)) return toMs(n);
    const p = Date.parse(t);
    return Number.isNaN(p) ? null : p;
  }
  return null;
}

// One raw calendar row → { start, end, title, source } in ms, or null if it has no usable start.
// Google's shape is an OBJECT ({start:{dateTime}} / all-day {start:{date}}): the old ?? chain stopped
// at the truthy object and toMs(object) → null, so every real Google event was silently DROPPED — the
// claimed tolerance was a lie for the one provider that matters. Unwrap objects before coercing.
function _unwrapTime(v) {
  if (v && typeof v === 'object') return v.dateTime ?? v.date ?? null;
  return v;
}
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sRaw = raw.start_at ?? _unwrapTime(raw.start) ?? raw.begin ?? raw.startTime;
  const eRaw = raw.end_at ?? _unwrapTime(raw.end) ?? raw.finish ?? raw.endTime;
  const start = toMs(sRaw);
  if (start == null) return null;
  let end = toMs(eRaw);
  if (end == null || end <= start) end = start + 30 * MIN;   // default 30-min block
  const title = String(raw.title || raw.summary || raw.name || raw.subject || '').trim() || '(untitled)';
  const source = raw.source || raw.calendar || null;
  return { start, end, title, source };
}

function normalizeEvents(list) {
  return (Array.isArray(list) ? list : []).map(normalizeEvent).filter(Boolean).sort((a, b) => a.start - b.start);
}

// The next event ending after `fromMs` (ongoing or upcoming), or null.
function nextEvent(events, fromMs) {
  for (const e of normalizeEvents(events)) if (e.end > fromMs) return e;
  return null;
}

// Total BUSY ms in [startMs, endMs], union of overlapping events (no double-count).
function busyMsBetween(events, startMs, endMs) {
  if (!(endMs > startMs)) return 0;
  const ivs = normalizeEvents(events)
    .map(e => [Math.max(e.start, startMs), Math.min(e.end, endMs)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0, curS = null, curE = null;
  for (const [s, e] of ivs) {
    if (curE == null) { curS = s; curE = e; }
    else if (s <= curE) { curE = Math.max(curE, e); }
    else { total += curE - curS; curS = s; curE = e; }
  }
  if (curE != null) total += curE - curS;
  return total;
}

// MEETING-AWARE ETA: when does `workRemainingMs` of effort finish, starting at `nowMs`, if known future
// events block work? Walk forward consuming free gaps, skipping meetings. Returns ms-epoch finish.
// With NO events (the stub) this is exactly nowMs + workRemainingMs (naive ETA) — the graceful default.
function projectETA({ nowMs, workRemainingMs, events = [] } = {}) {
  let t = Number(nowMs) || 0;
  let remaining = Math.max(0, Number(workRemainingMs) || 0);
  if (remaining === 0) return t;
  for (const e of normalizeEvents(events).filter(e => e.end > t)) {
    if (remaining <= 0) break;
    if (e.start <= t) { t = Math.max(t, e.end); continue; }   // inside this meeting → jump past it
    const free = e.start - t;
    if (free >= remaining) return t + remaining;              // finishes before this meeting
    remaining -= free;                                        // consume the gap, skip the meeting
    t = e.end;
  }
  return t + remaining;
}

// --- deadline phrase resolution ---------------------------------------------

function applyMeridiem(h, mer) {
  if (!mer) return h;
  const m = mer.replace(/[.\s]/g, '').toLowerCase();
  if (m === 'pm' && h < 12) return h + 12;
  if (m === 'am' && h === 12) return 0;
  return h;
}
function validHM(h, m) { return h >= 0 && h <= 23 && m >= 0 && m <= 59; }

// Parse a clock time out of free text → { hour, minute } (24h) or null. Heuristic, best-effort.
function parseClock(text) {
  const s = String(text || '').toLowerCase();
  let m;
  if ((m = s.match(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/))) {
    const h = applyMeridiem(+m[1], m[3]), min = +m[2];
    if (validHM(h, min)) return { hour: h, minute: min };
  }
  if ((m = s.match(/\b(\d{3,4})\s*(a\.?m\.?|p\.?m\.?)?(?!\d)/))) {
    const n = m[1], h = applyMeridiem(+n.slice(0, n.length - 2), m[2]), min = +n.slice(-2);
    if (validHM(h, min)) return { hour: h, minute: min };
  }
  if ((m = s.match(/\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/))) {
    const h = applyMeridiem(+m[1], m[2]);
    if (validHM(h, 0)) return { hour: h, minute: 0 };
  }
  return null;
}

// Resolve a deadline phrase to a timestamp, PREFERRING a real calendar event (meeting-anchored) over a
// bare clock time. "for the 1030 meeting" → that event's start; "by 4pm" (no event) → today's 16:00
// (or tomorrow if past). Returns { deadlineMs, basis } or null. With the stub (no events) it still
// resolves bare clock deadlines — only the meeting-anchoring waits on the real calendar.
function resolveDeadline({ text = '', events = [], nowMs } = {}) {
  const now = Number(nowMs) || 0;
  const evs = normalizeEvents(events).filter(e => e.end > now);
  const s = String(text || '').toLowerCase();

  if (/\b(next meeting|before (?:the|my) (?:next )?meeting|before my next|by my next)\b/.test(s) && evs.length) {
    return { deadlineMs: evs[0].start, basis: `event:${evs[0].title}` };
  }
  const clk = parseClock(s);
  if (clk) {
    const atClock = evs.find(e => { const d = new Date(e.start); return d.getHours() === clk.hour && d.getMinutes() === clk.minute; });
    if (atClock) return { deadlineMs: atClock.start, basis: `event:${atClock.title}` };
    const d = new Date(now); d.setHours(clk.hour, clk.minute, 0, 0);
    let target = d.getTime();
    if (target <= now) target += 24 * HOUR;
    const near = evs.find(e => Math.abs(e.start - target) <= 30 * MIN);
    if (near) return { deadlineMs: near.start, basis: `event:${near.title}` };
    return { deadlineMs: target, basis: 'clock' };
  }
  return null;
}

// --- the provider seam (STUBBED until Lucas's Google calendar lands) ---------

// Default provider = STUB: no calendar wired yet, so no events. Lucas's real source registers here.
const STUB = async () => [];
let _provider = STUB;

// Register the real event source. fn({ nowMs, windowMs }) → array of raw events (any reasonable shape;
// normalizeEvent tolerates field/unit variation). Pass null to revert to the stub.
function setProvider(fn) { _provider = (typeof fn === 'function') ? fn : STUB; }
// True once a REAL provider is registered (Lucas's calendar); false while stubbed.
function hasProvider() { return _provider !== STUB; }
function usingStub() { return _provider === STUB; }

// Get normalized upcoming events from whatever provider is registered. Fail-safe: any error / the stub →
// [] (callers degrade to a naive ETA). windowMs default 24h.
async function getUpcoming({ nowMs = 0, windowMs = 24 * HOUR } = {}) {
  try {
    const raw = await _provider({ nowMs, windowMs });
    return normalizeEvents(raw);
  } catch { return []; }
}

// MEETING-AWARE ETA SUFFIX — the spoken circuit for the provider seam (wired 2026-08-15; the seam sat
// dark since 06-30 with zero setProvider callers). Given an estimate in minutes, project the finish
// around known calendar events and return a short sentence to append to a readback — or '' whenever
// the calendar doesn't meaningfully move it (stub, no events, shift < 5 min). Fail-safe: '' on any error.
async function etaSuffix({ nowMs = Date.now(), totalMin = 0 } = {}) {
  try {
    if (!hasProvider() || !(totalMin > 0)) return '';
    const events = await getUpcoming({ nowMs, windowMs: 36 * HOUR });
    if (!events.length) return '';
    const workMs = totalMin * MIN;
    const eta = projectETA({ nowMs, workRemainingMs: workMs, events });
    if (eta - (nowMs + workMs) < 5 * MIN) return '';          // calendar barely moves it → say nothing
    const blocking = events.filter(e => e.end > nowMs && e.start < eta);
    const tz = (() => { try { return require('./tz'); } catch { return null; } })();
    const when = tz ? tz.timeWithZone(new Date(eta))
      : new Date(eta).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const tomorrow = tz && tz.dayKey(eta) !== tz.dayKey(nowMs) ? ' tomorrow' : '';
    const around = blocking.length
      ? ` (working around ${blocking.length === 1 ? `"${blocking[0].title}"` : `${blocking.length} calendar events`})`
      : '';
    return ` With the calendar, that lands around ${when}${tomorrow}${around}.`;
  } catch { return ''; }
}

module.exports = {
  toMs, normalizeEvent, normalizeEvents, nextEvent, busyMsBetween, projectETA,
  parseClock, resolveDeadline, setProvider, hasProvider, usingStub, getUpcoming, etaSuffix, MIN, HOUR
};
