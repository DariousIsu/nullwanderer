/* Smoke: lib/inquiry — LINES OF INQUIRY (catalog O0, slice 4). Deterministic: temp SQ_DB_PATH,
 * injected land. Proves the continuity contract: each touch starts where the last stopped.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_inquiry.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const TMPDIR = path.join(os.tmpdir(), `sq_inq_${process.pid}`);
process.env.SQ_DB_PATH = path.join(TMPDIR, 'sq.db');
const db = require('../lib/db'); db.init();
const I = require('../lib/inquiry');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const NOW = 1753400000000;

(async () => {
  // --- open + bounds ---
  ok(I.open({ question: 'too short' }).id === null, 'a non-question refuses to open');
  const a = I.open({ question: 'Which states have standing AI task forces, and who chairs them?', bornFrom: 'interest: state AI policy', nowMs: NOW });
  ok(a.id != null, 'a real question opens a line of inquiry');
  // Distinct TOPICS (the dedup guard now collapses near-identical questions — see the dedup block).
  const fillers = [
    'How many offshore wind projects broke ground on the Atlantic coast in 2025?',
    'What drove the copper price spike during the second quarter of this year?',
    'Where are the largest lithium refineries being built across North America?',
  ];
  for (let i = 0; i < I.MAX_ACTIVE - 1; i++) I.open({ question: fillers[i], nowMs: NOW + i + 1 });
  ok(I.listActive().length === I.MAX_ACTIVE, 'active lines are bounded');
  const broadband = I.open({ question: 'Who benefits most from the new federal broadband subsidy rollout this year?', nowMs: NOW + 99 });
  ok(I.listActive().length === I.MAX_ACTIVE, 'opening past the cap keeps the bound…');
  ok(db.getDb().prepare("SELECT COUNT(*) n FROM inquiries WHERE status = 'parked'").get().n === 1, '…by PARKING the stalest (resumable, never lost)');

  // --- DEDUP GUARD (boot73: #6 opened as a copy of the 25-touch #1) ---
  {
    // a near-verbatim copy of an ACTIVE line (broadband, the freshest) → deduped onto it, no new row
    const before = db.getDb().prepare('SELECT COUNT(*) n FROM inquiries').get().n;
    const dup = I.open({ question: 'Who gains the most from the federal broadband subsidy program rolling out this year?', nowMs: NOW + 200 });
    ok(dup.duplicate === true && dup.existing === 'active' && dup.existingId === broadband.id, 'a near-duplicate of an ACTIVE line dedupes onto it (advance, do not copy)');
    ok(db.getDb().prepare('SELECT COUNT(*) n FROM inquiries').get().n === before, '…and no new row is created');
    // a genuinely different question still opens (the guard is not a wall)
    const fresh = I.open({ question: 'What is the confirmed casualty count from the recent Gulf pipeline incident?', nowMs: NOW + 201 });
    ok(fresh.id != null && !fresh.duplicate, 'a genuinely distinct question still opens');
    // an ANSWERED twin → declined outright (the question is solved)
    I.close(fresh.id, { kind: 'answered', answer: 'resolved', nowMs: NOW + 203 });
    const ansDup = I.open({ question: 'What was the confirmed casualty count from that Gulf pipeline incident?', nowMs: NOW + 204 });
    ok(ansDup.id === null && ansDup.duplicate === true && ansDup.existing === 'closed_answered', 'a near-duplicate of an ANSWERED line is DECLINED (question already solved)');
    ok(I.questionOverlap('Louisiana parish sheriffs and clerks', 'the offshore wind project count') < I.DUP_THRESHOLD, 'questionOverlap: unrelated questions score below the dedup floor');
  }

  // --- the touch brief carries the continuity ---
  const b0 = I.touchBrief(I.get(a.id));
  ok(/LINE OF INQUIRY #\d+ \(touch 1\)/.test(b0) && /standing AI task forces/.test(b0), 'the first touch brief carries the question');
  ok(!/WHERE IT STANDS/.test(b0), 'no invented state on a fresh line');

  // --- write-back: append + replace, validated ---
  const v1 = I.validateWriteback('{"learned":"Six states confirmed so far; NCSL tracker is the best index.","new_evidence":[{"gist":"Texas AI Advisory Council est. 2023, chaired by the state CIO","cite":"ncsl.org tracker"}],"leads":["Colorado task force may have sunset — verify"],"next_step":"Work through the NCSL tracker states M-W","status":"continue"}');
  ok(v1.valid && v1.value.new_evidence.length === 1, 'a grounded write-back validates');
  ok(I.validateWriteback('{"new_evidence":[]}').valid === false, 'a write-back without learned refuses');
  ok(I.validateWriteback('prose only, no json').valid === false, 'garbage refuses');
  I.writeBack(a.id, v1.value, { nowMs: NOW + 1000 });
  const r1 = I.get(a.id);
  ok(r1.touches === 1 && /Six states confirmed/.test(r1.gist), 'the gist becomes the model\'s own summary');
  const b1 = I.touchBrief(r1);
  ok(/WHERE IT STANDS.*Six states/.test(b1) && /Texas AI Advisory Council/.test(b1) && /NCSL tracker states M-W/.test(b1),
    '⭐touch 2 starts where touch 1 stopped — summary, evidence, and next step all ride the brief');
  // evidence APPENDS across touches (never rolling-rewritten)
  I.writeBack(a.id, { learned: 'Nine states now.', new_evidence: [{ gist: 'Colorado task force sunset in 2024', cite: 'leg.colorado.gov' }], leads: [], next_step: 'States X-Z next', status: 'continue' }, { nowMs: NOW + 2000 });
  const ev = JSON.parse(I.get(a.id).evidence);
  ok(ev.length === 2 && /Texas/.test(ev[0].gist) && /Colorado/.test(ev[1].gist), 'evidence appends — the earlier finding survives the later touch');

  // --- expect trail ---
  I.expectTrailPush(a.id, { met: false, why: 'only 2 of the expected 6 confirmed' });
  ok(/NOT met/.test(I.touchBrief(I.get(a.id))), 'an unmet verdict rides the next brief');

  // --- the BOUNDED BITE contract (the 0-for-N MET fix: inquiry #1's write-back authored
  // "search all 64 parish websites" as next_step; no single run can clear that, so the honest
  // judge could never say MET — the sizing must live ON the schema line and in the brief) ---
  ok(/ONE BOUNDED bite/.test(I.WRITEBACK_WANT) && /NEVER the whole remaining work/.test(I.WRITEBACK_WANT),
    'WRITEBACK_WANT sizes next_step on the schema line itself (a schema-obedient model emits what the line shows)');
  ok(/DIFFERENT open lead/.test(I.WRITEBACK_WANT) && /failed twice/.test(I.WRITEBACK_WANT),
    'WRITEBACK_WANT pivots off a twice-failed step (live: the SoS Excel re-pinned 6 touches, 0 evidence)');
  ok(/CARRY FORWARD/.test(I.WRITEBACK_WANT) && /stays completed/.test(I.WRITEBACK_WANT),
    'WRITEBACK_WANT: the standing summary accretes — the rolling rewrite ate 64/64 presidents live (the meeting-notes disease, inquiry edition)');
  ok(/ONE bounded run/.test(I.touchBrief(I.get(a.id))) && /next concrete bite/.test(I.touchBrief(I.get(a.id))),
    'the touch brief tells the run to take a bite, not the whole remainder');

  // --- close: answered lands the artifact; dead-end does not ---
  const landed = [];
  const c1 = I.close(a.id, { kind: 'answered', answer: 'Nine states have standing AI task forces; chairs listed in the evidence trail.', deps: { land: (d) => { landed.push(d); return { id: 42, landed: true }; } }, nowMs: NOW + 3000 });
  ok(c1.closed && c1.status === 'closed_answered' && c1.docId === 42, 'an answered close lands the artifact');
  ok(landed[0].source === 'inquiry' && /## Question/.test(landed[0].body) && /## Answer/.test(landed[0].body) && /Texas/.test(landed[0].body),
    'the artifact carries question + answer + the full evidence trail');
  const d1 = I.open({ question: 'A doomed question that cannot actually be answered, yes?', nowMs: NOW + 4000 });
  const c2 = I.close(d1.id, { kind: 'dead_end', deps: { land: (d) => { landed.push(d); return { id: 43 }; } }, nowMs: NOW + 5000 });
  ok(c2.closed && c2.status === 'closed_dead_end' && landed.length === 1, 'a dead-end closes honestly and lands NO artifact');

  // --- manifest lines ---
  const lines = I.manifestLines({ nowMs: NOW + 6000 });
  ok(lines.some((l) => /\[inquiry #\d+\]/.test(l)), 'manifest lines carry the [inquiry #N] machine token');
  ok(lines.some((l) => /parked — reopenable/.test(l)), 'parked lines stay visible as reopenable');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
