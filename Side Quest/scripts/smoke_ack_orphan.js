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

// ── LONG branch (G-orphan-long, 2026-08-16 external-extraction drill): a >240-char PLAN NARRATION with no
// result payload must be caught; a real long deliverable / a single-signal near-miss must NOT. ──
console.log('\nLONG branch — plan narration vs real long answer:');
ok(isAckOrphan('Let me check my echo tools first, then hit the FEC API for Schedule E. I will pull the independent-expenditure records for the 2024 Florida House races, aggregate them by committee, and print the top 15. First I need to confirm which tool exposes Schedule E.'),
  'T6 plan narration (explore-lead + plan-chain, no payload) → orphan');
ok(isAckOrphan('Good — I have the six EINs. Let me now pull the 990 data for each and rank the top eight by revenue, then print revenue minus expenses.'),
  'T9 plan narration → orphan');
ok(!isAckOrphan('Let me pull together the framing for the press release. Our position on the water-quality bill is straightforward: it protects families, it holds polluters accountable, and it was opposed by the very interests that profit from the status quo. The campaign should lead with the families angle.'),
  'WRITE draft (explore-lead but NO plan-chain) → NOT orphan');
ok(!isAckOrphan('Let me check the reply pipeline against the drill. The routing in runChatTurn looks sound, but the ack-orphan gate in delivery.js only guarded short answers, so a long plan narration slipped through and got delivered as the result. The honest-hedge branch never fired above the length threshold.'),
  'prose code review (no plan-chain) → NOT orphan');
ok(!isAckOrphan('Ranked by total revenue: NEA $391.0M (surplus $12.4M), CTA $214.8M (surplus $3.1M), NYSUT $138.2M and the rest follow below in the same descending order for all eight unions requested.'),
  'real 990 ranking with currency payload → NOT orphan');
ok(!isAckOrphan('I ran the aggregation against the FEC Schedule E extract, but the endpoint returned 0 rows for the 2024 Florida House filter, so I have nothing to rank yet. I can widen the filter to all 2024 federal races and retry if that helps.'),
  'honest empty (0 rows payload) → NOT orphan');
ok(!isAckOrphan('The county uses a parish/police-jury governing model that differs from the county-commission model used elsewhere in the South, which is exactly why the terminology throws so many people off and why the board structure looks unusual at first glance. If you want the exact governing statute, let me pull the citation for you.'),
  'qualitative + trailing offer (explore-lead past char 240) → NOT orphan');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
