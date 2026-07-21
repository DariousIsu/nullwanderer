/* smoke_tz.js — one clock, and it is Eastern.
 *
 * Lucas, 2026-07-21: "I would prefer all time to be kept in eastern standard so that calendars and
 * meetings and conversation actually make sense to the model."
 *
 * ⚠️ EASTERN, NOT A FIXED "EST". He said Eastern Standard; the zone that makes his calendar work is
 * America/New_York — EST in winter, EDT in summer. His own events carry -04:00. A hardcoded UTC-5
 * would put the 10:45 all-hands at 9:45 for seven months of the year, so the DST tests below are the
 * load-bearing ones.
 *
 * The other load-bearing test is the DAY BOUNDARY. `toISOString().slice(0,10)` is UTC and rolls over
 * at 8pm Eastern, so an evening meeting was filed under TOMORROW — which split one session in two
 * and made a weekly series look like it met on two different weekdays. lib/references groups
 * meeting sessions by exactly that key.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const tz = require('../lib/tz');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const SUMMER = Date.parse('2026-07-21T14:45:00Z');    // 10:45 EDT, a Tuesday
const WINTER = Date.parse('2026-01-15T15:30:00Z');    // 10:30 EST, a Thursday
const EVENING = Date.parse('2026-07-22T01:30:00Z');   // 9:30pm Tue 21 Eastern — but the 22nd in UTC

// ── ⭐ DST is handled, not assumed ──────────────────────────────────────────────────────────────
{
  ok(tz.zone() === 'America/New_York', 'the zone is the NAME, so DST is handled by construction');
  ok(tz.label(SUMMER) === 'EDT', 'summer is EDT');
  ok(tz.label(WINTER) === 'EST', 'winter is EST');
  ok(/10:45 AM/.test(tz.time(SUMMER)), 'SAFETY: a summer 14:45Z meeting reads 10:45 — a fixed UTC-5 would say 9:45');
  ok(/10:30 AM/.test(tz.time(WINTER)), 'and a winter 15:30Z meeting reads 10:30');
  ok(tz.timeWithZone(SUMMER) === '10:45 AM EDT', 'the zone label rides along so an hour is never ambiguous');

  // Strip comments before checking — the file DISCUSSES the fixed-offset trap at length, and an
  // assertion that reads prose is testing the documentation, not the code.
  const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tz.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  ok(!/UTC-5|-05:00|GMT[+-]\d/.test(code), 'SAFETY: no fixed offset literal in the code');
  ok(!/5\s*\*\s*60\s*\*\s*60|18000000|-300\b/.test(code), 'SAFETY: and no offset arithmetic — the zone NAME does the work');
}

// ── ⭐ the day boundary is Eastern, not UTC ─────────────────────────────────────────────────────
{
  ok(new Date(EVENING).toISOString().slice(0, 10) === '2026-07-22', 'the raw UTC date of a 9:30pm meeting is the NEXT day');
  ok(tz.dayKey(EVENING) === '2026-07-21', 'SAFETY: dayKey puts it on the day it actually happened');
  ok(tz.dayKey(SUMMER) === '2026-07-21', 'a daytime meeting is unaffected');
  ok(tz.weekday(SUMMER) === 2, 'weekday is Tuesday (2) — the Rainey Huddle\'s real day');
  ok(tz.weekday(EVENING) === 2, 'SAFETY: the evening meeting is still TUESDAY, not Wednesday');
}

// ── formatting ──────────────────────────────────────────────────────────────────────────────────
{
  ok(tz.date(SUMMER) === 'Tuesday, July 21, 2026', 'full date carries the weekday');
  ok(tz.dateShort(SUMMER) === 'July 21, 2026', 'the document form drops it');
  ok(/Tue, Jul 21/.test(tz.short(SUMMER)), 'the compact form is for logs and lists');
}

// ── junk in never throws ────────────────────────────────────────────────────────────────────────
{
  for (const bad of ['nonsense', NaN, undefined, {}, -Infinity]) {
    ok(typeof tz.date(bad) === 'string', `date(${String(bad)}) returns a string`);
    ok(typeof tz.dayKey(bad) === 'string', `dayKey(${String(bad)}) returns a string`);
  }
  ok(tz.date('nonsense') === '', 'an unparseable time renders EMPTY rather than a wrong date');
  ok(tz.weekday('nonsense') === null, 'and weekday says null rather than guessing a day');
  ok(tz.time(null) !== '', 'null means NOW — the common case for "what time is it"');
}

// ── a bad ZOE_TZ must not take the app down ─────────────────────────────────────────────────────
{
  const prev = process.env.ZOE_TZ;
  process.env.ZOE_TZ = 'Not/AZone';
  tz._reset();
  ok(tz.zone() === tz.DEFAULT_ZONE, 'SAFETY: an invalid ZOE_TZ falls back to Eastern instead of throwing');
  process.env.ZOE_TZ = 'Europe/London';
  tz._reset();
  ok(tz.zone() === 'Europe/London', 'a valid override is honoured — this is a preference, not a law of physics');
  if (prev === undefined) delete process.env.ZOE_TZ; else process.env.ZOE_TZ = prev;
  tz._reset();
  ok(tz.zone() === 'America/New_York', 'and it resets');
}

// ── the wiring ──────────────────────────────────────────────────────────────────────────────────
{
  const ctx = fs.readFileSync(path.join(__dirname, '..', 'lib', 'context.js'), 'utf8');
  ok(/_tz \? _tz\.timeWithZone\(now\)/.test(ctx), 'the awareness clock she reasons from is Eastern');
  ok(/_tz \? _tz\.date\(now\)/.test(ctx), 'and so is the date');
  ok(/catch \{ return null; \}/.test(ctx), 'SAFETY: it degrades to the old behaviour rather than breaking the prompt');

  const refs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'references.js'), 'utf8');
  ok(/require\('\.\/tz'\)\.dayKey\(r\.ts\)/.test(refs), 'meeting sessions group on the EASTERN day');
  ok(!/toISOString\(\)\.slice\(0, 10\)/.test(refs), 'REGRESSION: the UTC day key is gone from the meeting grouping');
  ok(/require\('\.\/tz'\)\.weekday/.test(refs), 'and the recurring weekday is Eastern too');

  const shapes = fs.readFileSync(path.join(__dirname, '..', 'studio', 'doc_shapes.js'), 'utf8');
  ok(/_tz && _tz\.dateShort/.test(shapes), 'a packaged document is dated in Eastern');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
