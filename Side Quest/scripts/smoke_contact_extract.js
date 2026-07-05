/* Smoke: lib/contact_extract + studio/puller_ingest (doc→contact discovery). Fully offline — no model,
 * no Echo. Feeds a sample of what the extraction model would emit through parseContactTuples, then lands
 * the rows into an in-memory Puller and asserts targets/observations/beliefs + the CITATION (source_url)
 * that Lucas's substrate mandates.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_contact_extract.js
 */
const CE = require('../lib/contact_extract');
const ingest = require('../studio/puller_ingest');
const pdb = require('../lib/puller_db');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- buildContactPrompt: on-rails, forbids invention ---
const prompt = CE.buildContactPrompt('some text', { title: 'Roster' });
const sys = prompt[0].content;
ok(prompt.length === 2 && prompt[1].content.includes('some text'), 'buildContactPrompt: system + user with the body');
ok(sys.includes('CONTACT | name | title | affiliation | email | phone | address'), 'buildContactPrompt: fixed pipe-delimited format');
ok(/NEVER invent|guess/i.test(sys), 'buildContactPrompt: forbids inventing/guessing contact data');
ok(prompt[1].content.startsWith('Document title: Roster'), 'buildContactPrompt: carries the title');

// --- parseContactTuples: what a model would emit → clean ingest rows ---
const raw = [
  'CONTACT | Brad Overcash | State Senator | NC General Assembly | Brad.Overcash@ncleg.gov | 919-733-5745 | 300 N. Salisbury St, Raleigh, NC 27603',
  'CONTACT | Rainey Center | - | - | info@raineycenter.org | (202) 555-0100 | 1455 Pennsylvania Ave NW, Washington DC',
  'CONTACT | Jane Doe | Director | Rainey Center | - | - | -',            // no contact field → dropped
  'CONTACT | Bogus Person | - | - | not-an-email | 12 | -',               // bad email + too-short phone → dropped
  'Ted Alexander | Senator | NC Senate | ted.alexander@NCLEG.gov | - | -', // no CONTACT tag; email only; mixed case
  'Here is a prose summary line that should be ignored.',                  // no pipes → ignored
].join('\n');
const rows = CE.parseContactTuples(raw);
ok(rows.length === 3, `parseContactTuples: keeps 3 contactable tuples (got ${rows.length})`);
const brad = rows.find(r => r.name === 'Brad Overcash');
ok(brad && brad.email === 'brad.overcash@ncleg.gov', 'parseContactTuples: email lowercased');
ok(brad && brad.phone === '919-733-5745' && /Raleigh/.test(brad.address), 'parseContactTuples: phone + address captured');
ok(brad && brad.company === 'NC General Assembly' && brad.title === 'State Senator', 'parseContactTuples: title + affiliation');
ok(brad && brad.confidence === CE.DOC_CONFIDENCE, 'parseContactTuples: doc confidence stamped (pattern tier)');
ok(!rows.some(r => r.name === 'Jane Doe'), 'parseContactTuples: drops a bare name with no contact field');
ok(!rows.some(r => r.name === 'Bogus Person'), 'parseContactTuples: drops invalid email + too-short phone (no field left)');
const ted = rows.find(r => r.name === 'Ted Alexander');
ok(ted && ted.email === 'ted.alexander@ncleg.gov', 'parseContactTuples: tolerates a missing CONTACT tag, normalizes email case');

// --- land into an in-memory Puller: targets + observations + CITED beliefs ---
pdb.init({ path: ':memory:' });
const url = 'docstore:4242';
const stats = ingest.ingestRows(pdb, rows, { source: 'doc:Faith in Elections roster', sourceUrl: url, obsKind: 'doc' });
ok(stats.targets === 3, `ingestRows: minted 3 new targets — the "new objects" (got ${stats.targets})`);
ok(stats.observations >= 7 && stats.beliefs >= 7, `ingestRows: landed observations + beliefs (obs=${stats.observations}, beliefs=${stats.beliefs})`);

const bt = pdb.findTargetByEmail('brad.overcash@ncleg.gov');
ok(bt && bt.name === 'Brad Overcash', 'ingest: Brad is findable by his discovered email');
const bobs = pdb.listObservations(bt.id);
ok(bobs.every(o => o.source_url === url), 'ingest: every observation carries the doc citation (source_url)');
ok(bobs.some(o => o.attr === 'email') && bobs.some(o => o.attr === 'phone') && bobs.some(o => o.attr === 'address'), 'ingest: email + phone + address observations all landed');
const bbeliefs = pdb.listBeliefs(bt.id);
ok(bbeliefs.some(b => b.type === 'email' && b.value === 'brad.overcash@ncleg.gov'), 'ingest: email belief derived');
ok(bbeliefs.some(b => b.type === 'address'), 'ingest: address belief derived (new attr)');
ok(bbeliefs.some(b => b.type === 'role' && b.value === 'State Senator'), 'ingest: title → role belief');

// --- idempotent: re-dropping the same doc doesn't double-count ---
const again = ingest.ingestRows(pdb, rows, { source: 'doc:Faith in Elections roster', sourceUrl: url, obsKind: 'doc' });
ok(again.targets === 0 && again.skippedDup === 3, 'ingestRows: re-drop is idempotent (0 new, 3 already tracked)');

pdb.close();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
