/* scripts/smoke_calendar_view.js — offline checks for the Calendar view-mappers (pure node). */
'use strict';
const V = require('../studio/calendar_view');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

// ---- parseStamp ----
const aday = V.parseStamp({ date: '2026-07-01' });
ok('all-day stamp', aday.allDay === true && aday.date === '2026-07-01' && aday.time === '');
const timed = V.parseStamp({ dateTime: '2026-07-01T14:30:00-05:00', timeZone: 'America/Chicago' });
ok('timed stamp ms is absolute', timed.allDay === false && timed.ms === Date.parse('2026-07-01T14:30:00-05:00') && /^\d\d:\d\d$/.test(timed.time));
ok('null stamp', V.parseStamp(null) === null && V.parseStamp({}) === null);

// ---- meetLinkOf ----
ok('hangoutLink wins', V.meetLinkOf({ hangoutLink: 'https://meet.google.com/abc-defg-hij' }) === 'https://meet.google.com/abc-defg-hij');
ok('conferenceData video entry', V.meetLinkOf({ conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+1' }, { entryPointType: 'video', uri: 'https://meet.google.com/x' }] } }) === 'https://meet.google.com/x');
ok('no meet link', V.meetLinkOf({}) === '');

// ---- normalizeCalendar ----
const cal = V.normalizeCalendar({ id: 'c1', summary: 'Work', backgroundColor: '#123456', accessRole: 'owner', primary: true });
ok('calendar normalized', cal.id === 'c1' && cal.summary === 'Work' && cal.color === '#123456' && cal.primary === true && cal.canWrite === true && cal.selected === true);
ok('reader not writable', V.normalizeCalendar({ id: 'c2', summary: 'Holidays', accessRole: 'reader' }).canWrite === false);
ok('selected false respected', V.normalizeCalendar({ id: 'c3', summary: 'Off', selected: false }).selected === false);
ok('summaryOverride wins', V.normalizeCalendar({ id: 'c4', summary: 'Orig', summaryOverride: 'Renamed' }).summary === 'Renamed');
ok('bad calendar → null', V.normalizeCalendar({}) === null && V.normalizeCalendar(null) === null);

// ---- normalizeCalendarList ordering (primary first, then alpha) ----
const list = V.normalizeCalendarList({ items: [
  { id: 'z', summary: 'Zebra', accessRole: 'owner' },
  { id: 'p', summary: 'Mine', accessRole: 'owner', primary: true },
  { id: 'a', summary: 'Apples', accessRole: 'reader' },
] });
ok('calendar list ordered primary-first then alpha', list.length === 3 && list[0].id === 'p' && list[1].summary === 'Apples' && list[2].summary === 'Zebra');

// ---- normalizeEvent ----
const ev = V.normalizeEvent({
  id: 'e1', summary: 'Sync', status: 'confirmed',
  start: { dateTime: '2026-07-01T09:00:00-05:00' }, end: { dateTime: '2026-07-01T10:00:00-05:00' },
  location: 'Room 4', hangoutLink: 'https://meet.google.com/abc',
  attendees: [{ email: 'a@x.com', responseStatus: 'accepted' }, { email: 'me@x.com', self: true, responseStatus: 'needsAction' }],
  recurringEventId: 'r1', colorId: '5',
}, { calendarId: 'cal-1', calColor: '#abcdef' });
ok('event scalars', ev.id === 'e1' && ev.summary === 'Sync' && ev.calendarId === 'cal-1' && ev.location === 'Room 4');
ok('event meet + flags', ev.hasMeet === true && ev.meetLink === 'https://meet.google.com/abc' && ev.recurring === true && ev.allDay === false);
ok('event color from ctx', ev.color === '#abcdef' && ev.colorId === '5');
ok('event attendees', ev.attendeeCount === 2 && ev.attendees[1].self === true);
ok('timed timeLabel non-empty', typeof ev.timeLabel === 'string' && ev.timeLabel.includes('–'));

// all-day event: end.date is EXCLUSIVE → endDate is the last covered day
const adEv = V.normalizeEvent({ id: 'e2', summary: 'Trip', start: { date: '2026-07-01' }, end: { date: '2026-07-03' } });
ok('all-day flags + exclusive end', adEv.allDay === true && adEv.startDate === '2026-07-01' && adEv.endDate === '2026-07-02' && adEv.timeLabel === 'All day');
const ad1 = V.normalizeEvent({ id: 'e3', summary: 'Holiday', start: { date: '2026-07-04' }, end: { date: '2026-07-05' } });
ok('single all-day: start===end', ad1.startDate === '2026-07-04' && ad1.endDate === '2026-07-04');

ok('no-title fallback', V.normalizeEvent({ id: 'e4', start: { date: '2026-07-01' }, end: { date: '2026-07-02' } }).summary === '(no title)');
ok('bad event → null', V.normalizeEvent({}) === null && V.normalizeEvent(null) === null);

// ---- normalizeEventList: sort asc + drop cancelled ----
const el = V.normalizeEventList({ items: [
  { id: 'b', summary: 'Late', start: { dateTime: '2026-07-01T15:00:00Z' }, end: { dateTime: '2026-07-01T16:00:00Z' } },
  { id: 'x', summary: 'Gone', status: 'cancelled', start: { dateTime: '2026-07-01T08:00:00Z' }, end: { dateTime: '2026-07-01T09:00:00Z' } },
  { id: 'a', summary: 'Early', start: { dateTime: '2026-07-01T09:00:00Z' }, end: { dateTime: '2026-07-01T10:00:00Z' } },
], nextPageToken: 'NPT' }, { calendarId: 'c' });
ok('event list sorted + cancelled dropped', el.events.length === 2 && el.events[0].id === 'a' && el.events[1].id === 'b' && el.nextPageToken === 'NPT');

// ---- colorMap + eventColor ----
const cmap = V.colorMap({ event: { 5: { background: '#ff0000', foreground: '#fff' } }, calendar: {} });
ok('colorMap shape', cmap.event['5'].background === '#ff0000' && typeof cmap.calendar === 'object');
ok('eventColor: event colorId wins', V.eventColor({ colorId: '5', color: '#000' }, cmap) === '#ff0000');
ok('eventColor: falls back to calendar color', V.eventColor({ colorId: '', color: '#abcdef' }, cmap) === '#abcdef');
ok('eventColor: default when nothing', V.eventColor({}, { event: {}, calendar: {} }) === '#6a86b6');

// ---- minutesInDay ----
const tEv = V.normalizeEvent({ id: 't', summary: 'x', start: { dateTime: '2026-07-01T09:00:00Z' }, end: { dateTime: '2026-07-01T10:30:00Z' } });
const dayKey = V.ymd(new Date(tEv.startMs));   // local day the event starts in
const mi = V.minutesInDay(tEv, dayKey);
ok('minutesInDay basic', mi && mi.durMin === 90 && mi.botMin - mi.topMin === 90 && mi.topMin >= 0 && mi.botMin <= 1440);
ok('minutesInDay null for all-day', V.minutesInDay(V.normalizeEvent({ id: 'a', start: { date: '2026-07-01' }, end: { date: '2026-07-02' } }), '2026-07-01') === null);
ok('minutesInDay null off-day', V.minutesInDay(tEv, '2026-07-05') === null);

// ---- packColumns: two overlapping → 2 cols; a disjoint one → its own cluster, 1 col ----
const packed = V.packColumns([
  { id: 'A', topMin: 60, botMin: 120 },
  { id: 'B', topMin: 90, botMin: 150 },   // overlaps A
  { id: 'C', topMin: 200, botMin: 260 },  // disjoint
]);
const byId = Object.fromEntries(packed.map(p => [p.id, p]));
ok('packColumns overlap → 2 cols', byId.A.cols === 2 && byId.B.cols === 2 && byId.A.col !== byId.B.col);
ok('packColumns disjoint → own cluster', byId.C.cols === 1 && byId.C.col === 0);

// ---- layoutDay ----
const ld = V.layoutDay([
  tEv,
  V.normalizeEvent({ id: 'ad', summary: 'Trip', start: { date: dayKey }, end: { date: '2026-07-09' } }),
], dayKey);
ok('layoutDay splits all-day + timed', ld.allDay.length === 1 && ld.timed.length === 1 && ld.timed[0].id === 't');

// ---- weekDays ----
const wd = V.weekDays(new Date('2026-07-01T12:00:00'));
ok('weekDays 7 sunday-first', wd.length === 7 && new Date(wd[0] + 'T00:00:00').getDay() === 0 && wd.includes('2026-07-01'));

// ---- analytics ----
const aEvents = [
  V.normalizeEvent({ id: '1', summary: 'M1', start: { dateTime: '2026-07-01T09:00:00Z' }, end: { dateTime: '2026-07-01T10:00:00Z' }, hangoutLink: 'https://meet.google.com/a' }, { calendarId: 'work', calColor: '#111' }),
  V.normalizeEvent({ id: '2', summary: 'M2', start: { dateTime: '2026-07-01T11:00:00Z' }, end: { dateTime: '2026-07-01T12:30:00Z' }, recurringEventId: 'r' }, { calendarId: 'work', calColor: '#111' }),
  V.normalizeEvent({ id: '3', summary: 'Holiday', start: { date: '2026-07-04' }, end: { date: '2026-07-05' } }, { calendarId: 'hol', calColor: '#222' }),
];
const stats = V.analytics(aEvents, { work: 'Work', hol: 'Holidays' });
ok('analytics totals', stats.total === 3 && stats.timed === 2 && stats.allDay === 1);
ok('analytics hours + avg', stats.totalHours === 2.5 && stats.avgMins === 75);
ok('analytics meet + recurring', stats.withMeet === 1 && stats.recurring === 1);
ok('analytics byCalendar names + sort', stats.byCalendar[0].id === 'work' && stats.byCalendar[0].count === 2 && stats.byCalendar[0].name === 'Work');
ok('analytics busiest day', stats.busiestDay && stats.busiestDay.count === 2);
ok('analytics weekday/hour arrays', stats.byWeekday.length === 7 && stats.byHour.length === 24 && stats.weekdayLabels[0] === 'Sun');
ok('analytics longest', stats.longest && stats.longest.mins === 90);
ok('analytics empty safe', V.analytics([]).total === 0 && V.analytics(null).timed === 0);

// ---- addDaysKey ----
ok('addDaysKey +1', V.addDaysKey('2026-07-01', 1) === '2026-07-02');
ok('addDaysKey month rollover', V.addDaysKey('2026-07-31', 1) === '2026-08-01');

// ---- eventToForm ----
const formE = V.normalizeEvent({ id: 'e', summary: 'Sync', start: { dateTime: '2026-07-01T09:00:00-04:00' }, end: { dateTime: '2026-07-01T10:00:00-04:00' }, location: 'Rm' }, { calendarId: 'c1' });
const f = V.eventToForm(formE);
ok('eventToForm timed', f.id === 'e' && f.calendarId === 'c1' && f.summary === 'Sync' && f.allDay === false && f.startDate === formE.startDate && f.location === 'Rm');
ok('eventToForm no-title → empty', V.eventToForm(V.normalizeEvent({ id: 'x', start: { date: '2026-07-01' }, end: { date: '2026-07-02' } })).summary === '');
ok('eventToForm null safe', V.eventToForm(null) === null);

// ---- toGoogleEvent: timed ----
const gt = V.toGoogleEvent({ summary: 'Call', startDate: '2026-07-01', startTime: '09:30', endDate: '2026-07-01', endTime: '10:15', location: 'Zoom' }, { timeZone: 'America/New_York' });
ok('toGoogleEvent timed shape', gt.start.dateTime === '2026-07-01T09:30:00' && gt.start.timeZone === 'America/New_York' && gt.end.dateTime === '2026-07-01T10:15:00' && gt.summary === 'Call' && gt.location === 'Zoom');
// ---- toGoogleEvent: all-day (end EXCLUSIVE) ----
const ga = V.toGoogleEvent({ summary: 'PTO', allDay: true, startDate: '2026-07-01', endDate: '2026-07-03' });
ok('toGoogleEvent all-day exclusive end', ga.start.date === '2026-07-01' && ga.end.date === '2026-07-04' && !ga.start.dateTime);
const ga1 = V.toGoogleEvent({ summary: '', allDay: true, startDate: '2026-07-04' });
ok('toGoogleEvent single all-day + no-title default', ga1.start.date === '2026-07-04' && ga1.end.date === '2026-07-05' && ga1.summary === '(no title)');
ok('toGoogleEvent requires startDate', (() => { try { V.toGoogleEvent({ summary: 'x' }); return false; } catch { return true; } })());
ok('toGoogleEvent omits empty location/description', (() => { const b = V.toGoogleEvent({ summary: 's', startDate: '2026-07-01', startTime: '08:00', endTime: '09:00' }); return b.location === undefined && b.description === undefined; })());

console.log(`\nsmoke_calendar_view: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
