'use strict';
/* smoke_workstate_gate.js — W5 Slice 0: the work-state vector (lib/work_state.js) + the say-truth
 * gate (metacognition.verifyWorkStateClaims) + the widened delivery promise nets.
 *
 * The load-bearing case (live-test run 2, 2026-08-19, turn #12620): asked to verify from records,
 * the reply asserted "Records indicate the Applied Digital briefing is still pending and must be
 * completed by tomorrow morning" — composed before the tools ran, backed by a dead-end db_query and
 * a schema map, about a deliverable shipped 5 days earlier. Both new claim kinds must catch it, and
 * the pure work-state probes must match/miss honestly. Pure, no db (snapshot() is exercised only for
 * shape). Run: node scripts/smoke_workstate_gate.js */
const mc = require('../lib/metacognition');
const ws = require('../lib/work_state');
const dl = require('../lib/delivery');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── the F2 replay: records-attribution + invented pending deadline ───────────────────────────────────────
const F2 = 'Records indicate the Applied Digital briefing is still pending and must be completed by tomorrow morning.';
{
  // gather ran, but the evidence (a schema map) does not contain the claim's subject → records-mismatch
  const r = mc.verifyWorkStateClaims(F2, {
    gatherRanThisTurn: () => true,
    pendingRecordFor: () => false,
    evidence: 'databases: main (58 tables), skuld (64 tables), electoral (83 tables) — schema map only',
  });
  ok(!r.ok, 'F2: the false verification is flagged');
  ok(r.violations.some((v) => v.kind === 'records-mismatch'), 'F2: records-mismatch (evidence lacks the subject anchors)');
  ok(r.violations.some((v) => v.kind === 'pending'), 'F2: pending (no measured record backs the deadline)');
}
{
  // no read ran at all → plain 'records' violation
  const r = mc.verifyWorkStateClaims('My records show the dossier went out last week.', { gatherRanThisTurn: () => false, evidence: '' });
  ok(!r.ok && r.violations.some((v) => v.kind === 'records'), 'records: attribution with NO read this turn → flagged');
}
{
  // grounded: the evidence actually contains the subject → clean
  const r = mc.verifyWorkStateClaims('My records show 578 Louisiana contacts with a phone number.', {
    gatherRanThisTurn: () => true,
    evidence: 'rows: contact WHERE State_Represented=LA … louisiana total 1683 with_phone 578',
  });
  ok(r.ok, 'records: attribution whose anchors ARE in the evidence → clean');
}
{
  // a pending record really exists → clean
  const snap = { promises: [{ subject: 'sheet#abc', deliverable: 'the sponsors sheet', topic: 'anti-China land bills', bornTs: 1 }], foci: [] };
  const r = mc.verifyWorkStateClaims('The Sponsors sheet is still pending — I owe you that briefing.', {
    gatherRanThisTurn: () => true,
    pendingRecordFor: (anchors) => ws.pendingRecordFor(anchors, snap),
    evidence: '',
  });
  ok(r.ok, 'pending: a claim BACKED by an open promise → clean');
}
// ── guards: external-world pendings, future intent, no anchors, fail-open ────────────────────────────────
ok(mc.verifyWorkStateClaims('The bill is still pending in committee, per the Legislature site.', { pendingRecordFor: () => false, gatherRanThisTurn: () => true }).ok,
  'guard: a BILL pending in committee (external world) is never her ledger\'s problem');
ok(mc.verifyWorkStateClaims("I'll check my records and get back to you.", { gatherRanThisTurn: () => false }).ok,
  'guard: future intent ("I\'ll check my records") is not a state assertion');
