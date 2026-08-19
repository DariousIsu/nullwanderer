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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
