/* Smoke: lib/calendar — the meeting-aware time math + the STUBBED provider seam. Proves the time build
 * works now without Lucas's real (Google-authed) calendar: stub → naive ETA; inject events → meeting-
 * aware ETA + deadline resolution. Pure, no I/O. TZ-independent (clock phrases derived from fixtures).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_calendar.js
 */
'use strict';
const cal = require('../lib/calendar');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const MIN = cal.MIN, HOUR = cal.HOUR;

// fixed clock for determinism
const now = 1782800000000;          // a fixed ms-epoch
const at = (offH, durMin, title) => ({ start_at: Math.round((now + offH * HOUR) / 1000), end_at: Math.round((now + offH * HOUR + durMin * MIN) / 1000), title }); // unix SECONDS (Echo shape)

// --- normalization: seconds vs ms vs ISO, field tolerance ---
ok(cal.normalizeEvent({ start_at: 1782800000, end_at: 1782803600, title: 'X' }).start === 1782800000000, 'unix seconds → ms');
ok(cal.normalizeEvent({ start: now, end: now + HOUR, summary: 'Y' }).title === 'Y', 'ms + summary field tolerated');
ok(cal.normalizeEvent({ start: '2026-06-30T15:00:00Z' }).end > cal.normalizeEvent({ start: '2026-06-30T15:00:00Z' }).start, 'ISO start, default 30-min end');
ok(cal.normalizeEvent({ title: 'no start' }) === null, 'no start → null (dropped)');
// GOOGLE OBJECT SHAPE (2026-08-15 fix): {start:{dateTime}} used to stop the ?? chain at the truthy
// object → toMs(object) → null → every real Google event silently dropped. Now unwrapped.
const g = cal.normalizeEvent({ start: { dateTime: '2026-06-30T15:00:00Z' }, end: { dateTime: '2026-06-30T16:00:00Z' }, summary: 'G' });
ok(g && g.title === 'G' && g.end - g.start === HOUR, 'Google {start:{dateTime}} object shape parsed (was silently dropped)');
ok(cal.normalizeEvent({ start: { date: '2026-06-30' } }) !== null, 'Google all-day {start:{date}} tolerated (the live provider filters all-day out)');
ok(cal.normalizeEvents([{ start_at: 1782803600 }, { start_at: 1782800000 }]).map(e => e.start)[0] === 1782800000000, 'normalizeEvents sorts by start');

// --- projectETA: naive (stub, no events) vs meeting-aware ---
ok(cal.projectETA({ nowMs: now, workRemainingMs: 2 * HOUR, events: [] }) === now + 2 * HOUR, 'NO events → naive ETA (now + work) — the stub default');
// a 1h meeting starting 1h from now; 2h of work → work runs 0-1h, pauses for the meeting (1h), resumes → ends at now+3h
ok(cal.projectETA({ nowMs: now, workRemainingMs: 2 * HOUR, events: [at(1, 60, 'standup')] }) === now + 3 * HOUR, 'meeting in the window pushes ETA past it (2h work + 1h meeting = 3h wall)');
// work finishes before the meeting → meeting irrelevant
ok(cal.projectETA({ nowMs: now, workRemainingMs: 30 * MIN, events: [at(2, 60, 'later')] }) === now + 30 * MIN, 'work that finishes before the meeting → meeting does not affect ETA');
// work spanning TWO meetings: 2.5h work + 1h meeting (1-2h) + 0.5h meeting (3-3.5h) = 4h wall
ok(cal.projectETA({ nowMs: now, workRemainingMs: 150 * MIN, events: [at(1, 60, 'a'), at(3, 30, 'b')] }) === now + 4 * HOUR, 'work spanning two meetings skips both (2.5h work + 1.5h meetings = 4h wall)');
// the same two meetings but only 90 min work → finishes (2.5h) BEFORE the second meeting, which is ignored
ok(cal.projectETA({ nowMs: now, workRemainingMs: 90 * MIN, events: [at(1, 60, 'a'), at(3, 30, 'b')] }) === now + 2.5 * HOUR, 'work that ends before the 2nd meeting ignores it');
ok(cal.projectETA({ nowMs: now, workRemainingMs: 0, events: [at(1, 60, 'x')] }) === now, 'zero work remaining → ETA is now');

