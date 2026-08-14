/* Smoke: lib/voice_guard — the meeting/phone mic guard (queue #6, 2026-08-14). While Lucas is in a
 * meeting/call (or Zoe is in one herself) the always-on mic must not capture the room and she must not
 * speak aloud. Tests the createGuard state machine with injected detectors (priority, transitions,
 * manual override, fail-soft) + isCalendarBusy's event filtering with a stub gcal. detectMeetingApp is
 * exercised only for shape (it sniffs real windows — nondeterministic by design).
 * Run: node scripts/smoke_voice_guard.js */
'use strict';
const vg = require('../lib/voice_guard');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  console.log('A) createGuard — detection priority + transitions');
  let self = null, app = null, cal = null;
  const changes = [];
  const g = vg.createGuard({
    selfMeeting: () => self,
    detectApp: async () => app,
    calendarBusy: async () => cal,
    onChange: (s) => changes.push(`${s.paused ? 'pause' : 'resume'}:${s.reason}`),
  });
  ok(!g.state().paused && g.state().mode === 'auto', 'starts unpaused in auto');
  await g.evaluate();
  ok(!g.state().paused && changes.length === 0, 'all clear → stays unpaused, no transition fired');

  app = 'Zoom';
  await g.evaluate();
  ok(g.state().paused && /meeting app \(Zoom\)/.test(g.state().reason), 'meeting app → paused with reason');
  ok(changes.length === 1, 'transition fired exactly once');
  await g.evaluate();
  ok(changes.length === 1, 'same state re-evaluated → NO duplicate transition (no log spam)');

  self = 'Meet';
  await g.evaluate();
  ok(/her meeting \(Meet\)/.test(g.state().reason), 'her OWN meeting outranks the app window');

  self = null; app = null; cal = 'Standup w/ parish team';
  await g.evaluate();
  ok(g.state().paused && /calendar \(Standup/.test(g.state().reason), 'calendar-busy → paused');

  cal = null;
  await g.evaluate();
  ok(!g.state().paused, 'all detectors clear → resumed');

  console.log('B) manual override — the reliable backstop');
  const r1 = g.manual('pause');
  ok(r1.paused && r1.mode === 'manual', 'manual pause → paused immediately');
  app = null; self = null; cal = null;
  await g.evaluate();
  ok(g.state().paused, 'clear detection does NOT unpause a manual pause');
  const r2 = g.manual('resume');
  ok(!r2.paused && r2.mode === 'manual', 'manual resume → unpaused');
  app = 'Teams call';
  await g.evaluate();
  ok(!g.state().paused, 'busy detection does NOT re-pause a manual resume');
  g.manual('auto');
  await g.evaluate();
  ok(g.state().paused && /Teams/.test(g.state().reason), "'auto' hands control back → detection pauses again");

  console.log('C) fail-soft — a throwing detector keeps the PRIOR state');
  const g2 = vg.createGuard({ selfMeeting: () => { throw new Error('boom'); }, detectApp: async () => 'X', calendarBusy: null });
  await g2.evaluate();
  ok(!g2.state().paused, 'detector throw → prior (unpaused) state kept, no crash');

  console.log('D) isCalendarBusy — event filtering (stub gcal)');
  const now = Date.now();
  const mk = (over) => ({ status: 'confirmed', start: { dateTime: new Date(now - 5 * 60000).toISOString() }, end: { dateTime: new Date(now + 25 * 60000).toISOString() }, summary: 'Live mtg', ...over });
  const stub = (items, connected = true) => ({ isConnected: () => connected, listEvents: async () => ({ items }) });
  ok(await vg.isCalendarBusy(stub([mk({})])) === 'Live mtg', 'a live busy event → its summary');
  ok(await vg.isCalendarBusy(stub([mk({ transparency: 'transparent' })])) === false, '"free" event → not busy');
  ok(await vg.isCalendarBusy(stub([mk({ start: { date: '2026-08-14' } })])) === false, 'all-day event → not busy');
  ok(await vg.isCalendarBusy(stub([mk({ status: 'cancelled' })])) === false, 'cancelled → not busy');
  ok(await vg.isCalendarBusy(stub([mk({ attendees: [{ self: true, responseStatus: 'declined' }] })])) === false, 'he declined → not busy');
  ok(await vg.isCalendarBusy(stub([mk({ start: { dateTime: new Date(now + 30 * 60000).toISOString() } })])) === false, 'future event → not busy now');
  ok(await vg.isCalendarBusy(stub([], false)) === null, 'not connected → null (cannot tell)');
  ok(await vg.isCalendarBusy(null) === null, 'no gcal at all → null');

  console.log('E) detectMeetingApp — shape only (sniffs real windows)');
  const d = await vg.detectMeetingApp();
  ok(d === null || typeof d === 'string', `resolves to string|null without throwing (got: ${JSON.stringify(d)})`);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
