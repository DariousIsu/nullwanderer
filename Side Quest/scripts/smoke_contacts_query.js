/* Smoke: lib/contacts_query — detect a "list the contacts we hold" request + select/format the rows.
 * Fully offline (pure). ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_contacts_query.js
 */
'use strict';
const CQ = require('../lib/contacts_query');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- detect: list-intent + contact-noun → a query; research phrasing → not ---
ok(CQ.detect('give me a list of energy industry contacts — names, emails, companies').isQuery, 'detect: "give me a list of energy contacts" → query');
ok(CQ.detect('list the AI contacts we have').isQuery && CQ.detect('pull our datacenter people').isQuery, 'detect: list/pull variants');
ok(CQ.detect("who do we have at Duke Energy").isQuery, 'detect: "who do we have at X"');
ok(!CQ.detect('research new energy contacts for me').isQuery, 'detect: an explicit "research new" is NOT a list-query');
ok(!CQ.detect('what is the weather today').isQuery, 'detect: no contact noun → not a query');
ok(!CQ.detect('how is the project going').isQuery, 'detect: unrelated → not a query');
// "build a sheet / make a spreadsheet" are list-what-we-hold intents (the #7103 failure: "Build a sheet with
// all the Louisiana Contacts…" wasn't recognized → fell to chat → returned 2 contacts). "gov and private
// alike" means BOTH types (no type filter). Research-from-scratch (no HELD signal) is still NOT a list.
ok(CQ.detect('Build a sheet with all the Louisiana Contacts we have generated, government and private alike, organized by email confidence').isQuery, 'detect: "build a sheet with all the … Contacts we have" → query (was a routing miss → only 2 contacts)');
ok(CQ.detect('make me a spreadsheet of our tech contacts').isQuery && CQ.detect('put together a list of energy companies').isQuery, 'detect: "make me a spreadsheet" / "put together a list" → query');
ok(CQ.typeFrom('government and private alike') === null && CQ.typeFrom('public and private') === null, 'typeFrom: both sides named → null (no type filter, include everyone)');
ok(CQ.typeFrom('just the corporate contacts') === 'corporate' && CQ.typeFrom('elected officials in Ohio') === 'elected', 'typeFrom: one side named → that type');
ok(!CQ.detect('research and build a new list of energy contacts from scratch').isQuery, 'detect: research-from-scratch (no held signal) is NOT a list-query even though it says "build a list"');
ok(CQ.detect('build a sheet of the contacts we already hold').isQuery, 'detect: "build a sheet of the contacts we already hold" → query (HELD signal beats the build-verb)');

// --- sector + company extraction ---
ok(CQ.detect('list our energy and datacenter contacts').sectors.join(',') === 'energy,datacenter', 'detect: pulls the sector filters');
ok(CQ.detect('give me the contacts at Duke Energy').company === 'Duke Energy', 'detect: pulls the company filter ("at Duke Energy")');
ok(CQ.detect('list all the contacts we have').sectors.length === 0, 'detect: no sector mentioned → no filter (all)');

// --- count parsing ---
ok(CQ.detect('pull our 100 highest confidence energy contacts').limit === 100, 'detect: parses a requested count (100)');
ok(CQ.detect('list the top 25 energy contacts').limit === 25, 'detect: "top 25" → 25');
ok(CQ.detect('list our energy contacts').limit === null, 'detect: no number → null limit');

