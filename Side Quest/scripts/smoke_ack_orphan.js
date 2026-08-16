/* Smoke: delivery.isAckOrphan — the structural ack-orphan gate at the DELIVER decision point (D-orphan,
 * 2026-08-16 drill). Pure logic. The live bug: the operator RAN but the model ended on a content-free ack
 * ("writing it now — stand by, I'll paste the output shortly"); the DELIVER block wrapped that verbatim as
 * "the complete result of the task you just ran" — voicing a PROMISE as the deliverable. isAckOrphan is true
 * only for a SHORT, ack-lead answer with NO result payload; a real result (even one that opens with "On it")
 * or an honest empty/partial ("returned 0 rows") carries a payload token and is NOT suppressed.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_ack_orphan.js
 */
'use strict';
const { isAckOrphan } = require('../lib/delivery');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── ORPHAN: short, ack-lead, no payload → suppress (falls to the directed honest-hedge) ──
ok(isAckOrphan("Writing the Python script now — stand by, I'll paste the output shortly."),
  '"stand by, I\'ll paste the output shortly" → orphan (the T6/T8 non-delivery)');
ok(isAckOrphan('On it — first pass now.'), '"on it … first pass now" → orphan');
ok(isAckOrphan("Starting on that now — I'll have the numbers in a minute."), '"starting on that now" → orphan');

// ── NOT an orphan: a real result must pass, even if it OPENS with an ack-lead ──
ok(!isAckOrphan("On it — here are the FEC Q1–Q4 totals: Q1 $1,240,000; Q2 $980,500; Q3 $1,510,000; Q4 $2,003,750. Saved to notes/fec_totals.md."),
  'opens "On it" but carries digits + /notes/ path → NOT orphan (must not eat a real result)');
ok(!isAckOrphan("The analysis ran but returned 0 rows — the electoral CRM table is empty for that filter."),
  'honest empty result ("returned 0 rows") → NOT orphan (a real partial is delivered)');
ok(!isAckOrphan("Here's the breakdown by state:\n| State | Count |\n| LA | 412 |"),
  'markdown table payload → NOT orphan');

// ── edges ──
ok(!isAckOrphan(''), 'empty → not an orphan (nothing to suppress)');
ok(!isAckOrphan('Absolutely — what angle matters most before I dig in?'),
  'a genuine clarifying question (no ack-lead) → NOT orphan');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
