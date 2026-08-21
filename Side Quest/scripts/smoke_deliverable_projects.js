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
ok(dp.statusOf('the anti china report').openScope.length === 2, '"where are we on X" reads the row: 2 open scope items');
ok(dp.completeScope(b1.slug, 'surveillance bills', { now: 2400 }).ok && dp.statusOf('anti china report').openScope.length === 1, 'completing a scope item closes exactly it');

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

// --- 7. the wiring is pinned in main.js ---
const main = read('main.js');
ok(/deliverable_projects'\)\.bindOrder\(\{ text: String\(userText\)/.test(main), 'the intake order backstop BINDS every deliverable order to the spine');
{
  const fn = main.slice(main.indexOf('function _bookUserOrderBackstop'));
  ok(fn.indexOf(".bindOrder({ text: String(userText)") > -1 && fn.indexOf(".bindOrder({ text: String(userText)") < fn.indexOf('const kept = (() => {'),
    'the bind runs BEFORE the kept/covered early-returns — kept orders are spec too');
}
ok(/deliverable_projects'\)\.noteCompose\(\{ topic: t, artifactSlug: slug \}\)/.test(main), 'the compose door links its landed artifact to the project');

console.log = _print;
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