// --- GRADE / TYPE / STATE: the compositional filters (Lucas: "grade c and up corporate", "grade b elected
// officials in X state"). "c rating" = the A–E confidence GRADE (C=0.80), corporate/elected = the row src. ---
let gq = CQ.detect('pull me a spreadsheet of all our corporate contacts with a c rating or higher');
ok(gq.grade === 'C' && gq.gradeDir === 'gte' && gq.type === 'corporate', 'detect: "corporate contacts with a c rating or higher" → grade C+ / corporate');
gq = CQ.detect('give me grade B elected officials in Louisiana');
ok(gq.isQuery && gq.grade === 'B' && gq.type === 'elected' && gq.state === 'LA' && gq.company === null, 'detect: "grade B elected officials in Louisiana" → B / elected / LA (no phantom company)');
ok(CQ.detect('list our grade c and up energy contacts').grade === 'C', 'detect: "grade c and up" → C');
ok(CQ.detect('give me contacts at Duke Energy in Texas').company === 'Duke Energy' && CQ.detect('give me contacts at Duke Energy in Texas').state === 'TX', 'detect: company + trailing state disambiguate');
// --- TYPE is classified by COMPANY DOMAIN, not source (the Puller holds gov AND corporate side-by-side;
// most corporate leads are grade-C/D with a resolved company DOMAIN but no email). corporate = a real
// company domain that isn't government; gov = a gov domain / gov company name / the electoral CRM. ---
ok(CQ.domainKind('openai.com') === 'corporate' && CQ.domainKind('meta.com') === 'corporate', 'domainKind: company domains → corporate');
ok(CQ.domainKind('dc.gov') === 'gov' && CQ.domainKind('k12.dc.gov') === 'gov' && CQ.domainKind('legislature.maine.gov') === 'gov' && CQ.domainKind('leg.state.vt.us') === 'gov', 'domainKind: gov domains → gov');
ok(CQ.domainKind('gmail.com') === 'personal' && CQ.domainKind('harvard.edu') === 'edu' && CQ.domainKind(null) === null, 'domainKind: personal / edu / null');
ok(CQ.isGovernmentCompany('DC Public Schools') && CQ.isGovernmentCompany('Metropolitan Police Department') && !CQ.isGovernmentCompany('Duke Energy'), 'isGovernmentCompany: schools/police gov, a real company not');
const _pop = [
  { name: 'Corp Meta', company: 'Meta', domain: 'meta.com', confidence: 0.95, src: 'puller', state: null, elected: false },
  { name: 'Corp Duke', company: 'Duke Energy', domain: 'duke-energy.com', confidence: 0.80, src: 'puller', state: null, elected: false },
  { name: 'Corp Low', company: 'Acme Co', domain: 'acme.com', confidence: 0.50, src: 'puller', state: null, elected: false },
  { name: 'Gov School', company: 'McKinley Technology SHS', domain: null, email: 'x@k12.dc.gov', confidence: 0.9, src: 'puller', state: null, elected: false },
  { name: 'Gov NoDomain', company: 'DC Public Schools', domain: null, confidence: 0.9, src: 'puller', state: null, elected: false },
  { name: 'Rep LA', company: 'LA House', domain: null, email: 'r@house.la.gov', confidence: 0.95, src: 'crm', state: 'LA', elected: true },
];
ok(CQ.select(_pop, { type: 'corporate' }).rows.map((r) => r.name).sort().join() === 'Corp Duke,Corp Low,Corp Meta', 'select: corporate = the company-domain rows only (gov school by email, gov by name, and the CRM row all excluded)');
ok(CQ.select(_pop, { type: 'corporate', grade: 'C', gradeDir: 'gte' }).total === 2, 'select: grade C+ corporate → Meta(0.95)+Duke(0.80), drops the 0.50 lead');
ok(CQ.select(_pop, { type: 'corporate', sectors: ['energy'] }).rows.map((r) => r.name).join() === 'Corp Duke', 'select: corporate + energy sector → Duke Energy');
ok(CQ.select(_pop, { grade: 'B', type: 'elected', state: 'LA' }).rows.map((r) => r.name).join() === 'Rep LA', 'select: grade B elected in LA → the CRM elected row');
ok(CQ.label(CQ.detect('give me corporate contacts grade c or higher')) === 'grade C+ corporate contacts', 'label: "grade C+ corporate contacts"');
// GEO GAP ("if we're missing data, we find it") — a state was asked, but rows that match every OTHER filter
// yet carry no location are counted as sel.geoGap so the handler can surface it + offer to research it,
// instead of silently dropping them.
const _geo = [
  { name: 'Meta A', company: 'Meta', domain: 'meta.com', confidence: 0.9, src: 'puller', state: null },
  { name: 'Duke B', company: 'Duke Energy', domain: 'duke-energy.com', confidence: 0.9, src: 'puller', state: null },
  { name: 'Rep LA', company: 'LA House', email: 'r@house.la.gov', confidence: 0.95, src: 'crm', state: 'LA', elected: true },
];
ok(CQ.select(_geo, { state: 'LA' }).geoGap === 2 && CQ.select(_geo, { state: 'LA' }).total === 1, 'select: LA + both-types → 1 placeable (Rep LA) + geoGap 2 (the corporate rows have no location)');
ok(CQ.select(_geo, {}).geoGap === 0, 'select: no state asked → geoGap 0 (nothing to place)');
ok(CQ.select(_geo, { type: 'corporate', state: 'LA' }).total === 0 && CQ.select(_geo, { type: 'corporate', state: 'LA' }).geoGap === 2, 'select: corporate + LA → 0 placeable, geoGap 2 (all corporate lack location → surfaces the gap, not a fake empty)');
// unmetFilters is now narrow: only county has no field to filter on
ok(CQ.unmetFilters('list contacts in Orange county').includes('county'), 'unmet: county (no field) is flagged');
ok(CQ.unmetFilters('give me corporate contacts grade c').length === 0, 'unmet: grade + corporate are REAL filters now → not flagged');
ok(CQ.unmetFilters('list our energy contacts').length === 0, 'unmet: a plain sector ask flags nothing');

// --- "targets" / "orgs" are contact-list nouns; think-tank sector (regression: this went to a "project") ---
const tt = CQ.detect('do another list of 100 high confidence targets but only from think tanks and private organizations');
ok(tt.isQuery && tt.limit === 100 && tt.sectors.includes('thinktank'), 'detect: "list of 100 high-confidence targets from think tanks" → query, thinktank, 100 (was routed to a project)');
ok(CQ.detect('pull our AI orgs').isQuery, 'detect: "orgs" is a contact-list noun');

