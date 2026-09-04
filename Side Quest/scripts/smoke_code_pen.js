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
ok(pen.pathAllowed('canvas_docs.db').ok === false && pen.pathAllowed('data/canvas_docs.db').ok === false, 'db files sealed wherever they sit (audit F42: was OR — the generic *.db rule went unguarded)');
ok(pen.pathAllowed('.claude/settings.local.json').ok === false, '⭐ harness settings are OUTSIDE the pen (audit F11: a hook runs outside the gate, and gitignored files have no revert)');
ok(pen.pathAllowed('lib/.env.backup').ok === false && pen.pathAllowed('sidecar/.env').ok === false, 'nested .env copies denied at any depth (audit F38)');

// ── ⭐ THE DIFF AUDIT (audit F0/F1: the rename hole — git apply executes file-ops the ---/+++ jail never saw) ──
ok(pen.auditDiff('diff --git a/lib/a.js b/lib/b.js\nsimilarity index 100%\nrename from lib/a.js\nrename to lib/b.js\n').ok === false,
  '⭐ rename sections are REFUSED outright — a move is expressed as delete+create content diffs or not at all');
ok(pen.auditDiff('diff --git a/.env b/.env\nnew file mode 100644\n--- /dev/null\n+++ b/.env\n@@ -0,0 +1 @@\n+KEY=1\n').ok === false,
  'a denied path in ANY header form is refused');
ok(pen.auditDiff('--- lib/x.js\n+++ lib/x.js\n@@ -1 +1 @@\n-a\n+b\n').ok === false,
  'headers without a/ b/ prefixes are refused — git apply -p1 strips a DIFFERENT first component than a bare path records (audit F0)');
ok(pen.auditDiff('diff --git "a/lib/x.js" "b/lib/x.js"\n--- "a/lib/x.js"\n+++ "b/lib/x.js"\n@@ -1 +1 @@\n-a\n+b\n').ok === false,
  'quoted/escaped paths are refused (audit F27: tokenization divergence)');
ok(pen.touchedFiles('diff --git a/lib/x.js b/lib/x.js\n--- a/lib/x.js\n+++ b/lib/x.js\n@@ -1 +1 @@\n-a\n+b\n').includes('lib/x.js'),
  'the audited file set spans diff --git AND header pairs');
{
  const nd = pen.normalizeDiff('--- a/lib/zz_f26.js\n+++ b/lib/zz_f26.js\n@@ -1,3 +1,2 @@\n a\n--- q\n b\n');
  ok(/^--- q$/m.test(nd) && /@@ -1,3 \+1,2 @@/.test(nd),
    'a deletion of "-- q" is hunk BODY, not a header — the scanner keeps it and the recount holds (audit F26)');
}

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

