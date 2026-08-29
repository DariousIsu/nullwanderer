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

// ── S1.5 cure 1: anaphoric completion orders (the p180 live miss, verbatim) ─────────────────────
ok(road.anaphoricOrder('yea go ahead and get that completed and pulled up on the canvas') === true, "the p180 order that the classifier missed IS an anaphoric completion order");
ok(road.anaphoricOrder('finish it') === true && road.anaphoricOrder('can you wrap that up') === true, 'finish-it / wrap-that-up shapes hit');
ok(road.anaphoricOrder('tell me about that') === false, 'telling is not completing — no claim');
ok(road.anaphoricOrder('go ahead and tell me more about it') === false, 'go-ahead alone never claims');
ok(road.anaphoricOrder('') === false && road.anaphoricOrder(null) === false, 'empty → false, never a throw');
const now = Date.now();
const projs = [
  { slug: 'report-analysis-frontier-act', title: 'FRONTIER Act analysis', status: 'active', updated_ts: now - 3600e3 },
  { slug: 'old-thing', title: 'Old', status: 'active', updated_ts: now - 3 * 86400e3 },
  { slug: 'newest-but-done', title: 'Done', status: 'done', updated_ts: now - 60e3 },
];
ok(road.resolveAnaphor({ projects: projs, nowMs: now }).slug === 'report-analysis-frontier-act', "the anaphor resolves to the newest ACTIVE project in the window (done rows never win)");
ok(road.resolveAnaphor({ projects: [projs[1]], nowMs: now }) === null, 'a stale spine resolves to NOTHING — an anaphor never binds old work');

