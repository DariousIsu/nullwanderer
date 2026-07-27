/* Smoke: meeting-prep GROUNDING (week_context) — kills the confabulated-attendee-profile class.
 *
 * The Laila Pirnazar miss: the autonomy lane invented a full profile (planted her at the Rainey Center,
 * fake POLITICO briefing, fake URL) for a meeting attendee we hold NOTHING on. Now each UPCOMING attendee
 * carries a HELD tag: [held: …] when we have them, [NOT IN OUR RECORDS] when we don't (an explicit licence
 * to research, never to assert) — plus a hard grounding rule that travels into the autonomy manifest.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_meeting_grounding.js
 */
'use strict';
const wc = require('../lib/week_context');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const NOW = 1785000000000;
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const upcoming = { status: 'confirmed', summary: 'Meeting w/ Laila',
  start: { dateTime: iso(NOW + DAY) }, end: { dateTime: iso(NOW + DAY + 3600000) },
  attendees: [{ displayName: 'Laila Pirnazar' }] };
const pastEv = { status: 'confirmed', summary: 'Old sync',
  start: { dateTime: iso(NOW - 2 * DAY) }, end: { dateTime: iso(NOW - 2 * DAY + 3600000) },
  attendees: [{ displayName: 'Bob Jones' }] };

// 1. Attendee we hold NOTHING on → explicit NOT IN OUR RECORDS (no room to invent).
const held0 = wc.formatWeek([upcoming], { now: NOW, heldLookup: () => null });
ok(/Laila Pirnazar \[NOT IN OUR RECORDS/.test(held0.lines), 'unheld attendee → [NOT IN OUR RECORDS]');
ok(/⚠️ GROUNDING/.test(held0.lines), 'hard grounding rule rides in the manifest lines (not just chat text)');
ok(/do NOT invent an employer, role, publication, or link/.test(held0.lines), 'rule forbids inventing org/role/publication/link');

// 2. Attendee we DO hold → their held facts surface (a legit briefing is still allowed).
const held1 = wc.formatWeek([upcoming], { now: NOW, heldLookup: () => 'Comms Dir, House — crm' });
ok(/Laila Pirnazar \[held: Comms Dir, House — crm\]/.test(held1.lines), 'held attendee → [held: …] with real facts');
ok(!/Laila Pirnazar \[NOT IN OUR RECORDS/.test(held1.lines), 'held attendee is not flagged unheld');

// 3. No lookup wired → UNVERIFIED (still forbids assertion — safe default).
const nolook = wc.formatWeek([upcoming], { now: NOW });
ok(/Laila Pirnazar \[unverified/.test(nolook.lines), 'no lookup → [unverified] (assertion still forbidden)');

// 4. PAST attendees are plain (no tag, no grounding rule — the risk is only forward-looking).
const pastOnly = wc.formatWeek([pastEv], { now: NOW, heldLookup: () => null });
ok(/with Bob Jones\b/.test(pastOnly.lines) && !/\[NOT IN OUR RECORDS|\[held:|\[unverified/.test(pastOnly.lines), 'past attendees stay plain');
ok(!/⚠️ GROUNDING/.test(pastOnly.lines), 'no grounding rule when there are no upcoming attendees');

// 5. The chat text carries the "never a bio to invent" nudge.
ok(/never a bio to invent/.test(held0.text), 'chat text nudge present');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
