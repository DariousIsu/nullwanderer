'use strict';
/* smoke_collab.js — the collaboration register (lib/collab.js) + its four main.js gates.
 * Born from the blind week's first catch (2026-08-20 night): Lucas's brainstorm/feedback turns
 * routed task/lookup, drew "let me get that going", and delivered artifacts — including a stale
 * harness artifact — instead of thinking with him. The verbatim live turns are the regressions. */
const path = require('path'), os = require('os');
process.env.SQ_DB_PATH = process.env.SQ_DB_PATH || path.join(os.tmpdir(), `sq_collab_${process.pid}`, 'sq.db');
// Hermetic canvas store: groundingBlock's 2b source defaults to lib/canvas_docs — without this the
// pre-existing cases would read the REAL data/canvas_docs.db and couple the smoke to live content.
process.env.CANVAS_DOCS_DB_PATH = path.join(os.tmpdir(), `sq_collab_canvas_${process.pid}`, 'canvas.db');
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
  // HERMETIC NOTES (08-31: the early recall pins scanned the LIVE workspace notes — the gate went
  // red when a real note matched the ask's generics ("updates"+"anywhere" in the day's donor
  // report); an offline-deterministic suite must never depend on the day's workspace). Every
  // pre-homecoming call rides an isolated empty dir.
  const fsE = require('fs');
  const ndirEmpty = path.join(os.tmpdir(), `sq_collab_empty_${process.pid}`);
  fsE.mkdirSync(ndirEmpty, { recursive: true });
  const doc = db.insertDocument({ title: 'LA Data Centers Op-Ed draft', body: 'The polling intro shows voters care about jobs, bills, taxes. The Entergy agreement and the Meta facility deal deliver exactly those: local hiring floors, rate protections, parish tax shares.', source: 'smoke', origin: null });
  db.insertTurn({ sessionId: sid, speaker: 'ai_said', content: `Got it — doc#${doc.id}, the op-ed. Looking at the bridge.`, model: 'smoke' });
  const gb = cl.groundingBlock({ sessionId: sid, text: 'help me sharpen the transition from the polling intro to the agreements' , _notesDir: ndirEmpty });
  ok(gb && new RegExp(`doc#${doc.id}`).test(gb) && /Entergy/.test(gb), 'grounding pulls the session-named doc with a real excerpt');
  ok(gb && /think WITH this/.test(gb) && gb.length < 2600, 'the block is framed for thinking and bounded');
  ok(cl.groundingBlock({ sessionId: 999999991, text: 'zzqx unmatchable terms qqzz' , _notesDir: ndirEmpty }) === null, 'nothing matched → null (fail-empty, no fabricated grounding)');

  // ── recall mode: held-source homecoming (the run-8 residual) ──────────────────────────────────
  const sheet = db.insertDocument({ title: 'Anti-China 2026 sponsors sheet', body: 'LA SB200 co-sponsors, Senate: Allain, Barrow, Cathey, Selders (D-14, died 2026-07-07), Stine, Womack. The Selders co-sponsorship predates his death.', source: 'smoke-sheet', origin: null });
  db.syncDocumentsFts();   // the index backfills on a tick in production — sync so FTS is the path under test
  const rb = cl.groundingBlock({ sessionId: 0, text: 'whose name is on the SB200 co-sponsorship we tracked down?', mode: 'recall' , _notesDir: ndirEmpty });
  ok(rb && new RegExp(`doc#${sheet.id}`).test(rb) && /Selders/.test(rb), 'RUN-8 RESIDUAL: the SB200 question reaches the held sheet by FTS (Selders in the excerpt)');
  ok(rb && /Answer FROM these documents/.test(rb) && /NEVER fill the gap/.test(rb), 'the recall frame orders answer-from-held or honest-miss');

  // ── instance discipline (campaign §21a): the 2018 stranger never dominates a 2026 ask ──────────
  const stranger = db.insertDocument({ title: 'LA 2018 session archive — SB200 (Hewitt)', body: 'Louisiana 2018 regular session: SB200 by Hewitt, water infrastructure funding. Committee referrals and fiscal notes from the 2018 archive.', source: 'smoke-archive', origin: null });
  const wide = db.insertDocument({ title: 'MO SB2000 omnibus', body: 'Missouri SB2000 omnibus package covering unrelated transport items.', source: 'smoke-archive', origin: null });
  db.syncDocumentsFts();
  const rb2 = cl.groundingBlock({ sessionId: 0, text: 'what is the status of SB200 in the anti china sweep?', mode: 'recall' , _notesDir: ndirEmpty });
  ok(rb2 && rb2.indexOf(`doc#${wide.id}`) === -1, '⭐ a bill number is an IDENTIFIER: sb200 never matches SB2000 (the prefix-star widening is gone)');
  {
    const iSheet = rb2 ? rb2.indexOf(`doc#${sheet.id}`) : -1, iStr = rb2 ? rb2.indexOf(`doc#${stranger.id}`) : -1;
    ok(iSheet > -1 && (iStr === -1 || iSheet < iStr), '⭐ THE HEWITT SPECIMEN: the thread\'s instance (2026 anti-china) LEADS the fan — the 2018 SB200 never dominates');
  }
  ok(cl.groundingBlock({ sessionId: 0, text: 'any updates on SB20 anywhere?', mode: 'recall' , _notesDir: ndirEmpty }) === null, 'sb20 never rides INTO sb200 documents (no substring widening either direction)');
  // THE IDENTIFIER GATE (08-31 live: the day's real donor note matched "updates"+"anywhere" — two
  // generics reached the ≥2 floor while SB20 matched NOTHING, and the gate went red on the live
  // workspace). An ask carrying a bill identifier never grounds a note that lacks it.
  {
    const gdir = path.join(os.tmpdir(), `sq_collab_gen_${process.pid}`);
    fsE.mkdirSync(gdir, { recursive: true });
    fsE.writeFileSync(path.join(gdir, 'donor_note.md'), 'No contributions broken down by amount anywhere in the materials. Updates pending review of the ledger.');
    ok(cl.groundingBlock({ sessionId: 0, text: 'any updates on SB20 anywhere?', mode: 'recall', _notesDir: gdir }) === null,
      '⭐ identifier gate: generic tokens (updates/anywhere) never substitute for the bill number a note lacks (the sixth organ of the single-token disease)');
    try { fsE.rmSync(gdir, { recursive: true, force: true }); } catch {}
  }

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

  // ── THE NOTES-SCAN CAP CURE (Phase-3 finding, 08-26 live) ──────────────────────────────────────
  // The notes dir grew to 2400+ files; the old slice(0,300) left ~87% of held deliverables UNSCANNED,
  // so recall surfaced whatever early-alphabetical file matched and the driver flagged "no held paper
  // exists" of a doc she HOLDS. The read set is now filename-matchers ∪ the newest-N — reachable at any
  // position, bounded cost. contract-*.md OUTPUTS are excluded so a re-run never cites its own artifact.
  const bigdir = path.join(os.tmpdir(), `sq_collab_big_${process.pid}`);
  fs2.mkdirSync(bigdir, { recursive: true });
  // Target A: descriptive filename, written FIRST (oldest → NOT in newest-N) + alphabetically LAST →
  // only the filename-hit path (all filenames considered) can reach it.
  fs2.writeFileSync(path.join(bigdir, 'zzz_sasquatch_habitat_survey.md'), '# Sasquatch Habitat Survey\nField notes on sasquatch habitat ranges across the Cascade bioregion, 2026.');
  for (let i = 1; i <= 315; i++) fs2.writeFileSync(path.join(bigdir, `decoy_${String(i).padStart(4, '0')}.md`), `filler note ${i} about turnpike tolls and zoning variances`);
  fs2.writeFileSync(path.join(bigdir, 'contract-sasquatch-summary.md'), '# contract\nsasquatch habitat survey cascade — a contract OUTPUT, must never outrank the source');
  // Target B: opaque filename, written LAST (newest) → only the newest-N path can reach it.
  fs2.writeFileSync(path.join(bigdir, 'misc_0007.md'), 'a distinctive flibbertigibbet protocol governing zangief calibration cycles');
  const capA = cl.groundingBlock({ sessionId: 0, text: 'sasquatch habitat survey cascade', mode: 'recall', _notesDir: bigdir });
  ok(capA && /zzz_sasquatch_habitat_survey/.test(capA), '⭐ THE CAP CURE: a descriptive source beyond the old 300-file window is surfaced (all filenames considered)');
  ok(capA && !/contract-sasquatch/.test(capA), 'a contract-*.md OUTPUT is excluded — a re-run never cites its own artifact over the source');
  const capB = cl.groundingBlock({ sessionId: 0, text: 'flibbertigibbet zangief protocol', mode: 'recall', _notesDir: bigdir });
  ok(capB && /misc_0007/.test(capB), 'an opaque-named but RECENT source is surfaced via the newest-N read set');
  try { fs2.rmSync(bigdir, { recursive: true, force: true }); } catch {}

  // ── the canvas homecoming (contract-agent slice 0, 08-22): her canvas docs ground recall ──────
  // Live-proven blindness: an external session searched "Delta Forge", honest-missed, and re-bought
  // the research while the community_benefits_la compilation sat in canvas_docs.
  const fakeCanvas = {
    listDocs: () => [
      { tabKey: 'creations', mode: 'ILLUSTRATIVE', title: 'Zoe art', updatedAt: 3 },
      { tabKey: 'community_benefits_la', mode: 'DOC', title: 'Community Benefits: Meta & Applied Digital in Louisiana', updatedAt: 2 },
      { tabKey: 'directed-9999', mode: 'RESEARCH', title: 'Directed research', updatedAt: 1 },
    ],
    docText: (k) => k === 'community_benefits_la'
      ? 'META HYPERION RICHLAND PARISH: 7,500 construction jobs. Applied Digital Delta Forge in Rapides Parish, waterless cooling, Entergy and Cleco commitments.'
      : (k === 'creations' ? 'delta forge applied digital painting sketch' : 'unrelated directed notes about turnpike tolls'),
  };
  const cnope = path.join(os.tmpdir(), `sq_collab_nonotes_${process.pid}`);
  const cb = cl.groundingBlock({ sessionId: 0, text: 'what do we already have on the Delta Forge applied digital campus?', mode: 'recall', _canvasStore: fakeCanvas, _notesDir: cnope });
  ok(cb && /community_benefits_la/.test(cb) && /Delta Forge/.test(cb), '⭐ THE CANVAS HOMECOMING: her canvas compilation grounds the recall (the external session honest-missed exactly this)');
  ok(cb && /YOUR canvas/.test(cb), 'the canvas source is labeled as her own work');
  ok(cb && !/painting sketch/.test(cb), 'ILLUSTRATIVE tabs never ground an answer');
  const cb2 = cl.groundingBlock({ sessionId: 0, text: 'zzqx unmatchable qqzz terms', mode: 'recall', _canvasStore: fakeCanvas, _notesDir: cnope });
  ok(cb2 === null, 'no term match → the canvas source stays silent (fail-empty)');
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
