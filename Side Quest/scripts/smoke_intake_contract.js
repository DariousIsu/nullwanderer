'use strict';
/* smoke_intake_contract.js — C1 booking contract + C2 facet gate (lib/intake_contract.js).
 * Load-bearing cases from live-test run 2 (2026-08-19): two "finish the report at notes/…" orders
 * booked NOTHING and died behind confident acks (C1); "more details on the Senate District 14
 * vacancy" attached as the INDIANA run's enrich_facet and a 7-state sponsors order attached to the
 * ILLINOIS run (C2). Pure. Run: node scripts/smoke_intake_contract.js */
const ic = require('../lib/intake_contract');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── C1: deliverable orders MUST detect (the run-2 dead orders) ───────────────────────────────────────────
{
  const o = ic.detectDeliverableOrder("Alright Zoe, let's finish the Hartfield and Green South report — the one at notes/report-hartfield-and-green-south.md. The draft is solid but it stalls on the same gaps every pass.");
  ok(!!o, 'C1: run-2 dead order #1 ("let\'s finish the report at notes/…") → detected');
  ok(o && o.target === 'notes/report-hartfield-and-green-south.md', 'C1: the explicit file target is captured');
}
ok(!!ic.detectDeliverableOrder('Update notes/anti_china_2026_sponsors.md in place — close or dead-end each open question.'), 'C1: "update notes/… in place" → detected');
ok(!!ic.detectDeliverableOrder('build the bill-sponsors sheet. One row per bill: state, bill number, title.'), 'C1: "build the … sheet" → detected');
ok(!!ic.detectDeliverableOrder('then land the working outline on the canvas as our op-ed doc: hook, the mechanism, the close'), 'C1: "land the outline on the canvas" → detected (canvas target)');
ok(!!ic.detectDeliverableOrder('I need you to compile a summary of the Green South filings by Friday.'), 'C1: "I need you to compile a summary" → detected');
{
  const o = ic.detectDeliverableOrder('Compose the sheet from the agent output and land it at notes/anti_china_2026_sponsors.md like I asked.');
  ok(!!o && o.target === 'notes/anti_china_2026_sponsors.md', 'C1: compose+land with a path → detected with target');
}

// ── C1: non-orders MUST NOT detect (questions, status, chatter) ──────────────────────────────────────────
ok(!ic.detectDeliverableOrder('who represents louisiana senate district 14'), 'C1-FP: a lookup question is not an order');
ok(!ic.detectDeliverableOrder('status report'), 'C1-FP: "status report" (his 4× status ping) is not an order');
ok(!ic.detectDeliverableOrder('hows it coming on the numbers verification?'), 'C1-FP: a progress check is not an order');
ok(!ic.detectDeliverableOrder('what documents are sitting on your canvas right now'), 'C1-FP: a canvas inventory QUESTION is not an order');
ok(!ic.detectDeliverableOrder('The report you wrote yesterday was solid work.'), 'C1-FP: praise mentioning a report is not an order');
ok(!ic.detectDeliverableOrder("ok lets switch gears and brainstorm for a bit. I keep coming back to the panic idea."), 'C1-FP: brainstorm steering is not an order');
ok(!ic.detectDeliverableOrder('Would you build me a list of the parish contacts?'), 'C1-FP: a question-phrased request stays with the ask lanes (precision over recall)');

// ── C2: the two live misattachments MUST gate ────────────────────────────────────────────────────────────
const INDIANA_RUN = { goal: 'VALIDATE the elected officials of the Indiana state legislature — the COMPLETE membership of every chamber (each member by name, district, and party), plus chamber leadership', facet: '', orgs: ['Indiana State Senate', 'Indiana House of Representatives'] };
{
  const r = ic.foreignSubject('No — I meant more details on the Senate District 14 vacancy you just told me about. The special election, who\'s running, that thread.', INDIANA_RUN);
  ok(r.foreign, 'C2: "Senate District 14 vacancy" vs the INDIANA run → FOREIGN (run-2 misattachment #1)');
}
{
  const ILLINOIS_RUN = { goal: 'VALIDATE the elected officials of the Illinois state legislature — the COMPLETE membership of every chamber', facet: '', orgs: ['Illinois State Senate', 'Illinois House of Representatives'] };
  const r = ic.foreignSubject('a sheet with all the bill sponsors and co sponsors from the review of Utah, Arizona, Texas, Florida, Tennessee, Louisiana, and Iowa, organized by state then by bill', ILLINOIS_RUN);
  ok(r.foreign && /state/i.test(r.why), 'C2: the 7-state sponsors ask vs the ILLINOIS run → FOREIGN by state (run-2 misattachment #2)');
}

