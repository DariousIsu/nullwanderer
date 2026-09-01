/* Smoke: lib/scheduler parseWhen — durations, ISO dates, and CLOCK TIMES (the 09-01 defect:
 * Lucas said "at 1330", her reply said "reminder set for 13:30", and the booked row fired at
 * 11:48 because parseWhen understood neither "1330" nor any clock form; Date.parse would even
 * read "1330" as the YEAR 1330. The say is the contract — the machinery must book what was said.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_scheduler.js
 */
'use strict';
const sch = require('../lib/scheduler');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// a fixed "now": today at 10:00 local (built from the real clock so local-tz math stays honest)
const base = new Date(); base.setHours(10, 0, 0, 0);
const T = base.getTime();
const MIN = 60e3, H = 3600e3;
const at = (h, m, dayOffset = 0) => { const d = new Date(T); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.getTime(); };

// durations (the existing contract, now with injectable now)
ok(sch.parseWhen('in 30m', T) === T + 30 * MIN, 'duration: "in 30m"');
ok(sch.parseWhen('45m', T) === T + 45 * MIN, 'duration: bare "45m"');
ok(sch.parseWhen('2h', T) === T + 2 * H, 'duration: "2h"');

// clock times — the 09-01 cure
ok(sch.parseWhen('13:30', T) === at(13, 30), '⭐ clock: "13:30" → today 13:30 (now=10:00)');
ok(sch.parseWhen('at 1330', T) === at(13, 30), '⭐ clock: "at 1330" (military, the live bug) → today 13:30');
ok(sch.parseWhen('0930', T + 4 * H) === at(9, 30, 1), 'clock: "0930" when now=14:00 → TOMORROW 09:30 (a stated time means the next occurrence)');
ok(sch.parseWhen('1:30pm', T) === at(13, 30), 'clock: "1:30pm" → 13:30');
ok(sch.parseWhen('12:15am', T) === at(0, 15, 1), 'clock: "12:15am" (midnight-hour) → next 00:15');
ok(sch.parseWhen('12:15pm', T) === at(12, 15), 'clock: "12:15pm" (noon-hour) → 12:15');
{
  const r = sch.parseWhen('1330', T);
  ok(r === at(13, 30) && r > T, '⭐ "1330" is NEVER the year 1330 — it is today at 13:30, in the future');
}
ok(sch.parseWhen('25:99', T) === null, 'a nonsense clock ("25:99") refuses (no silent mis-book)');

// ISO fallback intact
ok(sch.parseWhen('2030-01-02T03:04:05Z', T) === Date.parse('2030-01-02T03:04:05Z'), 'ISO absolute still parses');
ok(sch.parseWhen('', T) === null && sch.parseWhen(null, T) === null, 'empty/null → null');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
