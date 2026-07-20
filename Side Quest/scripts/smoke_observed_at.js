/* smoke_observed_at.js — the SOURCE's own date (W1, docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md §2).
 *
 * The load-bearing tests are the REFUSALS. A wrong date is worse than no date: it is indistinguishable
 * from a right one downstream, and under recency weighting it silently reorders everything. Coverage is
 * not the goal here — never guessing is.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_observed_at.js
 */
'use strict';
const oa = require('../lib/observed_at');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// A fixed "now" so these never rot: 2026-07-20, the day the live corpus was measured.
const NOW = Date.UTC(2026, 6, 20, 12, 0, 0);
const at = (o) => oa.extractObservedAt({ now: NOW, ...o });

// ── the formats ──────────────────────────────────────────────────────────────────────────────────
ok(at({ text: 'Published 2021-03-14 by the clerk' }).iso === '2021-03-14', 'ISO');
ok(at({ text: 'Adopted July 23, 2021 at a regular meeting' }).iso === '2021-07-23', 'month name first');
ok(at({ text: 'Dated 23 July 2021 and filed' }).iso === '2021-07-23', 'day first');
ok(at({ text: 'Filed 7/23/2021 with the county' }).iso === '2021-07-23', 'numeric US');
ok(at({ text: 'Filed 07-23-21 with the county' }).iso === '2021-07-23', 'numeric two-digit year');
ok(at({ text: 'Minutes of Jul 4, 2019' }).iso === '2019-07-04', 'abbreviated month');
{
  const r = at({ text: 'Budget report, March 2021, prepared for the board' });
  ok(r.iso === '2021-03-01' && r.precision === 'month',
    'month+year is recorded at month precision — "the 1st" must be distinguishable from "sometime that month"');
}

// ── THE REFUSALS ─────────────────────────────────────────────────────────────────────────────────
//
// The live case that shaped this module. Alameda County agendas carry the date of the meeting BEING
// SCHEDULED, which is in the future. Under recency weighting a future-dated source outranks everything
// real, permanently, and gets stronger as other material ages.
ok(at({ text: "ALAMEDA COUNTY BOARD OF SUPERVISORS' SPECIAL MEETING Thursday, July 23, 2026 10:00 a.m." }) === null,
  'CRITICAL: a future meeting date is REFUSED, not taken as the source date');
ok(at({ text: 'Meeting scheduled for 2030-01-01' }) === null, 'CRITICAL: far-future dates refused');
ok(at({ text: 'no dates at all in this body' }) === null, 'no date → null, never now()');
ok(at({ text: '' }) === null && at({}) === null, 'empty/missing → null, never throws');
ok(at({ text: 'Recorded 1723-04-05 in the parish ledger' }) === null, 'pre-1900 refused as a mis-parse');
ok(at({ text: 'Section 2026-13-45 of the code' }) === null,
  'CRITICAL: an impossible date (month 13) is rejected, not rolled over into a confident wrong answer');
ok(at({ text: 'Ordinance 2021-02-31 adopted' }) === null,
  'CRITICAL: Feb 31 does not silently become March 3');
{
  // A document published today in another timezone is not from the future.
  const today = at({ text: 'Filed July 20, 2026 with the clerk' });
  ok(today && today.iso === '2026-07-20', 'today is allowed (a modest future skew is tolerated)');
}

// ── which date wins ──────────────────────────────────────────────────────────────────────────────
{
  // A roster lists a date per official. The dateline is at the TOP; later dates are content.
  const r = at({ text: 'Adopted March 1, 2019.\n\nJane Doe, term began January 5, 2015. John Roe, term began June 2, 2011.' });
  ok(r.iso === '2019-03-01', 'the earliest-positioned date wins — the dateline, not the body content');
}
{
  // The publisher's own label for the file beats whatever the contents happen to mention first.
  const r = at({ text: 'Agenda covering items from March 2, 2015 onward', filename: 'PAL_Ag_7_20_19I.pdf' });
  ok(r.iso === '2019-07-20' && r.from === 'filename', 'a filename date is preferred over a body date');
  ok(at({ text: 'Adopted March 2, 2015' }).from === 'text', '…and `from` says which it was, since they are not equal evidence');
}
{
  // A filename date that is in the future must not fall through to a WRONG body date either — the
  // refusal has to survive the preference order.
  const r = at({ text: 'Adopted March 2, 2015 by the board', filename: 'agenda_7_23_26.pdf' });
  ok(r && r.iso === '2015-03-02' && r.from === 'text',
    'a future filename date is refused, and the real body date is still found');
}

// ── the known limitation, pinned so it cannot be "fixed" by narrowing the window ─────────────────
// These three are real documents. Position is exactly backwards on them: the two CONTENT dates appear
// early and the genuine dateline appears late. A future change that tightens HEAD_CHARS to chase the
// first two will silently break the third, so all three are asserted together.
{
  const table = at({ text: `${'ab '.repeat(40)}4/17/2021 meet results` });
  ok(table && table.iso === '2021-04-17', 'a date in a table row at idx ~120 is still taken (accepted imprecision)');
  const late = at({ text: `${'ab '.repeat(302)}January 20, 2026 Iberia Parish Council` });
  ok(late && late.iso === '2026-01-20',
    'CRITICAL: a genuine dateline at idx ~909 must still be found — this is what a tight window breaks');
}

// ── the helpers ──────────────────────────────────────────────────────────────────────────────────
ok(oa.fullYear(26) === 2026 && oa.fullYear(99) === 1999 && oa.fullYear(2021) === 2021, 'two-digit years pivot at 40');
ok(oa.utcTs(2021, 2, 31) === null && oa.utcTs(2021, 13, 1) === null, 'utcTs rejects impossible dates');
ok(oa.utcTs(2020, 2, 29) !== null, 'leap day is real');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
