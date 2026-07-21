/**
 * lib/tz.js — ONE clock, and it is Eastern.
 *
 * Lucas, 2026-07-21: "I would prefer all time to be kept in eastern standard so that calendars and
 * meetings and conversation actually make sense to the model."
 *
 * ⚠️ EASTERN, NOT "EST". He said Eastern Standard; the zone we actually want is America/New_York,
 * which is EST in winter and EDT in summer. His own calendar events carry -04:00 — pinning a fixed
 * UTC-5 would put every summer meeting an hour off, so "the 10:45 all-hands" would read as 9:45 for
 * seven months of the year. The zone name gets this right by construction and the label (EST/EDT)
 * is derived, never assumed.
 *
 * WHY IT MATTERS BEYOND TIDINESS. Everything downstream reasons on these strings: the awareness
 * block tells her what time it is, meetings are matched to calendar entries by day and hour, and a
 * document is dated. All of it used `toLocaleString(undefined, …)` — the HOST's zone, implicit and
 * invisible. That is correct only by luck, and it already produced one visible bug: a date parsed as
 * UTC midnight rendered as the previous day.
 *
 * Storage is unchanged and stays epoch-ms UTC. This module is about DISPLAY and REASONING — the
 * moment a timestamp becomes words a human or a model reads.
 *
 * ZOE_TZ overrides the zone for anyone running elsewhere; an invalid value falls back rather than
 * throwing, because a bad env var must not take the app down.
 */
'use strict';

const DEFAULT_ZONE = 'America/New_York';

let _zone = null;
function zone() {
  if (_zone) return _zone;
  const want = String(process.env.ZOE_TZ || DEFAULT_ZONE).trim() || DEFAULT_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: want }).format(new Date());
    _zone = want;
  } catch {
    console.error(`[tz] invalid ZOE_TZ "${want}" — falling back to ${DEFAULT_ZONE}`);
    _zone = DEFAULT_ZONE;
  }
  return _zone;
}
function _reset() { _zone = null; }   // tests only

function _fmt(opts) { return new Intl.DateTimeFormat('en-US', { timeZone: zone(), ...opts }); }
const _ms = (t) => (t == null ? Date.now() : (t instanceof Date ? t.getTime() : Number(t)));
function _valid(t) { const n = _ms(t); return Number.isFinite(n) ? new Date(n) : null; }

/** "EDT" / "EST" — DERIVED from the date, never hardcoded. */
function label(t) {
  const d = _valid(t); if (!d) return '';
  const p = _fmt({ timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName');
  return p ? p.value : '';
}

/** "Monday, July 21, 2026" */
function date(t) {
  const d = _valid(t); if (!d) return '';
  return _fmt({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(d);
}
/** "July 21, 2026" — no weekday, for document mastheads. */
function dateShort(t) {
  const d = _valid(t); if (!d) return '';
  return _fmt({ year: 'numeric', month: 'long', day: 'numeric' }).format(d);
}
/** "10:45 AM" */
function time(t) {
  const d = _valid(t); if (!d) return '';
  return _fmt({ hour: 'numeric', minute: '2-digit' }).format(d);
}
/** "10:45 AM EDT" — the form to use whenever the zone could be ambiguous to a reader. */
function timeWithZone(t) {
  const d = _valid(t); if (!d) return '';
  return `${time(d)} ${label(d)}`.trim();
}
/** "Mon, Jul 21, 10:45 AM" — compact, for logs and lists. */
function short(t) {
  const d = _valid(t); if (!d) return '';
  return _fmt({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}
/**
 * "2026-07-21" IN EASTERN — the key to group things by DAY.
 *
 * This is the one that silently breaks elsewhere: `toISOString().slice(0,10)` is UTC, so anything
 * after 8pm Eastern lands on tomorrow's date. A meeting at 9pm would be filed on the wrong day and a
 * recurring series would look like it met twice.
 */
function dayKey(t) {
  const d = _valid(t); if (!d) return '';
  const p = _fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (k) => (p.find((x) => x.type === k) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
/** 0=Sunday … 6=Saturday, in Eastern — for "which weekday does this meeting recur on". */
function weekday(t) {
  const d = _valid(t); if (!d) return null;
  const nameToIdx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const p = _fmt({ weekday: 'short' }).formatToParts(d).find((x) => x.type === 'weekday');
  return p ? (nameToIdx[p.value] ?? null) : null;
}

module.exports = { zone, label, date, dateShort, time, timeWithZone, short, dayKey, weekday, DEFAULT_ZONE, _reset };