// ── C2: legit corrections MUST pass through ──────────────────────────────────────────────────────────────
ok(!ic.foreignSubject('just do the 5 most complete', INDIANA_RUN).foreign, 'C2-pass: bare scope-talk ("just the 5 most complete") reaches the classifier');
ok(!ic.foreignSubject('make it deep and add committee assignments', INDIANA_RUN).foreign, 'C2-pass: depth/scope words with no foreign anchors');
ok(!ic.foreignSubject('focus on the Indiana Senate first, then the House', INDIANA_RUN).foreign, 'C2-pass: "Indiana Senate" token-matches the run ("Indiana State Senate")');
ok(!ic.foreignSubject('skip the leadership section for now', INDIANA_RUN).foreign, 'C2-pass: a section skip is scope-talk');
{
  const r = ic.foreignSubject('add Indiana and also cover Ohio', INDIANA_RUN);
  ok(r.foreign && /ohio/i.test(r.why), 'C2: expanding to a NEW state (Ohio) gates as its own ask — scope growth is an order, not a silent facet');
}
ok(ic.foreignSubject('anything', {}).foreign === false, 'C2: no run scope → never foreign (fail open)');

// ── F27: the edit-shaped order (boot_p53 retest, promise#1753 pursued as report-compose) ────────────────
ok(ic.detectEditIntent('finish polishing the summary in notes/anti_china_followups.md — read it and tighten the wording in place.'),
  'F27 REGRESSION: the verbatim live order is edit-shaped');
ok(ic.detectEditIntent('update the sponsors table in place with the corrected dates'), '"update … in place" is edit-shaped');
ok(ic.detectEditIntent('revise the phrasing in the current draft'), '"revise the phrasing … current draft" is edit-shaped');
ok(ic.detectEditIntent('tighten the prose in the existing file, keep the structure'), 'edit verb + existing-file cue');
ok(!ic.detectEditIntent('write a report on the Louisiana parishes'), 'a compose order is NOT edit-shaped');
ok(!ic.detectEditIntent('update the roster with the new members'), 'a bare "update" without an in-place cue stays compose (additive updates rebuild)');
ok(!ic.detectEditIntent('the editor cleaned up the piece nicely'), 'chatter about editing never fires');
ok(!ic.detectEditIntent(''), 'empty → false');
// F27b (boot_p54 live): edit-verb orders must BOOK — this exact phrasing produced zero booking.
{
  const r = ic.detectDeliverableOrder('clean up the wording in notes/anti_china_numbers_verification.md — smooth the phrasing in place, keep every number exactly as it is.');
  ok(r && r.target === 'notes/anti_china_numbers_verification.md', 'F27b REGRESSION: the unbooked live edit order now books with the right target');
  ok(r && ic.detectEditIntent('clean up the wording in notes/anti_china_numbers_verification.md — smooth the phrasing in place'), '…and it is edit-shaped');
}
ok(!!ic.detectDeliverableOrder('polish the summary in notes/x.md in place'), 'a polish-led order with a path books');
ok(!ic.detectDeliverableOrder('the cleanup crew did a great job on the office'), 'noun "cleanup" chatter never books (no order lead)');

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────
ok(ic.statesIn('Utah, Arizona and new mexico are in; Indianapolis is not a state').join(',') === 'arizona,new mexico,utah', 'statesIn: names matched, city-lookalikes not');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