// ── ⭐ normalizeDiff: the body is the claim, the arithmetic is DERIVED (proposals #1+#2 both
// died "corrupt patch" on model-counted @@ headers; #2's re-anchor layer: @@ -1 claimed for
// content at line 99, beyond git apply's offset search) ──
{
  const LYING = `--- a/lib/no_such_pen_fixture.js\n+++ b/lib/no_such_pen_fixture.js\n@@ -1,6 +1,24 @@\n ctx1\n+add1\n+add2\n ctx2`;
  const n = pen.normalizeDiff(LYING);
  ok(/@@ -1,2 \+1,4 @@/.test(n), '⭐ lying hunk counts are recounted from the body (6/24 → 2/4)');
  ok(n.endsWith('\n'), 'a missing final newline is repaired (git calls it corrupt otherwise)');
  const blank = pen.normalizeDiff(`--- a/x.js\n+++ b/x.js\n@@ -1,1 +1,1 @@\n ctx\n\n ctx2\n`);
  ok(/\n \n/.test(blank) && /@@ -1,3 \+1,3 @@/.test(blank), 'an interior empty line becomes blank CONTEXT and counts on both sides');
  ok(pen.normalizeDiff(LYING).includes('lib/no_such_pen_fixture.js') && /@@ -1,2 \+1,4 @@/.test(n), 'an unreadable target keeps its claimed start — a stale read still fails honestly at apply-check');
  // re-anchor against the REAL tree: context from main.js, start line claimed as 1
  const mainLines = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const i1 = mainLines.findIndex((l) => l.includes('async function _applyPenProposal'));
  const i2 = mainLines.findIndex((l) => l.includes('pen.normalizeDiff ? pen.normalizeDiff'));
  ok(i1 > 0 && i2 > i1 + 3, 'fixture anchors exist in main.js (wiring pin doubles as anchor)');
  const fx = ['--- a/main.js', '+++ b/main.js',
    '@@ -1,999 +1,999 @@', ` ${mainLines[i1]}`, '+INSERTED', ` ${mainLines[i1 + 1]}`, ` ${mainLines[i1 + 2]}`,
    '@@ -5,99 +5,99 @@', ` ${mainLines[i2]}`, ` ${mainLines[i2 + 1]}`, ` ${mainLines[i2 + 2]}`].join('\n');
  const rn = pen.normalizeDiff(fx);
  ok(rn.includes(`@@ -${i1 + 1},3 +${i1 + 1},4 @@`), `⭐ hunk 1 re-anchored to its true line (${i1 + 1}) — she cannot know line numbers from bounded reads`);
  ok(rn.includes(`@@ -${i2 + 1},3 +${i2 + 2},3 @@`), 'hunk 2 re-anchored WITH the new-side drift from hunk 1 (+1)');
}

// ── proposal validation: the diff IS the claim ──
ok(pen.propose({ title: 't', diff: 'not a diff' }).ok === false, 'a diff without file headers is refused');
ok(pen.propose({ title: '', diff: GOOD_DIFF }).ok === false, 'a proposal needs a title');
ok(pen.propose({ title: 't', diff: GOOD_DIFF.replace('lib/scheduler.js', '.env').replace('lib/scheduler.js', '.env') }).ok === false, '⭐ a diff touching .env is refused at the door');
ok(pen.propose({ title: 't', diff: `--- a/data/sq.db\n+++ b/data/sq.db\n@@\n+x\n` }).ok === false, 'a diff touching the stores is refused');
ok(pen.propose({ title: 'big', diff: `--- a/lib/x.js\n+++ b/lib/x.js\n` + '+'.repeat(pen.MAX_DIFF_BYTES) }).ok === false, 'an oversize diff is refused — split the change');

// ── the state machine: only Lucas's card moves a proposal ──
const p1 = pen.propose({ title: 'clock-parse tweak', rationale: 'why', diff: GOOD_DIFF, bornFrom: 'smoke' });
ok(p1.ok === true && p1.files[0] === 'lib/scheduler.js', 'a valid proposal files with its touched set');
ok(/@@ -1,2 \+1,3 @@/.test(pen.get(p1.id).diff), '⭐ propose() stores the NORMALIZED diff — future rows carry honest arithmetic');
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