// --- busyMsBetween: union, no double-count ---
ok(cal.busyMsBetween([at(1, 60, 'a'), at(1.5, 60, 'b')], now, now + 4 * HOUR) === 90 * MIN, 'overlapping meetings unioned (90 min, not 120)');
ok(cal.busyMsBetween([], now, now + HOUR) === 0, 'no events → 0 busy');

// --- resolveDeadline: meeting-anchored (TZ-independent via fixture-derived clock) ---
const ev = cal.normalizeEvent(at(1, 30, 'Strategy sync'));   // an event 1h out
const d = new Date(ev.start);
const hh = d.getHours(), mm = d.getMinutes();
const clockStr = `${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}`;   // e.g. "1030"
const rd = cal.resolveDeadline({ text: `something for the ${clockStr} meeting`, events: [ev], nowMs: now });
ok(rd && rd.deadlineMs === ev.start && /^event:/.test(rd.basis), '"for the <clock> meeting" anchors to the real event start');
const rn = cal.resolveDeadline({ text: 'have it before my next meeting', events: [ev], nowMs: now });
ok(rn && rn.deadlineMs === ev.start, '"before my next meeting" → next event start');
// bare clock, no events → clock basis, future, correct local hour
const rc = cal.resolveDeadline({ text: 'get it to me by 4pm', events: [], nowMs: now });
ok(rc && rc.basis === 'clock' && new Date(rc.deadlineMs).getHours() === 16 && rc.deadlineMs > now, '"by 4pm" with no calendar → clock deadline at local 16:00, in the future');
ok(cal.resolveDeadline({ text: 'no time mentioned here', events: [], nowMs: now }) === null, 'no time phrase → null');

// --- parseClock forms ---
ok(cal.parseClock('1030').hour === 10 && cal.parseClock('1030').minute === 30, '"1030" → 10:30');
ok(cal.parseClock('4pm').hour === 16, '"4pm" → 16:00');
ok(cal.parseClock('10:30 am').hour === 10, '"10:30 am" → 10:30');
ok(cal.parseClock('16:45').hour === 16 && cal.parseClock('16:45').minute === 45, '"16:45" → 16:45');
ok(cal.parseClock('sometime later') === null, 'no clock → null');

// --- the provider seam: stub by default, swappable, fail-safe ---
(async () => {
  ok(cal.usingStub() === true && cal.hasProvider() === false, 'defaults to the STUB provider (no calendar yet)');
  ok((await cal.getUpcoming({ nowMs: now })).length === 0, 'stub getUpcoming → [] (naive-ETA path)');
  cal.setProvider(async () => [at(1, 60, 'injected')]);
  ok(cal.hasProvider() === true && cal.usingStub() === false, 'setProvider registers a real source');
  const got = await cal.getUpcoming({ nowMs: now });
  ok(got.length === 1 && got[0].title === 'injected', 'registered provider events flow through normalized');
  cal.setProvider(async () => { throw new Error('boom'); });
  ok((await cal.getUpcoming({ nowMs: now })).length === 0, 'a throwing provider → [] (fail-safe, no crash)');
  cal.setProvider(null);
  ok(cal.usingStub() === true, 'setProvider(null) reverts to the stub');

  // --- etaSuffix: the SPOKEN circuit for the provider seam (2026-08-15 wire) ---
  ok((await cal.etaSuffix({ nowMs: now, totalMin: 120 })) === '', 'etaSuffix: stub provider → empty (naive readback stands alone)');
  cal.setProvider(() => [at(1, 60, 'Standup')]);   // SYNC provider — the live wire serves a cache synchronously
  const sfx = await cal.etaSuffix({ nowMs: now, totalMin: 120 });
  ok(/lands around .+/.test(sfx) && sfx.includes('Standup'), `etaSuffix: meeting pushes the ETA → speaks the landing time + names the event (${JSON.stringify(sfx)})`);
  ok((await cal.etaSuffix({ nowMs: now, totalMin: 30 })) === '', 'etaSuffix: work that finishes before the meeting → empty (calendar does not move it)');
  ok((await cal.etaSuffix({ nowMs: now, totalMin: 0 })) === '', 'etaSuffix: zero work → empty');
  cal.setProvider(async () => { throw new Error('boom'); });
  ok((await cal.etaSuffix({ nowMs: now, totalMin: 120 })) === '', 'etaSuffix: throwing provider → empty (fail-safe)');
  cal.setProvider(null);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