ok(mc.verifyWorkStateClaims('Records show nothing new since then.', { gatherRanThisTurn: () => true, evidence: 'plenty of unrelated evidence text here to pass the floor' }).ok,
  'guard: a records claim with NO proper-noun anchors → abstain (fail open)');
{
  const r = mc.verifyWorkStateClaims(F2, { gatherRanThisTurn: () => { throw new Error('probe down'); }, pendingRecordFor: () => { throw new Error('probe down'); }, evidence: '' });
  ok(r.ok, 'fail-open: throwing probes never manufacture a violation');
}
{
  const c = mc.workStateCorrection([{ kind: 'records-mismatch', claim: 'x' }, { kind: 'pending', claim: 'y' }]);
  ok(/\[Correction —/.test(c) && /records/.test(c) && /pending/i.test(c), 'workStateCorrection: names both failures honestly');
  ok(mc.workStateCorrection([]) === '', 'workStateCorrection: no violations → no text');
}

// ── work_state pure probes ───────────────────────────────────────────────────────────────────────────────
{
  const snap = {
    promises: [{ subject: 'sponsors sheet#k3', deliverable: 'the sponsors sheet', topic: 'anti-China 2026', bornTs: 1000 }],
    foci: [{ id: 3949, kind: 'entity', subject: 'VALIDATE the Indiana state legislature', targets: ['Indiana State Senate'], covered: [], file: 'notes/directed-3949.md' }],
    lastGatherTs: 0, lastExternalGatherTs: 0, lastCanvasWriteTs: 0,
  };
  ok(ws.pendingRecordFor(['sponsors'], snap) === true, 'pendingRecordFor: promise-subject token match → true');
  ok(ws.pendingRecordFor(['indiana'], snap) === true, 'pendingRecordFor: focus-target match → true');
  ok(ws.pendingRecordFor(['hartfield'], snap) === false, 'pendingRecordFor: NO record anywhere → false');
  ok(ws.pendingRecordFor([], snap) === true, 'pendingRecordFor: no checkable anchors → fail open');
  ok(ws.liveWorkNow(500, { ...snap, lastGatherTs: 600 }) === true, 'liveWorkNow: a read after turn start → true');
  ok(ws.liveWorkNow(5e12, snap) === false, 'liveWorkNow: nothing in motion → false');
  const st = ws.renderStatus(snap, { now: 2000 });
  ok(/Open delivery promises \(1\)/.test(st) && /sponsors sheet/.test(st), 'renderStatus: renders the measured promise');
  ok(/#3949/.test(st) && /Indiana/i.test(st), 'renderStatus: renders the measured focus');
  const empty = ws.renderStatus({ promises: [], foci: [], lastGatherTs: 0, lastCanvasWriteTs: 0 }, { now: 2000 });
  ok(/none on the ledger/.test(empty) && /none recorded/.test(empty), 'renderStatus: an empty vector says so honestly');
}
{
  const snap = ws.snapshot();   // the one db edge — must not throw, must return the shape
  ok(snap && Array.isArray(snap.promises) && Array.isArray(snap.foci), 'snapshot(): returns the shape without throwing (fail-soft edges)');
  ok(Array.isArray(snap.bulk), 'snapshot(): carries the scheduler section (fail-soft to [])');
}

// ── F10-class (08-27): the api-bulk scheduler is VISIBLE to introspection ────────────────────────────────
// Live failure: "did the backfill run?" → "no such pass registered" while the LegiScan drain was mid-run —
// the vector held promises/foci/stamps but no scheduler lane. The bulk section renders + grounds claims.
{
  const snap = {
    promises: [], foci: [], lastGatherTs: 0, lastCanvasWriteTs: 0,
    bulk: [{ id: 'legiscan:TN', state: 'TN', records: 4200, newestTs: 1000 }, { id: 'legiscan:IA', state: 'IA', records: 34, newestTs: 0 }],
  };
  const st = ws.renderStatus(snap, { now: 2000 });
  ok(/Background backfill \(api-bulk scheduler\)/.test(st), 'renderStatus: the scheduler line renders when jobs exist');
  ok(/TN 4200 record\(s\), newest landed/.test(st), 'renderStatus: per-job record count + newest-landing age');
  ok(/IA 34 record\(s\)/.test(st) && !/IA 34 record\(s\), newest/.test(st), 'renderStatus: a job with no landings yet omits the age clause');
  ok(!/Background backfill/.test(ws.renderStatus({ promises: [], foci: [], bulk: [] }, { now: 2000 })), 'renderStatus: no configured jobs → no scheduler line');
  ok(ws.pendingRecordFor(['the legiscan backfill'], snap) === true, 'pendingRecordFor: a backfill claim is GROUNDED by the scheduler section');
}

// ── F10 leg-3 (08-27): the BACKFILL DOOR — a specific backfill ask answers from the scheduler ────────────
{
  const fs = require('fs'), path = require('path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/\[backfill-door\] scheduler standing injected/.test(main), 'the backfill door logs its injection');
  ok(/get_pass_status cannot see it/.test(main) && /never report its absence there as "the backfill didn't run"/.test(main),
    'the door names the exact live failure: Echo pass-land is the WRONG store for the api-bulk drain');
  ok(/require\('\.\/lib\/api_bulk'\)\.standing\(\)/.test(main), 'the door reads the scheduler\'s own measured standing');
}

// ── F29 (saturation run 3): the whole-plate work-status door ─────────────────────────────────────────────
// Both live phrasings missed the poll-track door and composed ledgers from raw tool reads; this
// probe is the general door, and the wiring grep pins the main.js lead + marker.
ok(ws.isWorkStatusQuestion("Where do things stand on everything I've got you working on?"), 'F29 REGRESSION: "where do things stand on everything…" → work-status');
ok(ws.isWorkStatusQuestion('Run me through your open items — honest ledger.'), 'F29 REGRESSION: "run me through your open items" → work-status');
ok(ws.isWorkStatusQuestion("what's still open on your plate?"), '"what\'s still open on your plate" → work-status');
ok(ws.isWorkStatusQuestion('what do you still owe me?'), '"what do you owe me" → work-status');
ok(!ws.isWorkStatusQuestion("what's the status of the Womack phone lookup?"), 'a SPECIFIC-thing status ask keeps its own lane (no whole-plate cue)');
ok(!ws.isWorkStatusQuestion('what are you working on right now?'), 'present-activity stays with the activity poll');
ok(!ws.isWorkStatusQuestion('the ledger shows a $400 balance open'), 'ledger/open chatter about HIS books never fires');
{
  const mainSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  ok(/isWorkStatusQuestion\(userMessage\) && !activityQ && !selfLearnQ && !selfActivityQ/.test(mainSrc), 'wiring: workStatusQ gated off the activity/learn/doing doors');
  ok(/\[status\] status body led by the measured work-state vector/.test(mainSrc), 'wiring: the general door logs the measured-vector marker');
}

// ── widened delivery nets: run-2's dangling phrasings must now BOOK ──────────────────────────────────────
const has = (say) => dl.detectPromise(say).length > 0;
ok(has("I'm pulling it now from our workspace, then hitting ProPublica for the 990-PFs."), 'book: "I\'m pulling it now … the 990-PFs" (progressive commitment, run-2 dangle #1)');
ok(has("I'll compose the sheet from what it returns and land it at notes/anti_china_2026_sponsors.md."), 'book: "I\'ll compose the sheet … and land it" (run-2 dangle #2)');
ok(has('Let me pull the actual report from our workspace and then get to work on those four gaps.'), 'book: "let me pull the actual report" (regression: already matched, must stay)');
ok(!has("I'm hoping the search comes back cleaner this time."), 'FP: "I\'m hoping…" (no work-verb progressive) → not a promise');
ok(!has("I'm working late tonight."), 'FP: bare progressive with no deliverable object → not a promise');
ok(!has('Want me to compose the sheet for you?'), 'FP: an offer is still not a debt');
ok(!has("I've already composed the sheet and landed it."), 'FP: a done-claim is still anti-fab\'s job');

// ── run-8 recall confabulation: shared-past-verification is a records-attribution ────────────────────────
{
  const SAY = "Sharon Hewitt — Republican state senator, co-sponsored SB200 in the 2018 1st Extraordinary Session. That's what we verified.";
  const EV = 'LA SB200 co-sponsors per the held sheet: Allain, Barrow, Bass, Cathey, Cloud, Connick, Edmonds, Fesi, Henry, Kleinpeter. Sen. Larry Selders (D-14) co-sponsored; died 2026-07-07.';
  const r1 = mc.verifyWorkStateClaims(SAY, { gatherRanThisTurn: () => true, evidence: EV });
  ok(!r1.ok && r1.violations.some((v) => v.kind === 'records-mismatch'), 'RUN-8 REGRESSION: "That\'s what we verified" mismatches when the retrieved sheet never mentions the named person (anchors from the BLESSED sentence)');
  const r2 = mc.verifyWorkStateClaims(SAY, { gatherRanThisTurn: () => false, evidence: '' });
  ok(!r2.ok && r2.violations.some((v) => v.kind === 'records'), 'the same claim with NO read this turn → a naked records-attribution');
  const r3 = mc.verifyWorkStateClaims("Larry Selders co-sponsored SB200 — that's what we verified.", { gatherRanThisTurn: () => true, evidence: EV });
  ok(r3.ok, 'a TRUE shared-verification claim (anchors present in the evidence) never scolds');
  const r4 = mc.verifyWorkStateClaims('We verified the numbers together and they held up fine.', { gatherRanThisTurn: () => true, evidence: 'unrelated evidence text long enough to trigger the mismatch scope if it applied' });
  ok(r4.ok, 'FP guard (the F24 lesson): a bare "we verified X" with no past-session tail stays OUT of the net');
  const r5 = mc.verifyWorkStateClaims('We landed on the trust-fund framing in an earlier session. The Ellis angle came later.', { gatherRanThisTurn: () => true, evidence: 'the trust-fund framing rode the coastal briefing; Ellis Marsalis budget dispute notes.' });
  ok(r5.ok, 'we-landed-on WITH a session tail but anchors present in evidence → clean');
  // The re-drive escape: retrieval returned the WRONG record (Hewitt's own file), so her name IS
  // in the evidence — but the claim pairs her with a bill the evidence never mentions.
  const EV_WRONG = 'Sharon Hewitt — Republican state senator, SD-1. Email hewitts@legis.la.gov; sponsor activity in the 2018 1st Extraordinary Session; gubernatorial run 2023.';
  const r6 = mc.verifyWorkStateClaims(SAY, { gatherRanThisTurn: () => true, evidence: EV_WRONG });
  ok(!r6.ok && r6.violations.some((v) => v.kind === 'records-mismatch' && v.anchors.includes('sb200')), 'RE-DRIVE REGRESSION: a bill-number pairing (SB200) absent from the retrieved record mismatches even when the PERSON anchors are present');
  const r7 = mc.verifyWorkStateClaims("Selders co-sponsored SB200 — that's what we verified.", { gatherRanThisTurn: () => true, evidence: 'the sheet: SB 200 co-sponsors include Selders (D-14).' });
  ok(r7.ok, 'a true pairing holds even across the SB-200/SB200 spacing difference');
}

// ── R11: the registration/booking claim (LA rematch: "pivot's registered" with NO door booking) ──
{
  const reg = "The Rapides tax pivot's registered.";
  const rNo = mc.verifyWorkStateClaims(reg, { pendingRecordFor: () => false });
  ok(!rNo.ok && rNo.violations.some((v) => v.kind === 'registration'), 'R11: "pivot\'s registered" with NO measured record → flagged registration');
  ok(mc.verifyWorkStateClaims("The tax pivot's registered, and I'll fold it into the next wave.", { pendingRecordFor: () => false }).ok, 'R11 fail-open: a registration claim sharing a sentence with future intent ("I\'ll fold it") is NOT scolded (offers/intents stay safe)');
  ok(/registered\/booked, but I hold no record/.test(mc.workStateCorrection(rNo.violations)), 'R11: the honest correction names the unbooked claim');
  const rYes = mc.verifyWorkStateClaims(reg, { pendingRecordFor: () => true });
  ok(rYes.ok, 'R11: the SAME claim WITH a measured record backing it → clean (no false scold)');
  // FP guards
  ok(mc.verifyWorkStateClaims('The bill is registered in the state legislative system.', { pendingRecordFor: () => false }).ok, 'R11 FP: an EXTERNAL "registered in the state system" is not her work-state → not flagged');
  ok(mc.verifyWorkStateClaims("That's registered.", { pendingRecordFor: () => false }).ok, 'R11 FP: a bare "that\'s registered" with no anchors draws nothing (anchor-gated)');
  ok(mc.verifyWorkStateClaims('I\'ve booked the Hartfield roster pull as a task.', { pendingRecordFor: () => false }).violations.some((v) => v.kind === 'registration'), 'R11: "I\'ve booked X as a task" with no record → flagged');
}

// ── R11b (round-3 catch 08-26): the PASSIVE registration shape + the claimed reminder id ──
{
  // the live evasion verbatim: subject outside the work-noun list + an appositive reminder claim
  const evade = 'Noted — the 143 unknown-parish contacts are logged as tracked work for later, reminder #94 on my clock.';
  const rP = mc.verifyWorkStateClaims(evade, { pendingRecordFor: () => false, reminderExists: () => false });
  ok(!rP.ok && rP.violations.some((v) => v.kind === 'registration' || v.kind === 'reminder-id'), 'R11b: the passive "are logged as tracked work" + stale reminder # is caught (the R3-2 evasion verbatim)');
  const rId = mc.verifyWorkStateClaims('Your levee check is set — reminder #212 on my clock will surface it Tuesday.', { reminderExists: (id) => id !== 212 });
  ok(!rId.ok && rId.violations.some((v) => v.kind === 'reminder-id' && v.id === 212), 'R11b: a cited reminder # with no pending row behind it → flagged');
  ok(/reminder number that does not exist on my clock/.test(mc.workStateCorrection(rId.violations)), 'R11b: the honest correction names the phantom reminder');
  ok(mc.verifyWorkStateClaims('Your levee check is set — reminder #212 on my clock will surface it Tuesday.', { reminderExists: () => true }).ok, 'R11b: the SAME claim with a real pending row → clean');
  ok(mc.verifyWorkStateClaims('I deleted the stale hold — task #94 removed from the clock.', { reminderExists: () => false }).ok, 'R11b FP: talking about a DELETED task id is not a live-hold claim');
  ok(mc.verifyWorkStateClaims(evade, {}).ok, 'R11b fail-open: no reminderExists hook and no pendingRecordFor → no scold (probe stays optional)');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
