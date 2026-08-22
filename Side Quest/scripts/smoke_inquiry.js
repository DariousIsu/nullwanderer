/* Smoke: lib/inquiry — LINES OF INQUIRY (catalog O0, slice 4). Deterministic: temp SQ_DB_PATH,
 * injected land. Proves the continuity contract: each touch starts where the last stopped.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_inquiry.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const TMPDIR = path.join(os.tmpdir(), `sq_inq_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
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
    // FOLLOW-UP ≠ DUPLICATE (live 08-22 15:19: Lucas's scope-add refused as a near-duplicate of a
    // CLOSED jobs dig while her say claimed "adding those to the dig")
    const follow = I.open({ question: 'What were the ratepayer impacts from the Gulf pipeline incident?', nowMs: NOW + 205 });
    ok(follow.id != null && !follow.duplicate, '⭐ THE LIVE SCOPE-ADD: a closed twin + ≥2 novel tokens (ratepayer, impacts) opens as a NEW inquiry, never a silent refusal');
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

  // --- CLOSE NUDGE (boot73: #1 ran 25 touches, never closed even with the answer in-graph) ---
  ok(!/FIRST-CLASS outcome/.test(I.touchBrief({ id: 9, question: 'x'.repeat(20), touches: 2, evidence: '[{"gist":"a"}]' })),
    'close nudge stays SILENT early (touch 2) — do not push a young line to close');
  ok(!/FIRST-CLASS outcome/.test(I.touchBrief({ id: 9, question: 'x'.repeat(20), touches: 8, evidence: '[]' })),
    'close nudge stays SILENT with no evidence (nothing to close ON), however many touches');
  ok(/FIRST-CLASS outcome/.test(I.touchBrief({ id: 9, question: 'x'.repeat(20), touches: 6, evidence: '[{"gist":"real finding","cite":"doc #8443"}]' })),
    'close nudge FIRES on a well-worn line (touch 6) that holds real evidence — answered beats a 12th continue');

  // --- ACCESS HINT (§5: learned door-order for sites the inquiry references reaches the touch) ---
  {
    const fakeSL = {
      hostOf: (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } },
      accessLine: (h) => h === 'voterportal.sos.la.gov' ? 'voterportal.sos.la.gov: browser ✗ · vision ✓ · JS shell needed' : null,
    };
    const withUrl = { id: 7, question: 'x'.repeat(20), touches: 2, next_step: 'open https://voterportal.sos.la.gov/candidates and read', open_leads: '[]', evidence: '[]' };
    const ah = I.accessHint(withUrl, { deps: { siteLedger: fakeSL } });
    ok(/voterportal\.sos\.la\.gov/.test(ah) && /vision ✓/.test(ah) && /try the doors/i.test(ah), 'accessHint: surfaces the learned door-order for a host the inquiry references');
    ok(I.accessHint({ id: 8, question: 'x'.repeat(20), touches: 1, next_step: 'think about the parishes', open_leads: '[]', evidence: '[]' }, { deps: { siteLedger: fakeSL } }) === '', 'accessHint: no URL in the row → empty');
    ok(I.accessHint({ id: 9, question: 'x'.repeat(20), touches: 1, next_step: 'open https://never-seen.example/x', open_leads: '[]', evidence: '[]' }, { deps: { siteLedger: fakeSL } }) === '', 'accessHint: a host with no learned profile → empty');
  }

  // --- HELD-SOURCE HINT (boot73: #1 planned to re-download a roster it already held+decomposed) ---
  {
    const doc = db.insertDocument({ title: 'LA-parish-officials-2026.xls', body: 'Parish,Office,Name\nCaddo,Sheriff,Henry Whitehorn\nOrleans,Clerk,Chelsey Napoleon', source: 'browser_download' });
    // decomposed: give it an encounter
    try { require('../lib/encounters').record({ object_type: 'gov', object_label: 'Caddo Sheriff', claim_class: 'existence', source_kind: 'document', source_ref: `doc:${doc.id}`, origin_host: 'x', content_hash: 'h' }); } catch {}
    const hint = I.heldSourceHint({ next_step: 'Retrieve the LA-parish-officials-2026.xls file via its direct download URL and extract the missing rows', gist: '', evidence: '[]' }, { deps: { db } });
    ok(hint && new RegExp(`doc #${doc.id}`).test(hint) && /ALREADY HOLD THE ANSWER SOURCE/.test(hint) && /decomposed/.test(hint),
      'heldSourceHint: a named file that is already a landed+decomposed doc → "you already hold the answer source"');
    ok(hint && /Henry Whitehorn/.test(hint) && /Chelsey Napoleon/.test(hint) && /CLOSE ANSWERED/.test(hint),
      'heldSourceHint: INJECTS the doc content into the brief (touch 27 ignored a pointer — the rows must be impossible to miss) + steers to close');
    // TABLE STRUCTURE, not a raw head (boot76: the roster's first rows are party-committee NOISE, not
    // the parish sheriffs — inject the office-title counts + "break down the WHOLE document").
    const tbl = ['## Officials', '| Office Title | Parish | Name |', '| --- | --- | --- |',
      '| Sheriff | Caddo | A |', '| Sheriff | Orleans | B |', '| Clerk of Court | Caddo | C |', '| DSCC Member | | D |'].join('\n');
    const tdoc = db.insertDocument({ title: 'roster-table.csv', body: tbl, source: 'browser_download' });
    const thint = I.heldSourceHint({ next_step: 'download roster-table.csv again', gist: '', open_leads: '[]', evidence: '[]' }, { deps: { db } });
    ok(thint && /It is a TABLE/.test(thint) && /Sheriff ×2/.test(thint) && /Clerk of Court ×1/.test(thint),
      'heldSourceHint: a TABLE doc → injects the office-title distribution (Sheriff ×2, …), not the raw head');
    ok(thint && /break it ALL down/.test(thint) && /do not cherry-pick/.test(thint),
      'heldSourceHint: instructs to break down the WHOLE document, not discard the rows this inquiry doesn\'t need (Lucas)');
    // EXTRACT-AND-INJECT (boot80): a roster-shaped table (Parish/Office Title/Candidate Name, ≥3
    // parishes) → the hint EXTRACTS the grouped answer and injects it with "present + close", instead
    // of telling the operator to "query your copy" (which produced a SQL query expect kept rejecting).
    const roster = ['| Office Title | Parish | Candidate Name |', '| --- | --- | --- |',
      '| Sheriff | Acadia | Al Adams |', '| Police Juror | Acadia | Bo Best |', '| Sheriff | Allen | Cy Cole |',
      '| Parish President | Ascension | Di Doe |', '| Sheriff | Ascension | Ed Eng |', '| DSCC Member | | Party Person |'].join('\n');
    const rdoc = db.insertDocument({ title: 'LA-roster-full.csv', body: roster, source: 'browser_download' });
    const rhint = I.heldSourceHint({ id: 4242, next_step: 'download LA-roster-full.csv again', gist: '', open_leads: '[]', evidence: '[]' }, { deps: { db } });
    ok(rhint && /THE ANSWER/.test(rhint) && /groups \(by Parish\)/.test(rhint) && new RegExp(`doc #${rdoc.id}`).test(rhint),
      'heldSourceHint: a roster table → EXTRACTS the grouped answer (not a structure summary)');
    ok(rhint && /Al Adams/.test(rhint) && /Di Doe/.test(rhint) && !/Party Person/.test(rhint),
      'heldSourceHint: injected answer carries the real names, party-committee row excluded');
    ok(rhint && /PRESENT this/.test(rhint) && /CLOSE ANSWERED/.test(rhint) && /SQL query.*is NOT the deliverable/.test(rhint) && !/It is a TABLE/.test(rhint),
      'heldSourceHint: steers to PRESENT+CLOSE and explicitly rejects "a SQL query" (the touch-30 failure) — not the old summary');
    // HELD-SOURCE EXHAUSTED → force close (boot80, the expect-bar-drift fix): a worn line holding a
    // COMPLETE extracted answer closes even when the write-back never conceded "answered".
    db.setMeta('inquiry.777.held_answer', JSON.stringify({ text: '- **ACADIA**: Sheriff — K.P. Gibson\n- **ALLEN**: Sheriff — Doug Hebert\n- **ASCENSION**: Parish President — Clint Cointment', groups: 3, groupCol: 'Parish' }));
    ok(I.heldAnswerExhausted({ id: 777, status: 'active', touches: 5 }, { deps: { db } }) === true, 'heldAnswerExhausted: worn line (≥4 touches) + a pinned complete answer → force-close');
    ok(I.heldAnswerExhausted({ id: 777, status: 'active', touches: 2 }, { deps: { db } }) === false, 'heldAnswerExhausted: a young line is NOT force-closed (room to work first)');
    ok(I.heldAnswerExhausted({ id: 888, status: 'active', touches: 9 }, { deps: { db } }) === false, 'heldAnswerExhausted: no pinned answer → no force-close (never invents a close)');
    ok(I.heldAnswerExhausted({ id: 777, status: 'closed_answered', touches: 9 }, { deps: { db } }) === false, 'heldAnswerExhausted: an already-closed line is never re-closed');
    ok(/ASCENSION/.test(I.heldAnswerText(777, { deps: { db } }) || ''), 'heldAnswerText: returns the extracted digest as the close answer');
    ok(I.heldSourceHint({ next_step: 'Search Ballotpedia for the Ohio governor race results', gist: '', evidence: '[]' }, { deps: { db } }) === null,
      'heldSourceHint: no file named / nothing held → silent (no false hint)');
    ok(I.heldSourceHint({ next_step: 'Download unheld-roster-9999.csv from the county site', gist: '', evidence: '[]' }, { deps: { db } }) === null,
      'heldSourceHint: a file we do NOT hold → silent (only fires on what she actually has)');
    // PIN: once discovered on a real inquiry (with an id), it re-fires even after the write-back
    // scrubs the filename from the text (boot74: the operator rewrote away every roster reference).
    const iq = I.open({ question: 'What are the LA parish officials for all 64 parishes across every office?', nowMs: NOW + 500 });
    db.setMeta(`inquiry.${iq.id}.held_source_doc`, '');   // start unpinned
    const rowNamed = { id: iq.id, next_step: 'Retrieve LA-parish-officials-2026.xls via its URL', gist: '', open_leads: '[]', evidence: '[]' };
    ok(/doc #/.test(I.heldSourceHint(rowNamed, { deps: { db } }) || ''), 'held-hint fires + PINS when the inquiry first names the held file');
    ok(db.getMeta(`inquiry.${iq.id}.held_source_doc`) === String(doc.id), '…and the held source is now pinned to the inquiry');
    const rowScrubbed = { id: iq.id, next_step: 'Access the Louisiana Police Jury Association site and scrape presidents', gist: 'presidents complete', open_leads: '[]', evidence: '[]' };
    ok(/doc #/.test(I.heldSourceHint(rowScrubbed, { deps: { db } }) || ''), 'PIN survives: the hint re-fires even after the text no longer names the file (the fragility fix)');
  }

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
