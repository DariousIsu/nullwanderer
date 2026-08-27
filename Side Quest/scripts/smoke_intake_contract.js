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
// Leg-4 live (08-27): "Pull the full text of Louisiana SB200 …" read as topic-discussed — bare
// "pull" is not an order verb except when its object IS the full/bill text (lookahead-bounded).
{
  const o = ic.detectDeliverableOrder('Pull the full text of Louisiana SB200 and check what carve-outs it actually has.');
  ok(o && /full text/i.test(o.deliverable), 'C1: "Pull the full text of <bill> and check …" → books (the leg-4 live miss)');
}
ok(!ic.detectDeliverableOrder('text me when the meeting starts'), 'C1 FP guard: "text me" is not a deliverable');
ok(!ic.detectDeliverableOrder('pull yourself together'), 'C1 FP guard: reflexive pull never books');
ok(!ic.detectDeliverableOrder('what does the full text of SB200 say?'), 'C1 FP guard: an interrogative about the text is an ask, not an order');
// P2 gate catch (2026-08-21): "REBUILD the report on X" was not an order to this detector — the
// intake filed a direct imperative as "topic discussed, not commanded" and NOTHING dispatched.
ok(!!ic.detectDeliverableOrder('rebuild the report on anti-China and surveillance bills state by state with sponsors and co-sponsors: Utah, Arizona, Texas, Florida, Tennessee, Louisiana, Iowa'),
  'P2-GATE REGRESSION: the LIVE "rebuild the report on …" order is an ORDER (re-order verbs joined)');
ok(!!ic.detectDeliverableOrder('regenerate the Hartfield brief with the new 990 data'), 'regenerate → an order');
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
// F28 (saturation run 3, live-missed ×2): placement-verb orders and approach-bridge orders must book.
{
  const r = ic.detectDeliverableOrder('Put a short two-point primer on Louisiana coastal insurance rates on the canvas.');
  ok(r && r.target === 'canvas', 'F28 REGRESSION: "Put a … primer … on the canvas" books with target=canvas');
}
{
  const r = ic.detectDeliverableOrder('Go into notes/anti_china_followups.md and smooth the rough sentences right in the file — numbers stay untouched.');
  ok(r && r.target === 'notes/anti_china_followups.md', 'F28 REGRESSION: "Go into <path> and smooth …" books with the file target');
  ok(ic.detectEditIntent('Go into notes/anti_china_followups.md and smooth the rough sentences right in the file'), '…and "right in the file" marks it edit-shaped (modify-the-target, never compose)');
}
ok(!!ic.detectDeliverableOrder('drop a two-line summary of the hearing on the canvas'), 'a drop-on-canvas order books');
ok(!ic.detectDeliverableOrder('did you put the summary on the canvas?'), 'a question about placement never books (interrogative guard)');
ok(!ic.detectDeliverableOrder('go into detail about the coastal program for me'), 'approach-verb chatter with no order verb and no deliverable never books');
ok(!ic.detectDeliverableOrder('put simply, the coastal market is contracting fast'), '"put simply" chatter never books (no deliverable evidence)');

// ── run-6 re-drive catch: DEFERRED orders still book ─────────────────────────────────────────────────────
{
  const d1 = ic.detectDeliverableOrder("Sometime today, put together a short digest of parish road-project announcements — whenever there's a gap, no hurry.");
  ok(d1 && d1.deliverable === 'digest', 'RUN-6 REGRESSION: the verbatim deferred order books (deferral prefix + digest noun)');
  const d2 = ic.detectDeliverableOrder('When you get a chance, pull together a rundown of parish-level insurance complaint trends — no rush on it.');
  ok(d2 && d2.deliverable === 'rundown', 'the run-6 main-run phrasing (timeout-unjudged) books: when-you-get-a-chance + rundown');
  const d3 = ic.detectDeliverableOrder('No rush, but draft a memo on the levee vote.');
  ok(d3 && d3.deliverable === 'memo', 'a no-rush-but lead still books');
  ok(d1 && /^put together/i.test(d1.topic), 'the topic strips the deferral prefix (pursuit sees the order, not the scheduling)');
  ok(!ic.detectDeliverableOrder('Sometime today the House schedule should firm up.'), 'a deferral with NO order verb never books');
  const d4 = ic.detectDeliverableOrder('Good — package that up as a short paper.');
  ok(d4 && d4.deliverable === 'paper', 'RUN-7 REGRESSION: an affirmation-led package order books (good-dash lead + paper noun)');
  const pf = require('../lib/paper_finalize');
  ok(pf.PAPER_VERB_RE.test('Perfect — write that up as a short paper.'), 'RUN-8 REGRESSION: "write THAT up" reaches the paper door (deictic between verb and particle)');
  ok(pf.PAPER_VERB_RE.test('package that up as a short paper'), 'the package verb reaches the paper door');
  ok(!pf.PAPER_VERB_RE.test('the write-up we discussed covers the paper trail'), 'noun-ish chatter never opens the conductor');
  ok(!ic.detectDeliverableOrder('No rush on my end — just thinking out loud about the digest idea.'), 'deferral chatter without an order lead never books');
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────
ok(ic.statesIn('Utah, Arizona and new mexico are in; Indianapolis is not a state').join(',') === 'arizona,new mexico,utah', 'statesIn: names matched, city-lookalikes not');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
