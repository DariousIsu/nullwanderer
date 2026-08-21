/* Smoke: THE PROJECT SPINE, slice 1 (Phase 1 of the document-production plan).
 * A durable row per ongoing deliverable: orders bind (kin → existing project gains the verbatim
 * ask; new subject mints, slug shared with the artifact registry), follow-up scope attaches,
 * composes link their artifact, and "where are we on X" has a row to read. Driven against an
 * in-memory db shared with the registry (one identity vocabulary), then the wiring is pinned.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_deliverable_projects.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const _print = console.log.bind(console);
const ok = (c, t) => { if (c) { pass++; _print('  ✓', t); } else { fail++; _print('  ✗', t); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const reg = require('../lib/artifact_registry');
const dp = require('../lib/deliverable_projects');
const Database = require('better-sqlite3');
const mem = new Database(':memory:');
reg._setDb(mem); dp._setDb(mem);

console.log = () => {};   // quiet the libs' narration; ok() prints through _print

// --- 1. DAY 1: an order mints a project whose slug IS the registry's artifact slug ---
const b1 = dp.bindOrder({ text: 'build the report on anti-China legislation state by state: Utah, Arizona, Texas', topic: 'anti-China legislation state by state: Utah, Arizona, Texas', now: 1000 });
ok(b1 && b1.created, 'day 1: a new order MINTS a project');
ok(/^report-anti-china/.test(b1.slug), `the project slug is the registry family (${b1.slug})`);
ok(dp.get(b1.slug).spec.length === 1 && /build the report/.test(dp.get(b1.slug).spec[0].text), 'the verbatim ask is spec item 1 — HIS words, not a paraphrase');

// --- 2. DAY 2: a re-phrased follow-up order BINDS to the same project, never a sibling ---
const b2 = dp.bindOrder({ text: 'now add surveillance bills to the anti china report with sponsors', topic: 'anti china surveillance bills with sponsors', now: 2000 });
ok(b2 && !b2.created && b2.slug === b1.slug, 'day 2: the kin follow-up binds to the SAME project');
ok(dp.get(b1.slug).spec.length === 2, 'the follow-up ask APPENDS to the spec (append-only)');
ok(dp.bindOrder({ text: 'now add surveillance bills to the anti china report with sponsors', topic: 'anti china surveillance bills with sponsors', now: 2500 }).slug === b1.slug && dp.get(b1.slug).spec.length === 2, 'a verbatim re-send never duplicates a spec row');

// --- 3. scope attaches, completes, and never duplicates ---
ok(dp.attachScope(b1.slug, 'surveillance bills', { now: 2100 }).ok, 'scope "surveillance bills" attaches');
ok(dp.attachScope(b1.slug, 'per-state status table', { now: 2200 }).ok, 'a second scope item attaches');
ok(dp.attachScope(b1.slug, 'Surveillance Bills', { now: 2300 }).existing === true, 'a case-variant re-attach is recognized, not duplicated');
// (3 open: the day-2 bind AUTO-ATTACHED its novel-scope phrase + the two explicit attaches above)
ok(dp.statusOf('the anti china report').openScope.length === 3, '"where are we on X" reads the row: 3 open scope items (incl. the auto-attached novel scope)');
ok(dp.completeScope(b1.slug, 'surveillance bills', { now: 2400 }).ok && dp.statusOf('anti china report').openScope.length === 2, 'completing a scope item closes exactly it');

// --- 4. the compose door links its artifact and stamps delivered-current ---
// Day 1's compose registered the artifact (as the live door does); day 2's pursuit topic
// restates the project with the new scope — the registry must REUSE, the spine must link.
reg.record({ slug: b1.slug, relPath: `notes/${b1.slug}.md`, title: 'Report — anti-China legislation', topic: 'anti-China legislation state by state: Utah, Arizona, Texas' });
const rr = reg.resolveOrMint({ topic: 'anti-China and surveillance bills state by state: Utah, Arizona, Texas' });
ok(rr.existing && rr.slug === b1.slug, 'the registry resolves the day-2 compose topic to the SAME identity (one vocabulary)');
const nc = dp.noteCompose({ topic: 'anti-China and surveillance bills state by state: Utah, Arizona, Texas', artifactSlug: rr.slug, now: 3000 });
ok(nc && nc.slug === b1.slug, 'noteCompose finds the kin project');
ok(dp.get(b1.slug).status === 'delivered' && dp.get(b1.slug).artifact_slug === rr.slug, 'the project is delivered-current and points at its canonical artifact');

// --- 5. an unrelated order NEVER merges; listings filter ---
const b3 = dp.bindOrder({ text: 'build a brief on the Hartfield Foundation', topic: 'Hartfield Foundation', now: 4000 });
ok(b3.created && b3.slug !== b1.slug, 'an unrelated subject mints its own project');
ok(dp.list().length === 2, 'two projects, two rows');
ok(dp.list({ openScopeOnly: true }).length === 1 && dp.list({ openScopeOnly: true })[0].slug === b1.slug, 'openScopeOnly lists exactly the project with open scope (the gap plan\'s feed)');
ok(dp.statusOf('the parish leadership roster') === null, 'an unknown subject reads null — no invented project');
ok(dp.findProject('') === null && dp.bindOrder({}) === null, 'empty inputs are inert');

// --- 6. spec cap: append-only but bounded ---
for (let i = 0; i < 40; i++) dp.bindOrder({ text: `hartfield brief follow-up number ${i} on the Hartfield Foundation`, topic: 'Hartfield Foundation', now: 5000 + i });
ok(dp.get(b3.slug).spec.length <= dp.SPEC_CAP, `the spec is bounded at ${dp.SPEC_CAP} (oldest roll off)`);

// --- 7. SLICE 2: novel scope auto-attaches on a kin bind; a pure re-order attaches nothing ---
{
  const p0 = dp.get(b1.slug).scope.length;
  const nb = dp.bindOrder({ text: 'and add a per-state trend graph to the anti china report', topic: 'anti china report per-state trend graph', now: 6000 });
  ok(!nb.created && nb.novel.length >= 1, 'a follow-up with NOVEL tokens binds and reports them');
  ok(dp.get(b1.slug).scope.length === p0 + 1 && dp.get(b1.slug).scope.some((s) => /trend graph/.test(s.item) && s.status === 'open'), 'the novel sub-scope AUTO-ATTACHES as an open item');
  const rb = dp.bindOrder({ text: 'and add a per-state trend graph to the anti china report', topic: 'anti china report per-state trend graph', now: 6100 });
  ok(rb.novel.length === 0 && dp.get(b1.slug).scope.length === p0 + 1, 'a verbatim re-order carries nothing novel and attaches nothing');
}

// --- 7b. SLICE 2b: the SCOPE-ADD order (continuity leg-B catch) ---
{
  ok(dp.detectScopeAdd('also fold a grid reliability section into the louisiana energy policy report') !== null, 'detectScopeAdd: "also fold Y into the X report" (the live leg-B miss)');
  ok(dp.detectScopeAdd('add a funding-sources breakdown to the anti china report') !== null, 'detectScopeAdd: "add Y to the X report"');
  const s3 = dp.detectScopeAdd('the hartfield brief should also cover donor overlap');
  ok(s3 && /donor overlap/.test(s3.item) && /hartfield/.test(s3.target), 'detectScopeAdd: "the X brief should also cover Y" (target + item both extracted)');
  ok(dp.detectScopeAdd('add a contact to the CRM') === null, 'no deliverable noun → not a scope-add');
  ok(dp.detectScopeAdd('what does the report say') === null, 'a question is not a scope-add');
  const sBefore = dp.get(b1.slug).scope.length, spBefore = dp.get(b1.slug).spec.length;
  const ap = dp.applyScopeAdd({ text: 'also fold a per-bill fiscal note into the anti china report', now: 8000 });
  ok(ap && ap.slug === b1.slug, 'applyScopeAdd resolves the target to the project');
  ok(dp.get(b1.slug).scope.length === sBefore + 1 && dp.get(b1.slug).scope.some((s) => /fiscal note/.test(s.item) && s.status === 'open'), 'the item attaches as OPEN scope');
  ok(dp.get(b1.slug).spec.length === spBefore + 1, 'the verbatim scope-add ask joins the spec');
  ok(dp.applyScopeAdd({ text: 'also fold maps into the reno municipal roster report', now: 8100 }) === null, 'an unknown target falls through (nothing invented)');
}

// --- 8. SLICE 2: the status ask reads the row ---
ok(dp.detectStatusAsk('where are we on the anti china report').subject === 'anti china report', 'detectStatusAsk: "where are we on X" → subject');
ok(dp.detectStatusAsk("what's the status of the Hartfield brief").subject === 'Hartfield brief', 'detectStatusAsk: "what\'s the status of X" → subject');
ok(dp.detectStatusAsk('any progress on the parish sheet?').subject === 'parish sheet', 'detectStatusAsk: "any progress on X?" → subject (trailing ? stripped)');
ok(dp.detectStatusAsk('build the report on louisiana') === null, 'a build order is NOT a status ask');
ok(dp.detectStatusAsk('I like the status quo of this design') === null || dp.statusBrief('status quo of this design') === null, 'a non-project subject never produces a brief (the door falls through)');
{
  const sb = dp.statusBrief('the anti china report');
  ok(sb && sb.slug === b1.slug, 'statusBrief resolves the ask to the project');
  ok(/PROJECT: /.test(sb.brief) && /CANONICAL ARTIFACT: notes\//.test(sb.brief) && /version 1/.test(sb.brief), 'the brief carries status + canonical artifact + version — row facts, nothing generated');
  ok(/OPEN SCOPE \(still to fold in\):/.test(sb.brief) && /trend graph/.test(sb.brief), 'open scope items ride the brief');
  ok(/SPEC: \d+ verbatim ask\(s\)/.test(sb.brief), 'the spec count + latest ask ride the brief');
  ok(dp.statusBrief('the reno municipal roster') === null, 'an unknown subject briefs null');
}

// --- 9. SLICE 2: the gap plan lists projects with open scope ---
{
  const gp = require('../lib/gap_plan');
  const sheet = gp.compose({ fillable: [], blockedItems: [], aggressive: [], blockedKeys: [], absenceOpen: 0, counts: { open: 0, fillable: 0, blocked: 0, aggressive: 0 }, now: 7000 }, { projects: dp.list({ openScopeOnly: true }) });
  ok(/Ongoing deliverable projects with OPEN scope/.test(sheet) && /open item\(s\)/.test(sheet), 'the gap-plan sheet carries the open-scope project section');
  const empty = gp.compose({ fillable: [], blockedItems: [], aggressive: [], blockedKeys: [], absenceOpen: 0, counts: { open: 0, fillable: 0, blocked: 0, aggressive: 0 }, now: 7000 }, { projects: [] });
  ok(!/Ongoing deliverable projects/.test(empty), 'no open-scope projects → no section');
}

// --- 10. the wiring is pinned in main.js ---
const main = read('main.js');
ok(/deliverable_projects'\)\.bindOrder\(\{ text: String\(userText\)/.test(main), 'the intake order backstop BINDS every deliverable order to the spine');
{
  const fn = main.slice(main.indexOf('function _bookUserOrderBackstop'));
  ok(fn.indexOf(".bindOrder({ text: String(userText)") > -1 && fn.indexOf(".bindOrder({ text: String(userText)") < fn.indexOf('const kept = (() => {'),
    'the bind runs BEFORE the kept/covered early-returns — kept orders are spec too');
}
ok(/deliverable_projects'\)\.noteCompose\(\{ topic: t, artifactSlug: slug \}\)/.test(main), 'the compose door links its landed artifact to the project');
ok(/_dp\.detectStatusAsk\(userMessage\)/.test(main) && /_dp\.statusBrief\(_sa\.subject\)/.test(main), 'the status path detects the ask AND requires a project hit before injecting');
ok(/row facts injected into the reply context/.test(main) && /composedUserMessage = `\$\{composedUserMessage\}\\n\\n\[PROJECT STATUS/.test(main),
  'the row facts ride the reply CONTEXT pre-generation (one voice) — the live p86 post-reply door never fired');
ok(/from THESE FACTS ONLY/.test(main), 'the status reply is pinned to the row facts — never invented progress');
ok(/deliverable_projects'\)\.list\(\{ openScopeOnly: true \}\)/.test(read('lib/gap_plan.js')), 'maybePresent feeds open-scope projects into the sheet');
ok(/deliverable_projects'\)\.applyScopeAdd\(\{ text: String\(userText\)/.test(main), 'a non-order turn runs the SCOPE-ADD net before falling through (leg-B catch)');
// ROOT A COMPLETENESS (continuity leg-A catch): a kept in-turn FILE delivery registers.
ok(/in-turn file delivery registered/.test(main) && /require\('\.\/lib\/files'\)\.lastWrite\(\)/.test(main),
  'a kept report-shaped order whose file landed in notes/ REGISTERS in the artifact registry');
ok(/lastWrite\(\) \{ return \{ ts: _lastWriteTs, path: _lastWritePath \}; \}/.test(read('lib/files.js')) && (read('lib/files.js').match(/_lastWritePath = (?:abs|canon);/g) || []).length === 4,
  'lib/files tracks the RESOLVED write path at all four write points (one-canonical redirects included)');

console.log = _print;
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
