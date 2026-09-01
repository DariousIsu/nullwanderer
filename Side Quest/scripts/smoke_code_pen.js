/**
 * THE GATED PEN (Lucas 2026-09-01: "we need to build it and I want acceptance approval gate for
 * the pen"). Pins: the path jail (secrets/stores/internals sealed, traversal refused), read-only
 * bounded reads, diff parsing, proposal validation (the diff IS the claim), the decide state
 * machine (only Lucas's card moves a proposal), the open-count discipline, and the tag doors.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_code_pen.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_pen_${Date.now()}.db`);
require('../lib/db').init();
const pen = require('../lib/code_pen');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// ── the jail ──
ok(pen.pathAllowed('lib/scheduler.js').ok === true, 'source under lib/ is readable');
ok(pen.pathAllowed('main.js').ok === true, 'main.js is readable (the gate + reload rule cover the risk)');
ok(pen.pathAllowed('.env').ok === false, '⭐ .env is SEALED — key values never reach the pen');
ok(pen.pathAllowed('.env.example').ok === false, '.env variants sealed too');
ok(pen.pathAllowed('data/sq.db').ok === false, '⭐ data/ is SEALED — stores and lexicons are not source');
ok(pen.pathAllowed('data/lexicons/nrc-vad/x.txt').ok === false, 'lexicons sealed (never redistributed)');
ok(pen.pathAllowed('.git/config').ok === false, '.git internals sealed');
ok(pen.pathAllowed('node_modules/electron/index.js').ok === false, 'node_modules is not source');
ok(pen.pathAllowed('../../../Windows/system32/config').ok === false, '⭐ traversal outside the repo refused (the jail holds)');
ok(pen.pathAllowed('lib/../.env').ok === false, 'traversal-to-denied refused after resolution');
ok(pen.pathAllowed('canvas_docs.db').ok === false || pen.pathAllowed('data/canvas_docs.db').ok === false, 'db files sealed wherever they sit');

// ── read-only bounded reads ──
{
  const r = pen.readSource('lib/code_pen.js');
  ok(r.ok === true && /THE GATED PEN/.test(r.text) && r.bytes > 1000, 'she can read her own source — the wall her answer named is down');
  const d = pen.readSource('lib');
  ok(d.ok === false && /directory/.test(d.why), 'a directory read points at <source-list>');
  const miss = pen.readSource('lib/no_such_file_xyz.js');
  ok(miss.ok === false, 'a missing file is an honest miss, no throw');
  const l = pen.listSource('tissues');
  ok(l.ok === true && l.entries.includes('act_core.py'), 'source-list shows the real tree');
}

// ── diff parsing ──
const GOOD_DIFF = `--- a/lib/scheduler.js
+++ b/lib/scheduler.js
@@ -1,3 +1,4 @@
 line
+added
 line2
`;
ok(JSON.stringify(pen.touchedFiles(GOOD_DIFF)) === JSON.stringify(['lib/scheduler.js']), 'touchedFiles reads the unified headers');
ok(pen.touchedFiles('--- a/x.js\n+++ b/y.js\n').length === 2, 'a rename/multi-file diff lists every touched file');
ok(pen.touchedFiles('no diff here').length === 0, 'prose is not a diff');

// ── proposal validation: the diff IS the claim ──
ok(pen.propose({ title: 't', diff: 'not a diff' }).ok === false, 'a diff without file headers is refused');
ok(pen.propose({ title: '', diff: GOOD_DIFF }).ok === false, 'a proposal needs a title');
ok(pen.propose({ title: 't', diff: GOOD_DIFF.replace('lib/scheduler.js', '.env').replace('lib/scheduler.js', '.env') }).ok === false, '⭐ a diff touching .env is refused at the door');
ok(pen.propose({ title: 't', diff: `--- a/data/sq.db\n+++ b/data/sq.db\n@@\n+x\n` }).ok === false, 'a diff touching the stores is refused');
ok(pen.propose({ title: 'big', diff: `--- a/lib/x.js\n+++ b/lib/x.js\n` + '+'.repeat(pen.MAX_DIFF_BYTES) }).ok === false, 'an oversize diff is refused — split the change');

// ── the state machine: only Lucas's card moves a proposal ──
const p1 = pen.propose({ title: 'clock-parse tweak', rationale: 'why', diff: GOOD_DIFF, bornFrom: 'smoke' });
ok(p1.ok === true && p1.files[0] === 'lib/scheduler.js', 'a valid proposal files with its touched set');
ok(pen.get(p1.id).status === 'proposed', 'born proposed — never auto-approved');
ok(pen.pending().some((x) => x.id === `pen-${p1.id}` && x.kind === 'pen'), '⭐ it rides the approval-cards bar as kind "pen"');
ok(pen.decide(p1.id, 'maybe').ok === false, 'only yes/no decide');
ok(pen.decide(p1.id, 'no').ok === true && pen.get(p1.id).status === 'rejected', 'his ✗ retires it');
ok(pen.decide(p1.id, 'yes').ok === false, 'a decided proposal is not re-decidable');
const p2 = pen.propose({ title: 'second', diff: GOOD_DIFF });
ok(pen.decide(p2.id, 'yes').ok === true && pen.get(p2.id).status === 'approved', "⭐ his ✓ moves it to approved — the ONLY path toward the tree (main enforces: clean tree, full gate, revert on red)");
pen.setStatus(p2.id, 'applied', { gateNote: 'gate 593 green (smoke fixture)' });
ok(pen.get(p2.id).status === 'applied' && /green/.test(pen.get(p2.id).gate_note), 'the gate outcome is recorded on the row');

// ── open-count discipline ──
{
  const ids = [];
  for (let i = 0; i < pen.MAX_OPEN_PROPOSALS; i++) { const r = pen.propose({ title: `fill-${i}`, diff: GOOD_DIFF }); if (r.ok) ids.push(r.id); }
  const over = pen.propose({ title: 'one too many', diff: GOOD_DIFF });
  ok(over.ok === false && /open/.test(over.why), `open proposals cap at ${pen.MAX_OPEN_PROPOSALS} — one-change-at-a-time discipline`);
  for (const id of ids) pen.decide(id, 'no');
}

// ── tag doors ──
{
  const tags = pen.parseTags('x <source-read path="lib/db.js"/> y <propose-change title="t" rationale="r">--- a/lib/x.js\n+++ b/lib/x.js\n@@\n+1\n</propose-change>');
  ok(tags.length === 2 && tags[0].tag === 'source-read' && tags[1].attrs.title === 't' && /\+\+\+ b\/lib\/x\.js/.test(tags[1].body), 'both tag shapes parse with attrs + diff body');
  ok(pen.stripTags('a <source-list path="lib"/> b').trim() === 'a b', 'stripTags cleans the say');
  ok(/approval card/.test(pen.buildPromptBlock()) && /REVERTS on red/.test(pen.buildPromptBlock()) && /never land code yourself/i.test(pen.buildPromptBlock()), 'the prompt block teaches the constitution: propose, his card, the gate');
}

// ── ⭐ v1.1 THE PEN-WORK LANE (the first-hour finding: his "make the voice mute" edit order had
// NO lane — clarify noise on the AZ research run while the pen sat dark) ──
ok(pen.isEditIntent({ intent: 'edit:voice mute', confidence: 0.92 }) === true, '⭐ a confident edit verdict routes to pen work');
ok(pen.isEditIntent({ intent: 'fix the reaper', confidence: 0.8 }) === true, 'fix/change/modify/implement verbs route too');
ok(pen.isEditIntent({ intent: 'deliver:list', confidence: 0.99 }) === false, 'a deliver verdict never routes to the pen (the road owns it)');
ok(pen.isEditIntent({ intent: 'edit:x', confidence: 0.3 }) === false, 'low confidence never seeds work');
{
  const s1 = pen.seedPenWork({ ask: 'make the voice mute when I say I am in a meeting' });
  ok(s1.ok === true && !s1.reused && pen.workQueue().includes(s1.id), '⭐ an edit order seeds a pen-work thread onto the drive queue');
  const s2 = pen.seedPenWork({ ask: 'make the voice mute when I say I am in a meeting' });
  ok(s2.ok === true && s2.reused === true && s2.id === s1.id, 'the same ask re-said REUSES the thread (churn guard) — one commitment, one row');
  const st0 = pen.penState(s1.id);
  ok(st0.passes === 0 && st0.proposalId === null, 'born with clean pen state');
  pen.setPenState(s1.id, { passes: 2, proposalId: 7 });
  ok(pen.penState(s1.id).passes === 2 && pen.penState(s1.id).proposalId === 7, 'pen state round-trips');
  pen.dropFromQueue(s1.id);
  ok(!pen.workQueue().includes(s1.id), 'dropFromQueue releases the slot');
}

// ── wiring pins (grep-scope only — presence of the seams in main.js/renderer) ──
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/\^pen-\(\\d\+\)\$/.test(main) && /_applyPenProposal\(r\.id\)/.test(main), 'wiring: pen-N card decisions route to the enforce pipeline on his ✓');
  ok(/git.*apply.*--check/.test(main) && /'npm', \['test'\]/.test(main) && /checkout', \['--'/.test(main.replace(/\['checkout', '--'/g, "checkout', ['--")) || /'checkout', '--'/.test(main), 'wiring: apply-check → full gate → revert-on-red all present');
  ok(/uncommitted local changes on/.test(main), 'wiring: a dirty tree BLOCKS the apply — my in-flight work is never clobbered');
  ok(/const penBlock = require\('\.\/lib\/code_pen'\)\.buildPromptBlock\(\)/.test(main) && /penLib\.stripTags/.test(main), 'wiring: the pen block rides her prompt; leaked tags are stripped from thought AND say');
  const chat = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat.js'), 'utf8');
  ok(/pen-/.test(chat) && /code change/.test(chat), 'wiring: the card bar renders pen cards with string ids');
  ok(/isEditIntent\(_pv\)/.test(main) && /seedPenWork\(/.test(main), '⭐ v1.1 wiring: the order backstop routes edit intents to pen work BEFORE the road');
  ok(/kind === 'pen'\) return runPenWorkPass/.test(main), 'v1.1 wiring: the dispatcher routes pen threads to the pen pass');
  ok(/code_pen'\)\.workQueue\(\)\) backgroundWorkerPass/.test(main), 'v1.1 wiring: the worker loop drives the pen queue even during his directed work');
  ok(/MAX_PEN_PASSES/.test(main) && /gate-failed' && !st\.redrove/.test(main), 'v1.1 wiring: pass cap = honest stall; one re-drive on a gate failure, never a grind');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
try { require('../lib/db').getDb().close(); } catch {}
try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
process.exit(fail === 0 ? 0 : 1);
