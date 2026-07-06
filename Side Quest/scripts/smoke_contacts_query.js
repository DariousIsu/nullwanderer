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

// --- sector + company extraction ---
ok(CQ.detect('list our energy and datacenter contacts').sectors.join(',') === 'energy,datacenter', 'detect: pulls the sector filters');
ok(CQ.detect('give me the contacts at Duke Energy').company === 'Duke Energy', 'detect: pulls the company filter ("at Duke Energy")');
ok(CQ.detect('list all the contacts we have').sectors.length === 0, 'detect: no sector mentioned → no filter (all)');

// --- select: sector filter, email-first, dedup, cap ---
const rows = [
  { name: 'Jim Burke', email: 'jim.burke@vistra.com', company: 'Vistra Energy', title: 'CEO' },
  { name: 'No Email Person', company: 'Duke Energy', title: 'VP' },
  { name: 'Ada Lovelace', email: 'ada@openai.com', company: 'OpenAI', title: 'Researcher' },
  { name: 'Bob Politician', email: 'bob@ncleg.gov', company: 'State Senate', title: 'Senator' },
  { name: 'Jim Burke', email: 'dup@vistra.com', company: 'Vistra Energy', title: 'CEO' },   // dup name+company → collapsed
];
const energy = CQ.select(rows, { sectors: ['energy'] });
ok(energy.rows.every(r => /energy|vistra|duke/i.test(r.company)) && !energy.rows.some(r => r.company === 'OpenAI' || r.company === 'State Senate'), 'select: energy filter keeps energy companies, drops AI/politicians');
ok(energy.rows[0].email && energy.rows[0].name === 'Jim Burke', 'select: emailed contacts sort first');
ok(energy.total === 2 && !energy.rows.some((r, i) => energy.rows.findIndex(x => x.name === r.name && x.company === r.company) !== i), 'select: dedups by name+company');
const ai = CQ.select(rows, { sectors: ['ai', 'datacenter'] });
ok(ai.total === 1 && ai.rows[0].company === 'OpenAI', 'select: AI/datacenter filter → OpenAI');
const all = CQ.select(rows, {});
ok(all.total === 4, 'select: no sector → all (deduped)');
ok(CQ.select(rows, { company: 'duke' }).total === 1, 'select: company filter → just Duke');

// --- toTable + label ---
const tbl = CQ.toTable(energy);
ok(tbl.headers.length === 4 && tbl.rows.length === 2 && tbl.rows[0][0] === 'Jim Burke' && /with email/.test(tbl.caption), 'toTable: headers + rows + caption');
ok(CQ.label({ sectors: ['energy'] }) === 'energy contacts' && CQ.label({ company: 'Duke Energy' }) === 'Duke Energy contacts', 'label: sector / company titles');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
