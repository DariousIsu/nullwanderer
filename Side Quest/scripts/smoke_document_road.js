/* smoke_document_road.js — THE DOCUMENT ROAD S0 (docs/DOCUMENT_ROAD_DESIGN_2026-08-28.md).
 * Proves: the size table, the claim (bind capture, persistence, cap), the owner meter, the
 * pre-claim sweep (the redirect fires before the claim in turn order — p179 live trace), the
 * recency window on late meters, and the wiring: the one door claims, all four organs tap.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_document_road.js
 */
'use strict';
const road = require('../lib/document_road');
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// a map-backed fake db so nothing touches the live store
const mem = new Map();
const deps = { db: { getMeta: (k) => mem.get(k) || null, setMeta: (k, v) => mem.set(k, v) } };

// ── the size table (his pick, 08-28) ────────────────────────────────────────────────────────────
ok(road.sizeClass({ deliverable: 'summary', topic: 'Frontier Act' }) === 'brief', 'summary → brief');
ok(road.sizeClass({ deliverable: 'analysis', topic: 'Frontier Act provisions' }) === 'report', 'analysis → report (the default class)');
ok(road.sizeClass({ deliverable: 'report', topic: 'comprehensive deep dive on PACs' }) === 'dossier', 'comprehensive/deep-dive → dossier');
ok(road.sizeClass({ deliverable: 'one-pager', topic: 'sponsors' }) === 'brief', 'one-pager → brief');
ok(road.sizeClass(null) === 'report', 'no order shape → report, never a throw');

// ── claim + persistence ─────────────────────────────────────────────────────────────────────────
road._resetForTest();
const c1 = road.claim({ order: { deliverable: 'analysis', topic: 'Frontier Act' }, userText: 'finish the summary and Analysis of the Frontier Act', bind: { slug: 'report-analysis-frontier-act', created: false }, deps });
ok(c1 && c1.slug === 'report-analysis-frontier-act' && c1.size === 'report' && c1.owners.length === 1 && c1.owners[0] === 'road', 'a claim binds the registry slug and starts with the road as sole owner');
ok(road.claims({ deps }).length === 1, 'the claim persists');
ok(road.claim({ order: null, deps }) === null, 'no deliverable → no claim (non-deliverable turns untouched)');

// ── the meter ───────────────────────────────────────────────────────────────────────────────────
road.meter(c1, 'promise', 2663, { deps });
ok(c1.owners.join('+') === 'road+promise#2663', 'a promise booking meters onto the claim');
ok(JSON.parse(mem.get(road.CLAIMS_KEY))[0].owners.length === 2, 'the metered owner persists');

// ── the pre-claim sweep (the redirect fires BEFORE the claim in turn order) ─────────────────────
road._resetForTest();
road.notePreClaim('redirect', 3962);
const c2 = road.claim({ order: { deliverable: 'summary', topic: 'anti china' }, userText: 'x', bind: { slug: 'p2', created: true }, deps });
ok(c2.owners.join('+') === 'road+redirect#3962', 'a pre-claim redirect note is swept into the claim (the #3962 misbind class is counted)');
ok(c2.minted === true, 'a minted project is marked');
const c3 = road.claim({ order: { deliverable: 'summary', topic: 'later' }, userText: 'y', bind: null, deps });
ok(c3.owners.length === 1, 'the pre-claim buffer is consumed — a later claim does not inherit it');
ok(c3.slug === null, 'an unbound claim carries slug null, never a throw');

// ── recency window on late meters ───────────────────────────────────────────────────────────────
road.meterIfRecent('absence', null, { deps });
ok(c3.owners.includes('absence'), 'a fresh late meter lands on the newest claim');
road.meterIfRecent('absence', null, { deps, nowMs: Date.now() + 10 * 60 * 1000 });
ok(c3.owners.filter((o) => o === 'absence').length === 1, 'a STALE late meter is a no-op (never meters onto history)');

// ── cap ─────────────────────────────────────────────────────────────────────────────────────────
for (let i = 0; i < 30; i++) road.claim({ order: { deliverable: 'memo', topic: 't' + i }, userText: 'z', deps });
ok(road.claims({ deps }).length <= road.CLAIMS_CAP, `the claims list is capped (${road.claims({ deps }).length} ≤ ${road.CLAIMS_CAP})`);

// ── S1: the mandate (pure) + budget table ───────────────────────────────────────────────────────
const m1 = road.mandate({ order: { deliverable: 'analysis' }, road: { size: 'report', slug: 'report-analysis-frontier-act' }, userText: 'finish the Analysis of the Frontier Act' });
ok(/Write the report \(up to ~10 pages\) NOW, in this run\./.test(m1), 'mandate: the size class sets the writing scope');
ok(/registry project for this document is "report-analysis-frontier-act" — update the canonical/.test(m1), 'mandate: the registry slug rides — the canonical updates in place');
ok(/HONEST PARTIAL naming exactly what is missing/.test(m1) && /FINAL message is the pointer/.test(m1), 'mandate: the say-gate demands the pointer or the honest partial');
ok(/never authored/.test(m1), 'mandate: the numbers doctrine rides every run');
const m2 = road.mandate({ order: { deliverable: 'summary' }, road: { size: 'brief', slug: null }, userText: 'x' });
ok(/brief \(1-2 pages\)/.test(m2) && /notes\/report\.md/.test(m2), 'mandate: an unbound brief still writes to a real path');
ok(road.BUDGET.brief === 0.75 && road.BUDGET.report === 1 && road.BUDGET.dossier === 2, 'the budget table matches the size classes');

// ── wiring: the one door claims, all four organs tap ────────────────────────────────────────────
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/document_road'\)\.claim\(\{ order, userText, bind: _bind \}\)/.test(main), 'wiring: the intake door makes the claim with the captured bind');
ok(/meter\(_road, 'promise', r\.id\)/.test(main), 'wiring: the promise backstop meters');
ok(/meter\(_road, 'in-turn'\)/.test(main) && /meter\(_road, 'say-promise'\)/.test(main), 'wiring: in-turn delivery and say-promise cover both meter');
ok(/notePreClaim\('redirect', target\.id\)/.test(main), 'wiring: the user-work redirect notes itself for the sweep');
ok(/task: true, autonomous: false, budgetMult: dr\.BUDGET\[road\.size\]/.test(main), 'wiring S1: the run rides the INTERACTIVE lane (autonomous:false — a direct order never starves) in task mode');
ok(/_road && !_roadRunInFlight/.test(main) && /S1 run starting/.test(main), 'wiring S1: the road fires once per claim, one run at a time');
ok(/that's a failure on my side, not progress/.test(main), 'wiring S1: an empty run posts the honest failure — the say-gate never goes silent');
ok(/model: 'document-road', unprompted: 1/.test(main), 'wiring S1: delivery posts as her own follow-up message');

console.log(`\nsmoke_document_road: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