// ── ⭐ v1.2 QOL (Lucas 09-01: "no way to fully view the request" / "no acknowledgement" /
// "turn an accepted card into a window that shows what's going on") ──
{
  const p3 = pen.propose({ title: 'expand me', rationale: 'why text', diff: GOOD_DIFF });
  const item = pen.pending().find((x) => x.id === `pen-${p3.id}`);
  ok(!!item && item.detail && /@@ -1,2 \+1,3 @@/.test(item.detail.diff) && item.detail.rationale === 'why text' && item.detail.files[0] === 'lib/scheduler.js',
    '⭐ a card carries the FULL proposal (rationale + files + normalized diff) — he approves what he can read');
  pen.decide(p3.id, 'yes');
  const run1 = pen.pipelineItems().find((x) => x.id === `pen-${p3.id}`);
  ok(!!run1 && run1.kind === 'pen-run' && run1.status === 'approved' && !!run1.detail.diff,
    "⭐ a ✓'d proposal stays on the bar as a live buttonless pen-run progress card");
  pen.stage(p3.id, 'stage: test note');
  ok(pen.get(p3.id).status === 'approved' && /test note/.test(pen.get(p3.id).gate_note), 'stage() updates the note without touching the status');
  pen.setStatus(p3.id, 'gate-failed', { gateNote: 'gate RED — fixture' });
  ok(pen.pipelineItems().some((x) => x.id === `pen-${p3.id}`), 'a terminal verdict LINGERS on the bar — seen, never inferred from a vanished card');
  pen.stage(p3.id, 'gate RED — fixture', Date.now() - pen.RUN_WINDOW_MS - 1000);
  ok(!pen.pipelineItems().some((x) => x.id === `pen-${p3.id}`), 'an old verdict leaves the bar after the linger window');
  ok(!pen.pipelineItems().some((x) => x.status === 'rejected'), "his ✗ is his own act — never re-shown as a run card");
  // ── ⭐ v1.3 the clearable bar (Lucas 09-01: "no way to clear the pen window") ──
  const p4 = pen.propose({ title: 'clear me', diff: GOOD_DIFF });
  pen.decide(p4.id, 'yes');
  ok(pen.markSeen(p4.id).ok === false, 'a RUNNING card can never be waved away — only finished runs clear');
  pen.setStatus(p4.id, 'applied', { gateNote: 'fixture' });
  ok(pen.pipelineItems().some((x) => x.id === `pen-${p4.id}`), 'the finished run shows before his ✕');
  ok(pen.markSeen(p4.id).ok === true && !pen.pipelineItems().some((x) => x.id === `pen-${p4.id}`), '⭐ his ✕ clears it from the bar');
  ok(pen.pathAllowed('boot_self.log').ok === false && pen.pathAllowed('pen_gate_3.log').ok === false, 'the tee + gate forensics logs join the jail');
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

// ── the churn guard, re-cut (audit F34) ──
{
  const dbm = require('../lib/db');
  const a = pen.seedPenWork({ ask: 'fix the froznak toggle' });
  const b = pen.seedPenWork({ ask: 'fix the froznak toggle' });
  ok(a.ok && b.ok && b.reused === true && b.id === a.id, 'an identical OPEN pen ask is reused, not doubled');
  dbm.markOpenThreadStatus(a.id, 'stalled', { reason: 'test stall' });
  pen.dropFromQueue(a.id);
  pen.setPenState(a.id, { passes: 6, proposalId: 9 });
  const c = pen.seedPenWork({ ask: 'fix the froznak toggle' });
  ok(c.reused === true && c.reopened === true && pen.workQueue().includes(a.id) && pen.penState(a.id).passes === 0,
    '⭐ his word RE-OPENS a stalled twin — fresh budget, back on the queue (audit F34: repeating the ask after a stall was a silent no-op)');
  const rowN = dbm.insertOpenThread({ content: 'fix the wobniar lever' });
  const d2 = pen.seedPenWork({ ask: 'fix the wobniar lever' });
  ok(d2.reused !== true && d2.id !== rowN.id, 'a same-text NON-pen thread never hijacks the seed — the edit order still gets a real pen thread');
}

// ── wiring pins (grep-scope only — presence of the seams in main.js/renderer) ──
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/\^pen-\(\\d\+\)\$/.test(main) && /_applyPenProposal\(r\.id\)/.test(main), 'wiring: pen-N card decisions route to the enforce pipeline on his ✓');
  ok(/'apply', '--check'/.test(main) && /runGate\(\{ sides: \[repo\] \}\)/.test(main) && /'checkout', '--'/.test(main) && /revertScope\(\)/.test(main),
    'wiring: apply-check → the unified gate (per-side) → revert-on-red all present (stage 5.2: npm test became the side-scoped unified gate)');
  ok(/uncommitted local changes on/.test(main), 'wiring: a dirty tree BLOCKS the apply — my in-flight work is never clobbered');
  ok(/const penBlock = require\('\.\/lib\/code_pen'\)\.buildPromptBlock\(\)/.test(main) && /penLib\.stripTags/.test(main), 'wiring: the pen block rides her prompt; leaked tags are stripped from thought AND say');
  const chat = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat.js'), 'utf8');
  ok(/pen-/.test(chat) && /code change/.test(chat), 'wiring: the card bar renders pen cards with string ids');
  ok(/isEditIntent\(_pv\)/.test(main) && /seedPenWork\(/.test(main), '⭐ v1.1 wiring: the order backstop routes edit intents to pen work BEFORE the road');
  ok(/kind === 'pen'\) return runPenWorkPass/.test(main), 'v1.1 wiring: the dispatcher routes pen threads to the pen pass');
  ok(/code_pen'\)\.workQueue\(\)\) backgroundWorkerPass/.test(main), 'v1.1 wiring: the worker loop drives the pen queue even during his directed work');
  ok(/MAX_PEN_PASSES/.test(main) && /'gate-failed' \|\| p\.status === 'apply-failed'\) && !st\.redrove/.test(main), 'v1.1 wiring: pass cap = honest stall; ONE re-drive on a gate OR apply failure (a stale diff is the most re-drivable miss), never a grind');
  ok(/codeModel\(\), require\('\.\/lib\/config'\)\.subconsciousModel\(\)/.test(main),
    '⭐ the SPECIALIST leads the pen chain (his 08-06 order: all programming calls through the code model; kimi 3 = one .env line)');
  ok(/pen\.normalizeDiff \? pen\.normalizeDiff\(p\.diff\)/.test(main),
    '⭐ the apply seam normalizes too — rows filed BEFORE the propose-door recount (like #2) land without a live-DB rewrite');
  ok(/_penSay\(`Approval received/.test(main),
    '⭐ v1.2 wiring: his ✓ is acknowledged IMMEDIATELY in her voice (deterministic pipeline line, never model-authored)');
  ok((main.match(/if \(_penGateQuiet\(\)\)/g) || []).length >= 9 && /pen\.gate_until/.test(main),
    '⭐ v1.2 wiring: the QUIET WINDOW — 9 guarded CALL SITES (audit F32: the old count included the definition; audit F6 added the metabolism as the 9th lane)');
  ok(/pen\.stage\(id, `stage: diff applied/.test(main) && /_pushApprovalsBar\(\)/.test(main) && /pipelineItems\(\)/.test(main),
    'v1.2 wiring: stage notes ride the row, the bar refreshes live, and pen-run cards join the payload');
  ok(/`Proposal #\$\{id\} landed — gate green/.test(main) && /_penSay\(`Proposal #\$\{id\} went RED/.test(main),
    'v1.2 wiring: both gate verdicts are VOICED, not just logged');
  ok(/ac-can-expand/.test(chat) && /ac-diff/.test(chat) && /pen-run/.test(chat),
    'v1.2 wiring: the renderer expands cards to the full diff and renders the live run card');
  const mono = fs.readFileSync(path.join(__dirname, '..', 'lib', 'monologue.js'), 'utf8');
  ok(/pen\.gate_until/.test(mono), 'v1.2 wiring: the monologue tick honors the quiet window too');
  ok(/pen_gate_\$\{id\}\.log/.test(main) && /Failing pins:/.test(main),
    'v1.2 wiring: a gate red keeps the FULL log on disk and leads with the ✗ pin lines (the tail lost them twice)');
  ok(/decision === 'seen'\) return \{ \.\.\.pen\.markSeen/.test(main) && /approval-seen/.test(chat),
    'v1.3 wiring: the ✕ rides needs:decide as "seen"; the renderer shows it on finished runs only');
  ok(/function _selfRebootTick/.test(main) && /pen\.self_reboot/.test(main) && /app\.relaunch\(\)/.test(main) && /pen\.reboot_at/.test(main),
    '⭐ v1.3 HER REBOOT (his order): a landed change cycles HER program — kill-switch meta, cooldown, live-guards, announced');
  // cut 22 (09-04): the tee lives in lib/console_tee (async streams for both files); main.js installs it.
  ok(/boot_self\.log/.test(main) && /console_tee'\)\.install\(/.test(main) && /boot generation pid/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'console_tee.js'), 'utf8')),
    'v1.3 wiring: the console tee — a self-relaunched generation keeps its logs regardless of launcher');
  ok(/st\.pursuit = true; st\.redrove = false/.test(main) && /PURSUIT: proposal #/.test(main),
    "⭐ THE PURSUIT (his law: we don't take no for an answer): a second gate red converts the thread to a diagnosis brief — the ✗ pins become HER problem, never a silent close");
  ok(/rejected \(his word\)/.test(main) && /STALLED after pursuit/.test(main),
    'pursuit bounds: his ✗ still closes instantly; ONE pursuit generation, then an honest voiced stall with the evidence on the rows');
  // ── ⭐ the 09-01 AUDIT WAVE cures (43 confirmed findings; the pipeline/reboot cluster) ──
  ok(/_penApplyBusy/.test(main) && /queued — another proposal is in its gate/.test(main),
    '⭐ ONE pipeline at a time (audit F4/F10) — a second ✓ queues; interleaved gates cross-contaminated verdicts and dropped the quiet window mid-gate');
  ok(/revertScope/.test(main) && /createdByPatch/.test(main),
    '⭐ revert knows what the patch CREATED (audit F7) — created files revert by deletion; a checkout abort no longer strands a failed patch on disk');
  ok(/git apply failed after the check passed/.test(main),
    'the apply exit code is READ (audit F25) — the gate can never bless the unpatched tree');
  ok(/gate green but commit failed — REVERTED/.test(main),
    'a failed commit reverts and unstages (audit F8) — nothing stows away on the next proposal\'s commit');
  ok(/BOOT RECOVERY/.test(main) && /wedged in 'applying'/.test(main) && /re-approve to run the gate/.test(main),
    '⭐ boot recovery (audit F2/F9/F23) — a mid-pipeline death restores the tree, fails the row loudly, and returns an unrun ✓ to the bar');
  ok(/_selfRebootGuardRed/.test(main) && /ABORTED at the fuse/.test(main),
    '⭐ the fuse RE-CHECKS the guards (audit F3/F20) — a ✓ or a fresh turn landing inside the 5s stands the reboot down');
  ok(/status IN \('approved','applying'\)\"\)\.get\(\)\.n/.test(main) || /never kill a ✓ that has not run/.test(main),
    'her reboot never kills a pending ✓ or a mid-run pipeline (audit F20)');
  ok(/died instantly \(code/.test(main),
    'a stub python cannot strand her (audit P0) — instant cycler death falls back to app.relaunch before the exit');
  {
    const rs = fs.readFileSync(path.join(__dirname, 'run_smokes.js'), 'utf8');
    ok(/printed pass but exited nonzero/.test(rs) && (rs.match(/childOk/g) || []).length >= 6,
      '⭐ GATE BY EXIT CODE in every dialect (audit F22) — a suite that prints its pass line then crashes scores RED');
  }
  // ── the DOCKET-CLEAR pins (audit F30/F35/F36/F37/F39, cured on his "clear the docket") ──
  ok(/a FRESH budget \(audit F35\)/.test(main),
    'the redrive resets the pass budget (audit F35: a last-pass proposal got zero re-drive passes and stalled with a false reason)');
  ok(main.indexOf("if (kind === 'pen') return runPenWorkPass(focus);") !== -1
    && main.indexOf("if (kind === 'pen') return runPenWorkPass(focus);") < main.indexOf("isListCompletionGoal(String(focus.content"),
    '⭐ the pen kind gate sits ABOVE the list heuristic (audit F36: a table-phrased edit order was hijacked into research forever)');
  ok(!/if \(_bgSlots\(\) < 1\) return;/.test(main) && /pen queue drives regardless/.test(main),
    '⭐ the pen-queue driver is UNCONDITIONAL (audit F37: worker count 1 — the documented default — meant NO timer, and an acked edit order was dead forever)');
  ok(/_armApproval/.test(chat) && /the bar shifted under the cursor/.test(chat) && /mousedown/.test(chat),
    '⭐ the AIM GUARD (audit F30): a bar that re-renders between mousedown and click swallows the click — his ✓ can never land on a card he did not read');
  ok(/_lastApprovalSig/.test(chat), 'unchanged pushes skip the bar rebuild — fewer chances to shift under his aim (audit F30)');
  ok(/escapeHtml\(err\.message\)/.test(chat), 'the dashboard error sink escapes (audit F39: the one unescaped innerHTML in chat.js)');
  // ⭐ THE OUTSIDE HAND (his 09-01 confirm: full reboot control = "spawn an outside boot cycle python")
  ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'boot_cycle.py')),
    '⭐ the outside boot-cycler exists — her reboot no longer depends on the dying process staying healthy');
  ok(/boot_cycle\.py/.test(main) && /detached: true/.test(main) && /--root-pid/.test(main),
    'wiring: her self-reboot spawns the DETACHED cycler with her own root pid (it survives her exit and enforces the kill if she hangs)');
  ok(/falling back to app\.relaunch/.test(main),
    'wiring: a failed cycler spawn falls back to app.relaunch — never a silent no-reboot');
  ok(pen.pathAllowed('boot_cycle.log').ok === false && pen.pathAllowed('boot_cycle.lock').ok === false,
    'jail: the cycler log/lock are denied like every log');
  ok(pen.pathAllowed('scripts/boot_cycle.py').ok === true,
    'jail: the cycler SOURCE stays inside the pen — her reboot hand is her own code, gated like the rest');
  {
    const pyc = require('child_process').spawnSync('python', ['-m', 'py_compile', path.join(__dirname, '..', 'scripts', 'boot_cycle.py')], { encoding: 'utf8' });
    ok(pyc.error ? true : pyc.status === 0, pyc.error ? 'cycler py_compile SKIPPED (no python on PATH)' : 'the cycler COMPILES (py_compile clean)');
  }
}

