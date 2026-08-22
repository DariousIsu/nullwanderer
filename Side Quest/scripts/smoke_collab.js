'use strict';
/* smoke_collab.js — the collaboration register (lib/collab.js) + its four main.js gates.
 * Born from the blind week's first catch (2026-08-20 night): Lucas's brainstorm/feedback turns
 * routed task/lookup, drew "let me get that going", and delivered artifacts — including a stale
 * harness artifact — instead of thinking with him. The verbatim live turns are the regressions. */
const path = require('path'), os = require('os');
process.env.SQ_DB_PATH = process.env.SQ_DB_PATH || path.join(os.tmpdir(), `sq_collab_${process.pid}`, 'sq.db');
const cl = require('../lib/collab');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── the register net: the live misses, verbatim ─────────────────────────────────────────────────
ok(cl.isCollabTurn("We're brainstorming here, I need ideas"), 'LIVE REGRESSION: "We\'re brainstorming here, I need ideas"');
ok(cl.isCollabTurn('Hey Zo, can you read this for me and help me come up with some ideas for it.'), 'LIVE REGRESSION: "help me come up with some ideas"');
ok(cl.isCollabTurn('give me feedback on the intro — does the polling bridge land?'), 'a feedback ask is collab');
ok(cl.isCollabTurn('what do you think of the second section?'), 'what-do-you-think is collab');
ok(cl.isCollabTurn('your read on the Entergy angle?'), 'your-read-on is collab');
ok(cl.isCollabTurn("let's think through the closer together"), 'let\'s-think is collab');
ok(cl.isCollabTurn('poke holes in this argument for me'), 'poke-holes is collab');
ok(cl.isCollabTurn('bounce some ideas around with me on the framing'), 'bounce-ideas is collab');
ok(cl.isCollabTurn('Hey Zo, a couple of days ago we started getting together a list of all the anti china bills, remember?'), 'LIVE REGRESSION (blind-week #2): a memory-check gets RECOGNITION, never a placement offer');
ok(cl.isCollabTurn('do you remember the Hartfield work?'), 'do-you-remember is a recognition turn');
ok(!cl.isCollabTurn('remember to send the sheet tomorrow'), 'a reminder-order is NOT a memory check');

// ── the net stays out of the order road ─────────────────────────────────────────────────────────
ok(!cl.isCollabTurn('Post a short two-item overview on the canvas.'), 'a placement order is NOT collab');
ok(!cl.isCollabTurn('Sometime today, put together a short digest of parish road-project announcements.'), 'a deferred deliverable order is NOT collab');
ok(!cl.isCollabTurn('Who is Clay Schexnayder?'), 'a lookup is NOT collab');
ok(!cl.isCollabTurn('finish the paper on applied digital'), 'the finalize verb is NOT collab');
ok(!cl.isCollabTurn('ok'), 'a bare ack is NOT collab');

// ── the carve-out: an explicit destination keeps artifacts allowed ──────────────────────────────
ok(cl.artifactsAllowed('brainstorm headline options and put the list on the canvas'), 'a named canvas destination allows artifacts');
ok(cl.artifactsAllowed('kick ideas around and save them to notes when we land'), 'a save order allows artifacts');
ok(!cl.artifactsAllowed("We're brainstorming here, I need ideas"), 'no destination named → artifacts suppressed');
ok(!cl.artifactsAllowed('give me feedback on the doc'), 'mentioning "the doc" as SUBJECT is not a destination');

// ── the directive pins the register ─────────────────────────────────────────────────────────────
const d = cl.directive();
ok(/IN THIS REPLY/.test(d) && /Do NOT create or edit any artifact/.test(d) && /let me get that going/.test(d), 'the directive pins ideas-in-reply and bans the deflection phrases');

