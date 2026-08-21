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
  const rb = cl.groundingBlock({ sessionId: 0, text: 'whose name is on the SB200 co-sponsorship we tracked down?', mode: 'recall' });
  ok(rb && new RegExp(`doc#${sheet.id}`).test(rb) && /Selders/.test(rb), 'RUN-8 RESIDUAL: the SB200 question reaches the held sheet by FTS (Selders in the excerpt)');
  ok(rb && /Answer FROM these documents/.test(rb) && /NEVER fill the gap/.test(rb), 'the recall frame orders answer-from-held or honest-miss');
}

// ── wiring: the four gates exist in main.js ─────────────────────────────────────────────────────
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/\[collab\] collaboration register — thinking-together turn/.test(src), 'wiring: the door logs (directive + grounding injected)');
  ok(/\[collab\] route override → converse/.test(src), 'wiring: the register outranks the route cascade');
  ok(/artifact-router \$\{verdict\.intent\} SUPPRESSED — thinking-together turn/.test(src) || /SUPPRESSED — thinking-together turn, no destination named/.test(src), 'wiring: the artifact-router hijack is gated');
  ok(/&& \(!collabTurn \|\| collabArtifactsOk\)/.test(src), 'wiring: canvas ownership and the booking backstop both respect the register');
}

console.log(`\nsmoke_collab: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