// ── STAGE 5.2: the widened jail (Echo) + the constitutional boundary ─────────────────────────────
{
  // Echo source is now inside the jail; Echo stores/secrets are sealed by Echo's own denylist.
  ok(pen.pathAllowed('echo/saga/deliverables/op_ed.py', { repo: 'echo' }).ok === true, 'ECHO source is inside the pen — she can cure Echo herself');
  const es = pen.pathAllowed('echo/nl/tool_loop.py', { repo: 'echo' });
  ok(es.ok === true && /nx-echo/.test(es.abs.replace(/\\/g, '/')), 'an Echo path resolves under the Echo root, not the SQ root');
  ok(pen.pathAllowed('data/civic_graph.db', { repo: 'echo' }).ok === false, '⭐ Echo data/ (the 9-32GB foundations) is SEALED');
  ok(pen.pathAllowed('config.toml', { repo: 'echo' }).ok === false, '⭐ Echo config.toml (the tokens) is SEALED');
  ok(pen.pathAllowed('.venv/Scripts/python.exe', { repo: 'echo' }).ok === false, 'the Echo venv is sealed');
  ok(pen.pathAllowed('uv.lock', { repo: 'echo' }).ok === false, 'the Echo dependency lock is sealed — a pin bump is deliberate, not a pen edit');
  ok(pen.pathAllowed('../nx-echo-secrets', { repo: 'echo' }).ok === false, 'the Echo jail holds — no climbing out of the Echo root');

  // The CONSTITUTIONAL set: allowed to read/propose, but FLAGGED so it can't land on the reflexive ✓.
  for (const f of ['lib/security_scope.js', 'lib/code_pen.js', 'lib/self_source.js', 'lib/unified_gate.js', 'scripts/boot_cycle.py']) {
    const g = pen.pathAllowed(f);
    ok(g.ok === true && g.constitutional === true, `constitutional: ${f} is readable but FLAGGED (never a silent self-widen)`);
  }
  ok(pen.pathAllowed('lib/scheduler.js').constitutional === false, 'an ordinary file is NOT constitutional');

  // auditDiff carries the repo + the constitutional verdict across the whole touched set.
  const echoDiff = 'diff --git a/echo/x.py b/echo/x.py\n--- a/echo/x.py\n+++ b/echo/x.py\n@@ -1 +1 @@\n-a\n+b\n';
  const ea = pen.auditDiff(echoDiff, { repo: 'echo' });
  ok(ea.ok === true && ea.repo === 'echo' && ea.constitutional === false, 'auditDiff({repo:echo}) accepts an Echo diff, marks the repo');
  ok(pen.auditDiff('diff --git a/config.toml b/config.toml\n--- a/config.toml\n+++ b/config.toml\n@@ -1 +1 @@\n-a\n+b\n', { repo: 'echo' }).ok === false, 'auditDiff refuses an Echo diff that touches config.toml');
  const consDiff = 'diff --git a/lib/code_pen.js b/lib/code_pen.js\n--- a/lib/code_pen.js\n+++ b/lib/code_pen.js\n@@ -1 +1 @@\n-a\n+b\n';
  ok(pen.auditDiff(consDiff).constitutional === true, 'auditDiff flags a diff that touches a constitutional file');
  // a path is always resolved against ITS declared repo — an echo/… path under repo:sq points inside the
  // SQ tree (contained, harmless: apply would just miss a nonexistent SQ file), NOT at the Echo repo.
  const sqResolve = pen.auditDiff(echoDiff, { repo: 'sq' });
  ok(sqResolve.ok === true && sqResolve.repo === 'sq' && sqResolve.files[0] === 'echo/x.py', 'an echo path under repo:sq resolves inside SQ (the repo declares the root; the jail still contains it)');

  // propose() records the repo + the constitutional flag on the row.
  const rp = pen.propose({ title: 'echo cure', rationale: 'x', diff: echoDiff, repo: 'echo', bornFrom: 'test' });
  ok(rp.ok && rp.repo === 'echo' && rp.constitutional === false, 'propose({repo:echo}) files an Echo proposal');
  ok(pen.get(rp.id).repo === 'echo', 'the row carries repo=echo');
  const rc = pen.propose({ title: 'boundary change', rationale: 'x', diff: consDiff, repo: 'sq', bornFrom: 'test' });
  ok(rc.ok && rc.constitutional === true && pen.get(rc.id).constitutional === 1, 'a boundary-touching proposal is filed constitutional=1');
  // the card shows the repo tag + the BOUNDARY mark
  const pend = pen.pending();
  ok(pend.some((c) => /\[echo\]/.test(c.text)) && pend.some((c) => /BOUNDARY/.test(c.text)), 'the card bar tags [echo] and marks ⚠BOUNDARY');

  // dispatch threads the repo attribute; the prompt names the Echo door + the boundary rule.
  const dr = pen.dispatch({ tag: 'source-read', attrs: { path: 'echo/saga/deliverables/op_ed.py', repo: 'echo' } });
  ok(dr.ok === true && dr.repo === 'echo', 'dispatch(<source-read repo="echo">) reads the Echo file');
  const blk = pen.buildPromptBlock();
  ok(/repo="echo"/.test(blk) && /BOUNDARY/.test(blk) && /LOCAL — never pushed/.test(blk), 'the prompt block teaches the Echo door + the boundary rule + the Echo-local law');

  // main.js: the apply pipeline is repo-aware + honors the constitutional one-shot; the door arms it.
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/const repo = \(p\.repo === 'echo'\) \? 'echo' : 'sq'/.test(mainSrc) && /baseDir = repo === 'echo' \? ug\.ECHO_ROOT/.test(mainSrc), 'apply pipeline resolves the target repo + its root');
  ok(/runGate\(\{ sides: \[repo\] \}\)/.test(mainSrc), 'apply gates the SIDE the change touched (the unified gate)');
  ok(/pen\.allow_constitutional/.test(mainSrc) && /p\.constitutional/.test(mainSrc), 'apply holds a boundary change behind the explicit one-shot');
  const tpSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'test_port.js'), 'utf8');
  ok(/\/pen\/allow-constitutional/.test(tpSrc) && /setMeta\('pen\.allow_constitutional', '1'\)/.test(tpSrc), 'the /pen/allow-constitutional door arms the one-shot (out-of-band)');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
try { require('../lib/db').getDb().close(); } catch {}
try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
process.exit(fail === 0 ? 0 : 1);