// ── grounding: session-named docs + FTS matches, bounded, fail-empty ────────────────────────────
{
  const db = require('../lib/db'); db.init();
  const sid = db.startSession();
  const doc = db.insertDocument({ title: 'LA Data Centers Op-Ed draft', body: 'The polling intro shows voters care about jobs, bills, taxes. The Entergy agreement and the Meta facility deal deliver exactly those: local hiring floors, rate protections, parish tax shares.', source: 'smoke', origin: null });
  db.insertTurn({ sessionId: sid, speaker: 'ai_said', content: `Got it — doc#${doc.id}, the op-ed. Looking at the bridge.`, model: 'smoke' });
  const gb = cl.groundingBlock({ sessionId: sid, text: 'help me sharpen the transition from the polling intro to the agreements' });
  ok(gb && new RegExp(`doc#${doc.id}`).test(gb) && /Entergy/.test(gb), 'grounding pulls the session-named doc with a real excerpt');
  ok(gb && /think WITH this/.test(gb) && gb.length < 2600, 'the block is framed for thinking and bounded');
  ok(cl.groundingBlock({ sessionId: 999999991, text: 'zzqx unmatchable terms qqzz' }) === null, 'nothing matched → null (fail-empty, no fabricated grounding)');

  // ── recall mode: held-source homecoming (the run-8 residual) ──────────────────────────────────
  const sheet = db.insertDocument({ title: 'Anti-China 2026 sponsors sheet', body: 'LA SB200 co-sponsors, Senate: Allain, Barrow, Cathey, Selders (D-14, died 2026-07-07), Stine, Womack. The Selders co-sponsorship predates his death.', source: 'smoke-sheet', origin: null });
  db.syncDocumentsFts();   // the index backfills on a tick in production — sync so FTS is the path under test
  const rb = cl.groundingBlock({ sessionId: 0, text: 'whose name is on the SB200 co-sponsorship we tracked down?', mode: 'recall' });
  ok(rb && new RegExp(`doc#${sheet.id}`).test(rb) && /Selders/.test(rb), 'RUN-8 RESIDUAL: the SB200 question reaches the held sheet by FTS (Selders in the excerpt)');
  ok(rb && /Answer FROM these documents/.test(rb) && /NEVER fill the gap/.test(rb), 'the recall frame orders answer-from-held or honest-miss');

  // ── instance discipline (campaign §21a): the 2018 stranger never dominates a 2026 ask ──────────
  const stranger = db.insertDocument({ title: 'LA 2018 session archive — SB200 (Hewitt)', body: 'Louisiana 2018 regular session: SB200 by Hewitt, water infrastructure funding. Committee referrals and fiscal notes from the 2018 archive.', source: 'smoke-archive', origin: null });
  const wide = db.insertDocument({ title: 'MO SB2000 omnibus', body: 'Missouri SB2000 omnibus package covering unrelated transport items.', source: 'smoke-archive', origin: null });
  db.syncDocumentsFts();
  const rb2 = cl.groundingBlock({ sessionId: 0, text: 'what is the status of SB200 in the anti china sweep?', mode: 'recall' });
  ok(rb2 && rb2.indexOf(`doc#${wide.id}`) === -1, '⭐ a bill number is an IDENTIFIER: sb200 never matches SB2000 (the prefix-star widening is gone)');
  {
    const iSheet = rb2 ? rb2.indexOf(`doc#${sheet.id}`) : -1, iStr = rb2 ? rb2.indexOf(`doc#${stranger.id}`) : -1;
    ok(iSheet > -1 && (iStr === -1 || iSheet < iStr), '⭐ THE HEWITT SPECIMEN: the thread\'s instance (2026 anti-china) LEADS the fan — the 2018 SB200 never dominates');
  }
  ok(cl.groundingBlock({ sessionId: 0, text: 'any updates on SB20 anywhere?', mode: 'recall' }) === null, 'sb20 never rides INTO sb200 documents (no substring widening either direction)');

  // ── held-source homecoming: the notes deliverable IS the answer (the run-8 root, cured 08-22) ──
  const fs2 = require('fs');
  const ndir = path.join(os.tmpdir(), `sq_collab_notes_${process.pid}`);
  fs2.mkdirSync(path.join(ndir, '_test_residue'), { recursive: true });
  fs2.writeFileSync(path.join(ndir, 'anti_china_2026_sponsors.md'), '# Sponsors sheet\n\n| LA | SB200 | expropriation near military bases | Sen. Valarie Hodges | 35 co-sponsors incl. Larry Selders (D-14) died 2026-07-07 |\n');
  fs2.writeFileSync(path.join(ndir, 'grocery_list.md'), 'milk, eggs, bread');
  fs2.writeFileSync(path.join(ndir, '_test_residue', 'decoy.md'), 'SB200 sponsors china sweep decoy — harness residue, must never ride');
  const hb = cl.groundingBlock({ sessionId: 0, text: 'which senator co-sponsored SB200 in the china sweep?', mode: 'recall', _notesDir: ndir });
  ok(hb && /anti_china_2026_sponsors\.md/.test(hb) && /Selders/.test(hb), '⭐ THE HOMECOMING: the notes sheet rides the fan and its excerpt carries the ANSWER (Selders), never just the header');
  ok(hb && !/decoy/.test(hb), 'notes/_test_residue never rides (subdirectories excluded)');
  ok(hb && hb.indexOf('anti_china_2026_sponsors.md') < hb.indexOf(`doc#${sheet.id}`), 'the hand-built deliverable OUTRANKS doc-store matches');
  try { fs2.rmSync(ndir, { recursive: true, force: true }); } catch {}
}

// ── wiring: the four gates exist in main.js ─────────────────────────────────────────────────────
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/\[collab\] collaboration register — thinking-together turn/.test(src), 'wiring: the door logs (directive + grounding injected)');
  ok(/\[collab\] route override → converse/.test(src), 'wiring: the register outranks the route cascade');
  ok(/artifact-router \$\{verdict\.intent\} SUPPRESSED — thinking-together turn/.test(src) || /SUPPRESSED — thinking-together turn, no destination named/.test(src), 'wiring: the artifact-router hijack is gated');
  ok(/&& \(!collabTurn \|\| collabArtifactsOk\)/.test(src), 'wiring: canvas ownership and the booking backstop both respect the register');
  ok(/where \(\?\:are we\|do we stand\|did we \(\?\:get to\|land\|stop\|leave off\)\)/.test(src), 'wiring: the progress-check family reaches the held-source door (blind-week #3: "where are we on the sponsors")');
  // §21a second half: the bill-instance census door (the p102/p103 SB25-200-for-SB200 pick)
  ok(/BILL-INSTANCE CENSUS/.test(src) && /never silently pick one/.test(src) && /SB25-200 is not SB200/.test(src), 'wiring: a state-less bill ask censuses held instances — disambiguate or anchor, never silently pick');
  ok(/_bt\.length === 1 && \(\/\\\?\\s\*\$\//.test(src) || /_bt\.length === 1/.test(src), 'wiring: the census gates on a question-shaped, single-bill-token, state-less ask');
  ok(src.indexOf('BILL-INSTANCE CENSUS') > src.indexOf('[recall-reach] door failed'), 'wiring: the census door sits after the recall-reach door (both pre-reply)');
}

console.log(`\nsmoke_collab: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
