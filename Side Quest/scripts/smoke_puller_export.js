/* scripts/smoke_puller_export.js — offline checks for the Contact-shape exporter (pure node). */
'use strict';
const X = require('../studio/puller_export');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

// name splitting (FirstName/LastName; LastName is NOT NULL in Echo)
ok('splits first/last', JSON.stringify(X.splitName('Brian Huseman')) === JSON.stringify({ first: 'Brian', last: 'Huseman' }));
ok('drops suffix', X.splitName('John Smith Jr').last === 'Smith');
ok('mononym → last only', JSON.stringify(X.splitName('Cher')) === JSON.stringify({ first: '', last: 'Cher' }));

// deliverable flag from qualification grade
ok('grade B → deliverable 1', X.deliverableFlag({ grade: 'B' }) === 1);
ok('grade A → deliverable 1', X.deliverableFlag({ grade: 'A' }) === 1);
ok('grade C → deliverable null', X.deliverableFlag({ grade: 'C' }) === null);
ok('conflicted → deliverable 0', X.deliverableFlag({ grade: 'B', conflicted: true }) === 0);

const items = [
  { target: { id: 1, name: 'Brian Huseman', company: 'Amazon', domain: 'amazon.com' },
    beliefs: [{ type: 'email', value: 'bhuseman@amazon.com' }, { type: 'role', value: 'VP GA' }],
    qualification: { grade: 'B', confidence: 0.95, conflicted: false } },
  { target: { id: 2, name: 'Guess Person', company: 'Acme', domain: 'acme.com' },
    beliefs: [{ type: 'email', value: 'guess.person@acme.com' }],
    qualification: { grade: 'D', confidence: 0.50, conflicted: false } },
  { target: { id: 3, name: 'Bounced Person', company: 'Acme', domain: 'acme.com' },
    beliefs: [{ type: 'email', value: 'b.p@acme.com' }],
    qualification: { grade: 'C', confidence: 0.20, conflicted: true } },   // bounced → gated out
  { target: { id: 4, name: 'No Grade', company: 'X' }, beliefs: [], qualification: { grade: null } },
];

// default gate: drop conflicted + no-grade; keep B and D
const def = X.toContactRows(items);
ok('default keeps B + D (2 rows)', def.rows.length === 2 && def.rows.map(r => r.external_id).sort().join() === 'PULLER:1,PULLER:2');
ok('gates conflicted + no-grade', def.excluded.length === 2 && def.excluded.some(e => e.reason === 'conflicted/bounced') && def.excluded.some(e => e.reason === 'no grade'));

// row shape maps qualification → Echo fields
const r1 = def.rows.find(r => r.external_id === 'PULLER:1');
ok('Contact_Kind prospect', r1.Contact_Kind__c === 'prospect');
ok('quality score = confidence*100', r1.Email_Quality_Score__c === 95);
ok('deliverable=1 for verified', r1.Email_Deliverable__c === 1);
ok('first/last/email/title mapped', r1.FirstName === 'Brian' && r1.LastName === 'Huseman' && r1.Email === 'bhuseman@amazon.com' && r1.Title === 'VP GA');
ok('company helper column present', r1.Company === 'Amazon');

// send-gate: minGrade B drops the D row
const strict = X.toContactRows(items, { minGrade: 'B' });
ok('minGrade B keeps only the B row', strict.rows.length === 1 && strict.rows[0].external_id === 'PULLER:1');
ok('D row excluded with reason', strict.excluded.some(e => e.id === 2 && /below minGrade/.test(e.reason)));

// CSV
const csv = X.toCSV(def.rows);
const lines = csv.split('\n');
ok('CSV header has Contact columns', lines[0].startsWith('external_id,FirstName,LastName') && lines[0].includes('Email_Quality_Score__c'));
ok('CSV has 2 data rows', lines.length === 3);
const commaCsv = X.toCSV([X.contactRow({ target: { id: 9, name: 'A B', company: 'C' },
  beliefs: [{ type: 'role', value: 'Vice President, Government Relations' }], qualification: { grade: 'C', confidence: 0.8 } })]);
ok('CSV quotes a comma-bearing field', /"Vice President, Government Relations"/.test(commaCsv));
ok('empty rows → header only', X.toCSV([]).trim() === X.COLUMNS.join(','));

console.log(`\nsmoke_puller_export: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
