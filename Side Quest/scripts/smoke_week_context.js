/* Smoke: HIS WEEK calendar context (lib/week_context). Deterministic: fixture events + injected
 * gcal. No network/model/db.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_week_context.js
 */
'use strict';
const wk = require('../lib/week_context');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // NOW = Tue Jul 22 2026 16:00 EDT (20:00Z)
  const NOW = Date.parse('2026-07-22T20:00:00Z');
  const items = [
    { summary: 'Policy roundtable', status: 'confirmed', location: 'Washington, DC',
      start: { dateTime: '2026-07-15T10:00:00-04:00' }, end: { dateTime: '2026-07-15T12:00:00-04:00' },
      attendees: [
        { email: 'lucas@x.org', self: true, responseStatus: 'accepted' },
        { displayName: 'Sarah Hunt', email: 'sh@x.org', responseStatus: 'accepted' },
        { email: 'j.alvarez@y.gov', responseStatus: 'accepted' },
        { displayName: 'Declined Guy', email: 'd@x.org', responseStatus: 'declined' },
        { displayName: 'Room 4', email: 'room@x.org', resource: true },
      ] },
    { summary: 'Bloomberg Government sync', status: 'confirmed',
      conferenceData: { conferenceSolution: { name: 'Microsoft Teams' } },
      start: { dateTime: '2026-07-24T14:00:00-04:00' }, end: { dateTime: '2026-07-24T15:00:00-04:00' },
      attendees: [
        { email: 'lucas@x.org', self: true },
        { displayName: 'Ana Cruz', email: 'ac@bgov.com' }, { email: 'b.lee@bgov.com' },
        { email: 'c1@bgov.com' }, { email: 'c2@bgov.com' }, { email: 'c3@bgov.com' },
        { email: 'c4@bgov.com' }, { email: 'c5@bgov.com' },
      ] },
    { summary: 'Ghost', status: 'cancelled', start: { dateTime: '2026-07-23T10:00:00-04:00' }, end: { dateTime: '2026-07-23T11:00:00-04:00' } },
    { summary: 'Conference day', status: 'confirmed', start: { date: '2026-07-27' }, end: { date: '2026-07-28' } },
  ];

  // --- pure formatting ---
  const f = wk.formatWeek(items, { now: NOW });
  ok(/Past: .*Jul 15.*"Policy roundtable"/.test(f.lines), 'past DC meeting renders as Past with its date');
  ok(/Washington, DC/.test(f.lines), 'physical location carried');
  ok(/with Sarah Hunt, j\.alvarez/.test(f.lines), 'attendees named (displayName, else email local-part)');
  ok(!/Declined Guy/.test(f.lines) && !/Room 4/.test(f.lines) && !/lucas/.test(f.lines), 'self, declined, and rooms are not people');
  ok(/Coming: .*Jul 24.*2:00.*"Bloomberg Government sync" \(Microsoft Teams\)/.test(f.lines), 'upcoming Teams call renders Eastern with venue');
  ok(/\(\+1 more\)/.test(f.lines), 'attendee overflow is counted, not dropped (7 people → 6 shown +1)');
  ok(!/Ghost/.test(f.lines), 'cancelled events are skipped');
  ok(/Coming: .*Jul 27.*"Conference day"/.test(f.lines) && !/\d{1,2}:\d{2}/.test(f.lines.split('\n').find((l) => l.includes('Conference day')) || ''), 'all-day event keeps its CALENDAR date (no UTC-midnight previous-day shift) and has no time');
  ok(/connect to them naturally/i.test(f.text) && !/connect to them naturally/i.test(f.lines), 'guidance rides in text (chat), never in lines (manifest)');
  ok(wk.formatWeek([], { now: NOW }).text === '', 'no events → empty block');

  // --- refresh: injected gcal, TTL, single source of truth ---
  wk._resetCache();
  let calls = 0;
  const gcalFake = { isConnected: () => true, listEvents: async () => { calls++; return { items }; } };
  await wk.refresh({ deps: { gcal: gcalFake }, now: NOW });
  ok(calls === 1 && /Bloomberg Government sync/.test(wk.cached().text), 'refresh populates the cache from the calendar');
  await wk.refresh({ deps: { gcal: gcalFake }, now: NOW + 60e3 });
  ok(calls === 1, 'a fresh cache is NOT re-fetched (TTL)');
  await wk.refresh({ deps: { gcal: gcalFake }, now: NOW + 60e3, force: true });
  ok(calls === 2, 'force refresh re-fetches');
  wk._resetCache();
  await wk.refresh({ deps: { gcal: { isConnected: () => false, listEvents: async () => { throw new Error('no'); } } }, now: NOW });
  ok(wk.cached().text === '', 'not connected → empty block, no throw (cold-start race self-heals on TTL)');

  // --- the autonomy manifest carries the week (facts only) ---
  const auto = require('../lib/autonomy');
  const Database = require('better-sqlite3');
  const mem = new Database(':memory:');
  const man = auto.buildManifest({ db: { getDb: () => mem }, now: NOW, deps: { weekContext: { cached: () => ({ lines: f.lines, text: f.text, at: NOW }) } } });
  ok(/HIS CALENDAR THIS WEEK/.test(man.text) && /Bloomberg Government sync/.test(man.text), 'autonomy manifest carries the calendar facts');
  ok(!/connect to them naturally/i.test(man.text), 'chat-voice guidance stays OUT of the manifest');

  // --- schedule-question detection + calendar grounding (the BGov homecoming, 2026-07-24) ---
  const sq = wk.isScheduleQuestion;
  ok(sq('when is the BGov meeting today?'), 'schedule: "when is the BGov meeting today?" (the live miss)');
  ok(sq("what's on my calendar today?"), 'schedule: what\'s on my calendar');
  ok(sq('when is my next meeting?'), 'schedule: my next meeting');
  ok(sq('what time is the standup?'), 'schedule: what time is the standup');
  ok(sq('do I have any meetings this week?'), 'schedule: do I have meetings this week');
  ok(sq('am I free at 3?'), 'schedule: am I free');
  ok(sq('when is my call with the Bloomberg team?'), 'schedule: my call with the Bloomberg team');
  ok(!sq('when did the Civil War start?'), 'NOT schedule: general history "when did X start"');
  ok(!sq('when is the next US election?'), 'NOT schedule: current-events, no my/meeting/calendar anchor');
  ok(!sq('what is photosynthesis?'), 'NOT schedule: general knowledge');
  ok(!sq('good morning'), 'NOT schedule: greeting');

  // grounding pulls the held HIS WEEK lines (fresh cache from gcalFake → no refetch)
  wk._resetCache();
  await wk.refresh({ deps: { gcal: gcalFake }, now: NOW });
  const grd = await wk.scheduleGrounding({ gcalOpts: {}, now: NOW });
  ok(/Bloomberg Government sync/.test(grd) && /authoritative source/i.test(grd), 'scheduleGrounding hands the held calendar lines as authoritative grounding');
  ok(!/connect to them naturally/i.test(grd), 'schedule grounding carries FACTS (lines), not the chat-voice guidance');
  // empty calendar → '' (caller degrades to normal grounding), no throw
  wk._resetCache();
  const grd0 = await wk.scheduleGrounding({ gcalOpts: {}, now: NOW, deps: { gcal: { isConnected: () => true, listEvents: async () => ({ items: [] }) } } });
  ok(grd0 === '', 'no events → scheduleGrounding returns empty, never a broken block');

  // factualGrounding threads the calendar source through, first
  const ad = require('../lib/answer_draft');
  const fg = ad.factualGrounding({ knowledgeBlock: 'some entity note that is definitely long enough to pass the floor', calendar: grd });
  ok(fg.indexOf('Bloomberg Government sync') > -1 && fg.indexOf('authoritative source') > -1, 'factualGrounding includes the calendar source');
  ok(fg.indexOf('authoritative') < fg.indexOf('some entity note'), 'calendar leads the grounding (prioritized over the knowledge block)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