// ── S1.5 cure 2: held material + the commensurate rail ─────────────────────────────────────────
const fakeFs = {
  readdirSync: () => ['oberno_079_xml-the-frontier-act-final-text.pdf', '26-07-21-frontier-act-section-by-section.pdf', 'unrelated.pdf'],
  statSync: () => ({ size: 316 * 1024 }),
};
const held = road.heldMaterial({ topic: 'Frontier Act', deps: { db: { getDb: () => ({ prepare: () => ({ all: () => [{ id: 7, title: 'Text - H.R.9925 - 119th Congress: FRONTIER Act', created_ts: now }] }) }) }, fs: fakeFs, downloadsDir: 'x' } });
ok(/held document #7/.test(held) && /frontier-act-final-text\.pdf \(316KB\)/.test(held), 'held material lists documents AND downloads with sizes (space/hyphen-blind name match)');
ok(!/unrelated\.pdf/.test(held), 'non-matching downloads stay out');
const m3 = road.mandate({ order: { deliverable: 'report' }, road: { size: 'report', slug: 's' }, userText: 'x', held });
ok(/YOU ALREADY HOLD this source material/.test(m3) && /COMMENSURATE with its sources/.test(m3), 'the mandate carries the held block + the commensurate rail');
ok(!/YOU ALREADY HOLD/.test(road.mandate({ order: {}, road: { size: 'report' }, userText: 'x' })), 'no held material → no empty held block');

// ── S1.5 cure 3: the swarm offer ────────────────────────────────────────────────────────────────
ok(/FAN OUT/.test(m3) && /delegate_to_/.test(m3) && /INTEGRATE/.test(m3), 'a report-class mandate offers the swarm (delegate + integrate)');
ok(!/FAN OUT/.test(road.mandate({ order: {}, road: { size: 'brief' }, userText: 'x' })), 'a brief never fans out');

// ── S1.6: the leg-2 catches (the "present" verb, the claim fold, the conductor fold-in) ─────────
const ic = require('../lib/intake_contract');
ok(!!ic.detectDeliverableOrder('Alright please present your final, full and complete report'), "the p181 leg-2 order now classifies (the 'present' verb)");
ok(!!ic.detectDeliverableOrder('finalize the report on the Frontier Act'), "'finalize' is an order verb now");
ok(ic.detectDeliverableOrder('the presentation went well') === null, "'presentation' as a noun never claims (no order lead)");
road._resetForTest();
const cf1 = road.claim({ order: { deliverable: 'report' }, userText: 'a', bind: { slug: 'same-slug' }, deps });
const cf2 = road.claim({ order: { deliverable: 'report' }, userText: 'b', bind: { slug: 'same-slug' }, deps });
ok(cf1 === cf2, 'a same-slug claim inside the window FOLDS (two doors, one ledger entry)');
ok(road.claim({ order: { deliverable: 'report' }, userText: 'c', bind: { slug: 'other-slug' }, deps }) !== cf1, 'a different slug still claims fresh');

// ── S1.7: the say-gate's shape teeth (leg 3's plan-shaped final) ────────────────────────────────
ok(road.planShapedFinal('I have the core source material. Let me read the full research paper and the Statt article to write the complete report.') === true,
  "leg 3's verbatim final IS plan-shaped (a plan posted as the deliverable)");
ok(road.planShapedFinal("I'll now pull the section-by-section and draft each part") === true, 'an ill-now tail is plan-shaped');
ok(road.planShapedFinal('The report is finished and saved at notes/report-analysis-frontier-act.md — 9 pages covering all provisions. Summary: …') === false,
  'a pointer-bearing final is a deliverable, never re-driven');
ok(road.planShapedFinal('Honest partial: I read the bill text and drafted sections 1-3; sections 4-6 need the Statt breakdown which timed out. The draft so far covers definitions, tiers, and reporting.') === false,
  'an honest partial that ENDS on substance passes');
ok(road.planShapedFinal('x'.repeat(3000)) === false, 'a long inline document is a deliverable regardless of phrasing');
ok(road.planShapedFinal('') === false && road.planShapedFinal(null) === false, 'empty → false (the emptiness gate owns that case)');

// tap(): either side of the claim
road._resetForTest();
road.tap('canvas-cmd', null, { deps });
const ct = road.claim({ order: { deliverable: 'report' }, userText: 't', bind: { slug: 'tap-test' }, deps });
ok(ct.owners.includes('canvas-cmd'), 'a pre-claim canvas-cmd tap is swept into the claim');
road.tap('canvas-cmd', null, { deps });
ok(ct.owners.filter((o) => o === 'canvas-cmd').length === 2, 'a post-claim canvas-cmd tap meters directly');

// ── S2: the resume loop — a partial never strands ───────────────────────────────────────────────
const rmem = new Map();
const rdeps = { db: { getMeta: (k) => rmem.get(k) || null, setMeta: (k, v) => rmem.set(k, v) } };
ok(road.pendingResume({ deps: rdeps }) === null, 'no debt → no pending resume');
road.noteResume({ slug: 'report-analysis-frontier-act', ask: 'the FRONTIER Act analysis', note: 'plan-shaped twice', size: 'report', deps: rdeps, nowMs: now });
ok(road.pendingResume({ deps: rdeps }).slug === 'report-analysis-frontier-act', 'a non-registered outcome records the debt');
ok(road.resumeDue({ deps: rdeps, nowMs: now }) === true, 'a fresh debt is due (lastTryTs 0)');
road.markResumeTry({ deps: rdeps, nowMs: now });
ok(road.resumeDue({ deps: rdeps, nowMs: now + 60e3 }) === false, 'inside the pace window → not due (no hammering)');
ok(road.resumeDue({ deps: rdeps, nowMs: now + road.RESUME_PACE_MS + 1000 }) === true, 'past the pace window → due again');
road.clearResume({ deps: rdeps, why: 'registered delivery' });
ok(road.pendingResume({ deps: rdeps }) === null, 'only a REGISTERED delivery clears the debt');

// ── S3a: the artifact-absence gate + the want-net widening (the sponsor-roster false blank) ─────
ok(!!road.artifactAbsenceClaim("We don't have a compiled roster of all sponsors and co-sponsors across those 69 substantive bills."),
  "her verbatim false blank IS an artifact-absence claim");
ok(road.artifactAbsenceClaim("I don't have time for that right now") === null, 'an absence with no artifact noun never triggers');
ok(road.artifactAbsenceClaim('the report is attached') === null, 'no absence phrase → null');
const fa = road.findHeldArtifact({
  topic: 'sponsors and co-sponsors anti-China bills roster',
  deps: {
    projects: [{ slug: 'report-anti-china-surveillance-sponsors-utah-arizona-texas', title: 'anti-China and surveillance bills state by state with sponsors and co-sponsors' }],
    fs: { statSync: () => ({ size: 128818 }), readdirSync: () => [] },
    notesDir: 'x',
  },
});
ok(fa && fa.slug === 'report-anti-china-surveillance-sponsors-utah-arizona-texas' && fa.kb === 126, 'the held 128KB sponsors report is FOUND from the ask tokens (2-token floor)');
ok(road.findHeldArtifact({ topic: 'report', deps: { projects: [{ slug: 'x-report', title: 'report' }], fs: { readdirSync: () => [] }, notesDir: 'x' } }) === null,
  'a single generic token never "finds" (the suiteFor lesson)');
ok(!!ic.detectDeliverableOrder('I still need a list of everyone that sponsored or co sponsored those bills in each state'),
  "the want-net now crosses the adverb: 'I STILL need a list…' claims");
ok(ic.detectDeliverableOrder('if I ever need something I will ask') === null, 'a hypothetical want with no deliverable noun still never claims');

// ── the gather swarm + the writer's turn (his design, 08-29) ────────────────────────────────────
ok(road.swarmPlan('brief', 'x').length === 0, 'a brief never fans out');
const plan = road.swarmPlan('report', 'the FRONTIER Act');
ok(plan.length === 2 && plan[0].agent === 'legislative_analyst' && /FRONTIER Act/.test(plan[0].prompt), 'a report fans out the analyst + fact checker with the topic riding');
ok(road.swarmPlan('dossier', 'x').length === 4, 'a dossier adds the historian and opposition researcher');
const gm = road.gatherMandate({ order: {}, road: { size: 'report' }, userText: 'finish it', held: '- a.pdf' });
ok(/Do NOT write the document/.test(gm) && /DIGEST/.test(gm) && /a\.pdf/.test(gm), 'the gather mandate demands a digest, never prose, with the held material riding');
const wp = road.writerPrompt({ order: {}, road: { size: 'report' }, userText: 'the order', digest: 'D-FACTS', deposits: ['— fact_checker —\nverified X'], held: '- b.pdf' });
ok(/roughly 5-10 pages/.test(wp) && /D-FACTS/.test(wp) && /verified X/.test(wp) && /b\.pdf/.test(wp), "the writer's prompt carries the digest, the deposits, and the held list IN-CONTEXT");
ok(/never authored from memory/.test(wp) && /reply IS the document/.test(wp) && /never end on what you will do next/.test(wp), "the writer's rules: numbers from material only, no preamble, no plan-tail");
ok(road.WRITE_BUDGET.report === 6000 && road.WRITE_FLOOR.report === 3000, 'the write budget and floor match the size table');

// ── wiring: the one door claims, all four organs tap ────────────────────────────────────────────
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/document_road'\)\.claim\(\{ order, userText, bind: _bind \}\)/.test(main), 'wiring: the intake door makes the claim with the captured bind');
ok(/meter\(_road, 'promise', r\.id\)/.test(main), 'wiring: the promise backstop meters');
ok(/meter\(_road, 'in-turn'\)/.test(main) && /meter\(_road, 'say-promise'\)/.test(main), 'wiring: in-turn delivery and say-promise cover both meter');
ok(/notePreClaim\('redirect', target\.id\)/.test(main), 'wiring: the user-work redirect notes itself for the sweep');
ok(/task: true, autonomous: asResume, budgetMult: dr\.BUDGET\[road\.size\]/.test(main) && /asResume = false/.test(main),
  'wiring S1+S2: task mode with the lane rule — asResume defaults false, so a direct order rides INTERACTIVE and never starves');
ok(/_road && !_roadRunInFlight/.test(main) && /S1 run starting/.test(main), 'wiring S1: the road fires once per claim, one run at a time');
ok(/that's a failure on my side, not progress/.test(main), 'wiring S1: an empty run posts the honest failure — the say-gate never goes silent');
ok(/model: 'document-road', unprompted: 1/.test(main), 'wiring S1: delivery posts as her own follow-up message');
ok(/anaphoricOrder\(userText\)/.test(main) && /resolveAnaphor\(\)/.test(main), 'wiring S1.5: the door falls back to the anaphor resolver before giving up');
ok(/heldMaterial\(\{ topic:/.test(main) && /held: _held/.test(main), 'wiring S1.5: the held material rides the run mandate');
ok(/typed finalize order → the road/.test(main) && /conductor fallback/.test(main), 'wiring S1.6: a typed finalize order rides the road; the conductor is the fail-soft fallback');
ok(/THE DOCUMENT ROAD RUN HAS STARTED/.test(main), 'wiring S1.6: the control note tells the say-side the road run is live (no pivot, no promises)');
ok(/spawn_agent_async', args: \{ prompt: s\.prompt \+ env, name: s\.agent \}/.test(main) && /get_agent_output/.test(main),
  'wiring PHASE A/C: the road itself spawns the swarm and harvests deposits (deterministic, never model-volition)');
ok(/gatherMandate\(\{ order, road, userText, held: _held \}\)/.test(main), 'wiring PHASE B: the operator gathers a DIGEST — the writer owns all prose');
ok(/subconsciousModel\(\), process\.env\.ZOE_PAPER_MODEL/.test(main) && /num_predict: _budget/.test(main),
  "wiring PHASE D: the writer's turn runs the FRONTIER model first with a document-sized output budget");
ok(/came back thin/.test(main) && /COMMENSURATE with its sources — write the FULL/.test(main),
  'wiring PHASE D: a thin draft gets exactly one commensurate re-drive');
ok(/writeFileSync\(abs, doc, 'utf8'\)/.test(main) && /cannot be fabricated because the same code that saved the file composes the pointer/.test(main),
  'wiring PHASE D: delivery is DETERMINISTIC — the road writes the file and composes the pointer itself');
ok(/document_road'\)\.tap\('canvas-cmd'\)/.test(main), 'wiring S1.7: the canvas-cmd door (the seventh owner) taps the meter');
ok(/clearResume\(\{ why: 'registered delivery' \}\)/.test(main) && /noteResume\(\{ slug: road\.slug/.test(main),
  'wiring S2: only a registered delivery pays the debt; every lesser outcome records it');
ok(/resumeDue\(\)/.test(main) && /markResumeTry\(\)/.test(main) && /asResume: true/.test(main),
  'wiring S2: the paced resumer re-runs the owed document on the research lane');
ok(/autonomous: asResume/.test(main), "wiring S2: the lane rule — direct orders interactive, resumes ride research");
ok(/_verifyArtifactAbsenceFollowup\(finalSaid/.test(main) && /ARTIFACT false blank corrected/.test(main),
  'wiring S3a: every reply is checked for artifact false blanks; a hit posts the correction with the pointer');
ok(/document_road'\)\.tap\('assignment'\)/.test(main), 'wiring S3a: the assignment lane (the eighth owner door) taps the meter');

console.log(`\nsmoke_document_road: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
