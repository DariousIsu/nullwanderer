'use strict';
/* smoke_canvas_command.js — the explicit canvas-order detector (lib/canvas_command.js).
 * The live misses (#11104/#11108, 2026-08-07) are the load-bearing cases.
 * Run: node scripts/smoke_canvas_command.js */
const path = require('path');
const { detect, detectEdit, rejectEditOutput } = require(path.join(__dirname, '..', 'lib', 'canvas_command'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };

// ── the live misses — MUST fire ─────────────────────────────────────────────────────────────────
ok('live #11104 fires', !!detect('I want to clean up a project we have been working on off and on for the last couple of weeks. I want to slowly build the deliverable, so do each step one at a time. Step 1. Please Identify on a fresh canvas doc the name of every parish in Louisiana'));
ok('live #11108 fires', !!detect('Please print to the canvas so I can verify as we go'));
ok('"put the list on the canvas" fires', !!detect('put the list on the canvas'));
ok('"write it into a new canvas tab" fires', !!detect('write it into a new canvas tab'));
ok('"add those to my canvas doc" fires', !!detect('add those to my canvas doc'));

// ── non-orders and non-canvas — MUST NOT fire ───────────────────────────────────────────────────
ok('question about canvas does not fire', !detect("what's on the canvas right now?"));
ok('"can you see my canvas" does not fire', !detect('can you see my canvas?'));
ok('canvas mention without an order does not fire', !detect('the canvas is looking cluttered'));
ok('a report order without canvas stays with report-cmd', !detect('build the final report on the Hartfield Foundation'));
ok('plain chat does not fire', !detect('every parish in Louisiana has a police jury'));

// ── the EDIT half (live #11116-#11119: "convert the numbered list to bullets" got narration) ────
const fresh = { workingFresh: true }, stale = { workingFresh: false };
ok('edit: "convert the numbered list to bullets in the same document"', !!detectEdit('convert the numbered list to bullets in the same document', fresh));
ok('edit: "now add the parish seat next to each parish in the doc"', !!detectEdit('now add the parish seat next to each parish in the doc', fresh));
ok('edit: "step 2: number the list on the canvas"', !!detectEdit('step 2: number the list on the canvas', fresh));
ok('edit: bare "reorder it alphabetically"', !!detectEdit('reorder it alphabetically... the doc I mean', fresh) || !!detectEdit('reorder the list alphabetically', fresh));
ok('no working doc → edit NEVER fires', !detectEdit('convert the numbered list to bullets in the same document', stale));
ok('"a fresh canvas" routes to create, not edit', !detectEdit('start a fresh canvas doc for the contacts list', fresh) && !!detect('start a fresh canvas doc for the contacts list'));
ok('question about the doc does not edit', !detectEdit("what's on the canvas now?", fresh));
ok('plain chat with an edit verb but no doc ref does not fire', !detectEdit('add Russ to the invite thread', fresh));

// ── the PAYLOAD CONTRACT (live 08-08: narration stamped OVER the parish list, twice) ────────────
const parishDoc = Array.from({ length: 64 }, (_, i) => `Parish ${i + 1}`).join('\n');
ok('live ruin #1: narration paragraph rejected', !!rejectEditOutput('I need to understand what Lucas is asking for. His edit instruction is "Clean up the project" — but the current canvas content is just a paragraph. Let me check the pipeline documents.', parishDoc, 'Clean up the project we have been working on'));
ok('live ruin #2: "Let me…" deliberation rejected', !!rejectEditOutput('Let me check what the actual project document is before making changes.', parishDoc, 'Convert the document into a bulleted list'));
ok('"I\'ll gather…" process talk rejected', !!rejectEditOutput("I'll gather the parish government data first and then update the doc.", parishDoc, 'add government types'));
ok('unexplained 60%+ shrink rejected', !!rejectEditOutput('- Acadia Parish\n- Allen Parish', parishDoc, 'Convert the list into bullets'));
ok('shrink WITH a shrink instruction accepted', !rejectEditOutput('- Acadia Parish\n- Allen Parish', parishDoc, 'remove every parish except the first two'));
ok('"clean up" counts as a shrink instruction', !rejectEditOutput(parishDoc.split('\n').slice(0, 20).join('\n'), parishDoc, 'clean up the list'));
ok('a real converted doc is accepted', !rejectEditOutput(parishDoc.split('\n').map((l) => `- ${l}\n  - police jury government`).join('\n'), parishDoc, 'Convert the document into a bulleted list'));
ok('empty output rejected', !!rejectEditOutput('', parishDoc, 'bullet the list'));
ok('growth is always fine', !rejectEditOutput(parishDoc + '\nZavalla Parish', parishDoc, 'add the missing parish'));
// CREATE-door use (M6, 08-08 audit): empty cur disarms the shrink guard; narration still rejects.
ok('create: fresh doc with empty cur accepted', !rejectEditOutput('- Acadia Parish\n- Allen Parish', '', 'list the parishes'));
ok('create: narration with empty cur rejected', !!rejectEditOutput('Let me check the parish list first.', '', 'list the parishes'));

// ── pendingSubjects: the blanks BECOME the plan (08-08) ─────────────────────────────────────────
const { pendingSubjects } = require(path.join(__dirname, '..', 'lib', 'canvas_command'));
const planDoc = [
  '- **Acadia Parish**', '  - Police Jury form of government.', '  - Current officeholders: — (pending verification)',
  '- **Ascension Parish**', '  - Council-President government.', '  - Current officeholders: Clint Cointment (Parish President); others',
  '- **Allen Parish**', '  - Police Jury.', '  - Current officeholders: — (pending verification)',
].join('\n');
const pend = pendingSubjects(planDoc);
ok('pending entries extracted with subject + label', pend.length === 2 && pend[0].subject === 'Acadia Parish' && pend[0].label === 'Current officeholders' && pend[1].subject === 'Allen Parish');
ok('filled entries are NOT queued', !pend.some((p) => p.subject === 'Ascension Parish'));
ok('no pending marks → empty plan', pendingSubjects('- **X**\n  - all: done').length === 0 && pendingSubjects('').length === 0);

console.log(`smoke_canvas_command: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