// --- select: sector filter, CONFIDENCE-first, dedup, cap ---
const rows = [
  { name: 'Jim Burke', email: 'jim.burke@vistra.com', company: 'Vistra Energy', title: 'CEO', confidence: 0.7 },
  { name: 'No Email Person', company: 'Duke Energy', title: 'VP', confidence: 0 },
  { name: 'Ada Lovelace', email: 'ada@openai.com', company: 'OpenAI', title: 'Researcher', confidence: 0.9 },
  { name: 'Bob Politician', email: 'bob@ncleg.gov', company: 'State Senate', title: 'Senator', confidence: 0.95 },
  { name: 'Hi Conf', email: 'hc@aep.com', company: 'American Electric Power', title: 'Dir', confidence: 0.96 },
  { name: 'Jim Burke', email: 'dup@vistra.com', company: 'Vistra Energy', title: 'CEO', confidence: 0.5 },   // dup name+company → collapsed
];
const energy = CQ.select(rows, { sectors: ['energy'] });
ok(energy.rows.every(r => /energy|vistra|duke|electric/i.test(r.company)) && !energy.rows.some(r => r.company === 'OpenAI' || r.company === 'State Senate'), 'select: energy filter keeps energy companies, drops AI/politicians');
ok(energy.rows[0].name === 'Hi Conf' && energy.rows[0].confidence === 0.96, 'select: HIGHEST CONFIDENCE sorts first');
// at EQUAL confidence, the MORE COMPLETE row (more contact fields filled) sorts first
const compRows = [
  { name: 'Sparse Guy', email: 's@aep.com', company: 'American Electric Power', confidence: 0.9 },
  { name: 'Full Guy', email: 'f@aep.com', phone: '555-1212', company: 'American Electric Power', title: 'VP', confidence: 0.9 },
];
ok(CQ.select(compRows, { sectors: ['energy'] }).rows[0].name === 'Full Guy', 'select: at equal confidence, MOST COMPLETE sorts first');
ok(energy.total === 3 && !energy.rows.some((r, i) => energy.rows.findIndex(x => x.name === r.name && x.company === r.company) !== i), 'select: dedups by name+company');
// cross-source: same person in Puller + CRM under a DIFFERENT company string, but the SAME email → collapse
const xsrc = CQ.select([
  { name: 'Pat Green', email: 'pat@aep.com', company: 'AEP Energy', title: 'VP', confidence: 0.7 },        // Puller
  { name: 'Pat Green', email: 'pat@aep.com', company: 'American Electric Power', confidence: 0.9 },        // CRM (diff company str)
], { sectors: ['energy'] });
ok(xsrc.total === 1 && xsrc.rows[0].confidence === 0.9, 'select: cross-source same-email dup collapses (keeps the higher-confidence row)');
ok(CQ.select(rows, { sectors: ['energy'], limit: 1 }).shown === 1, 'select: honors an explicit limit');
// malformed initials-only names (from a bad extraction) are dropped even at high confidence
ok(CQ.select([{ name: 'P. C. V. C.', email: 'p.c@ferc.gov', company: 'Duke Energy', confidence: 0.97 }, { name: 'Real Person', email: 'r@aep.com', company: 'AEP', confidence: 0.6 }], { sectors: ['energy'] }).rows.every(r => r.name !== 'P. C. V. C.'), 'select: drops initials-only junk names even at 97% confidence');
const ai = CQ.select(rows, { sectors: ['ai', 'datacenter'] });
ok(ai.total === 1 && ai.rows[0].company === 'OpenAI', 'select: AI/datacenter filter → OpenAI');
// think-tank sector matches think-tank org NAMES (Brookings, "Center for …", institutes), not energy/AI cos
const ttRows = [
  { name: 'Wonk One', email: 'w1@brookings.edu', company: 'Brookings Institution', confidence: 0.8 },
  { name: 'Wonk Two', email: 'w2@rstreet.org', company: 'R Street Institute', confidence: 0.7 },
  { name: 'Energy Exec', email: 'e@vistra.com', company: 'Vistra Energy', confidence: 0.9 },
];
const ttSel = CQ.select(ttRows, { sectors: ['thinktank'] });
ok(ttSel.total === 2 && ttSel.rows.every(r => /brookings|street/i.test(r.company)), 'select: thinktank filter keeps think-tank orgs, drops the energy co');
const all = CQ.select(rows, {});
ok(all.total === 5, 'select: no sector → all (deduped)');
ok(CQ.select(rows, { company: 'duke' }).total === 1, 'select: company filter → just Duke');

// --- toTable + label ---
const tbl = CQ.toTable(energy);
ok(tbl.headers.length === 5 && tbl.headers[4] === 'Confidence' && tbl.rows.length === 3 && tbl.rows[0][0] === 'Hi Conf' && /with email/.test(tbl.caption), 'toTable: headers (incl. Confidence) + rows sorted by confidence + caption');
ok(tbl.rows[0][4] === '96%', 'toTable: confidence rendered as a %');
ok(CQ.label({ sectors: ['energy'] }) === 'energy contacts' && CQ.label({ company: 'Duke Energy' }) === 'Duke Energy contacts', 'label: sector / company titles');
ok(CQ.label({ sectors: ['thinktank'] }) === 'think tank contacts', 'label: thinktank → "think tank contacts"');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
