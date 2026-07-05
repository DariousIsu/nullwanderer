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

// --- buildCardsPrompt: on-rails, three typed line formats, forbids invention ---
const prompt = CE.buildCardsPrompt('some text', { title: 'Roster' });
const sys = prompt[0].content;
ok(prompt.length === 2 && prompt[1].content.includes('some text'), 'buildCardsPrompt: system + user with the body');
ok(sys.includes('PERSON | name | title | affiliation | email | phone | address'), 'buildCardsPrompt: PERSON format');
ok(sys.includes('PLACE | name | address | note') && sys.includes('EVENT | name | date | location | note'), 'buildCardsPrompt: PLACE + EVENT formats');
ok(/NEVER invent|guess/i.test(sys), 'buildCardsPrompt: forbids inventing/guessing contact data');
ok(prompt[1].content.startsWith('Document title: Roster'), 'buildCardsPrompt: carries the title');

// --- parseDocCards: typed routing (people / places / events) ---
const typed = CE.parseDocCards([
  'PERSON | Ted Alexander | Senator, North Carolina | - | - | - | -',
  'PLACE | AC Hotel Raleigh Downtown | 9 Glenwood Ave, Raleigh, NC 27603 | event venue',
  'EVENT | Faith in Elections Prayer Breakfast | Tuesday June 30, 2026 | AC Hotel Raleigh Downtown | 8:30-10am',
].join('\n'));
ok(typed.people.length === 1 && typed.people[0].name === 'Ted Alexander', 'parseDocCards: PERSON routed to people');
ok(typed.places.length === 1 && typed.places[0].name === 'AC Hotel Raleigh Downtown' && /Glenwood/.test(typed.places[0].address), 'parseDocCards: PLACE routed with address');
ok(typed.events.length === 1 && typed.events[0].name === 'Faith in Elections Prayer Breakfast' && /June 30/.test(typed.events[0].date) && /AC Hotel/.test(typed.events[0].location), 'parseDocCards: EVENT routed with date + location');

// --- parseMentions (Slice B — meeting mentions, names only) ---
const mentions = CE.parseMentions([
  'PERSON | Russ Walker', 'PERSON | Sen. Curtis', 'PLACE | AC Hotel', 'EVENT | Prayer Breakfast',
  'PERSON | Russ Walker',   // dup → collapsed
  'a prose line with no pipe',
].join('\n'));
ok(mentions.people.length === 2 && mentions.people.includes('Russ Walker') && mentions.people.includes('Sen. Curtis'), 'parseMentions: people deduped, bare/"Sen." names kept');
ok(mentions.places[0] === 'AC Hotel' && mentions.events[0] === 'Prayer Breakfast', 'parseMentions: place + event routed');
ok(CE.buildMentionsPrompt('x')[0].content.includes('PERSON | name'), 'buildMentionsPrompt: names-only format');

// --- chunkForExtraction (multi-pass for large docs) ---
ok(CE.chunkForExtraction('short doc').chunks.length === 1 && CE.chunkForExtraction('').chunks.length === 0, 'chunkForExtraction: small → 1 pass, empty → 0');
const bigLines = Array.from({ length: 300 }, (_, i) => `PERSON | Person ${i} | Title ${i} | Org ${i} | p${i}@example.org | - | -`);
const big = CE.chunkForExtraction(bigLines.join('\n'));   // ~19k chars → several passes
ok(big.chunks.length >= 2, `chunkForExtraction: large doc → multiple passes (got ${big.chunks.length})`);
ok(big.chunks.every(c => c.length <= CE.MAX_CHARS), 'chunkForExtraction: every pass within MAX_CHARS');
ok(big.chunks.join('\n') === bigLines.join('\n') && big.truncated === 0, 'chunkForExtraction: passes reassemble to the original (line-clean, nothing lost or split mid-record)');
const capped = CE.chunkForExtraction(bigLines.join('\n'), { max: 2 });
ok(capped.chunks.length === 2 && capped.truncated > 0, 'chunkForExtraction: respects the max-pass cap + reports the unscanned tail');

// --- parseContactTuples: what a model would emit → clean ingest rows ---
const raw = [
  'CONTACT | Brad Overcash | State Senator | NC General Assembly | Brad.Overcash@ncleg.gov | 919-733-5745 | 300 N. Salisbury St, Raleigh, NC 27603',
  'CONTACT | Rainey Center | - | - | info@raineycenter.org | (202) 555-0100 | 1455 Pennsylvania Ave NW, Washington DC',
  'CONTACT | Jane Doe | Director | Rainey Center | - | - | -',            // title qualifies (a real person) → KEPT
  'CONTACT | Bogus Person | - | - | not-an-email | 12 | -',               // no email/phone/title → dropped
  'Ted Alexander | Senator | NC Senate | ted.alexander@NCLEG.gov | - | -', // no CONTACT tag; email only; mixed case
  'Here is a prose summary line that should be ignored.',                  // no pipes → ignored
].join('\n');
const rows = CE.parseContactTuples(raw);
ok(rows.length === 4, `parseContactTuples: keeps 4 contactable tuples (got ${rows.length})`);
const brad = rows.find(r => r.name === 'Brad Overcash');
ok(brad && brad.email === 'brad.overcash@ncleg.gov', 'parseContactTuples: email lowercased');
ok(brad && brad.phone === '919-733-5745' && /Raleigh/.test(brad.address), 'parseContactTuples: phone + address captured');
ok(brad && brad.company === 'NC General Assembly' && brad.title === 'State Senator', 'parseContactTuples: title + affiliation');
ok(brad && brad.confidence === CE.DOC_CONFIDENCE, 'parseContactTuples: doc confidence stamped (pattern tier)');
ok(rows.some(r => r.name === 'Jane Doe' && r.title === 'Director'), 'parseContactTuples: KEEPS a titled person even with no email');
ok(!rows.some(r => r.name === 'Bogus Person'), 'parseContactTuples: drops a row with no email/phone/title');
const ted = rows.find(r => r.name === 'Ted Alexander');
ok(ted && ted.email === 'ted.alexander@ncleg.gov', 'parseContactTuples: tolerates a missing CONTACT tag, normalizes email case');

// --- the "missed people, landed place" fix: venues/events out, titled people in, address-alone out ---
const flyer = [
  'CONTACT | AC Hotel Raleigh Downtown | - | - | - | - | 9 Glenwood Ave, Raleigh, NC 27603',   // VENUE → rejected
  'CONTACT | Faith in Elections Prayer Breakfast | - | - | - | - | -',                         // EVENT → rejected
  'CONTACT | Ted Alexander | Senator, North Carolina | - | - | - | -',                          // titled person, no email → KEPT
  'CONTACT | Brad Overcash | Senator, North Carolina | - | - | - | -',                          // titled person, no email → KEPT
  'CONTACT | Address Only | - | - | - | - | 500 Main St, Raleigh NC',                           // no title/email, address alone → dropped
].join('\n');
const fr = CE.parseContactTuples(flyer);
ok(!fr.some(r => /hotel/i.test(r.name)), 'flyer: the VENUE (AC Hotel) is NOT landed as a contact');
ok(!fr.some(r => /breakfast/i.test(r.name)), 'flyer: the EVENT (Prayer Breakfast) is NOT landed as a contact');
ok(fr.some(r => r.name === 'Ted Alexander') && fr.some(r => r.name === 'Brad Overcash'), 'flyer: the two titled senators ARE captured (email pending)');
ok(!fr.some(r => r.name === 'Address Only'), 'flyer: an address-alone row (no title/contact) does NOT qualify');
ok(fr.length === 2, `flyer: exactly the 2 people, 0 places (got ${fr.length})`);

// --- land into an in-memory Puller: targets + observations + CITED beliefs ---
pdb.init({ path: ':memory:' });
const url = 'docstore:4242';
const stats = ingest.ingestRows(pdb, rows, { source: 'doc:Faith in Elections roster', sourceUrl: url, obsKind: 'doc' });
ok(stats.targets === 4, `ingestRows: minted 4 new targets — the "new objects" (got ${stats.targets})`);
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
ok(again.targets === 0 && again.skippedDup === 4, 'ingestRows: re-drop is idempotent (0 new, 4 already tracked)');

// --- findTargetByName (Slice B — meeting mention → known target) ---
ok(pdb.findTargetByName('Ted Alexander') && pdb.findTargetByName('Ted Alexander').name === 'Ted Alexander', 'findTargetByName: exact full name');
ok(pdb.findTargetByName('Overcash') && pdb.findTargetByName('Overcash').name === 'Brad Overcash', 'findTargetByName: unique last-name token → the full target');
ok(pdb.findTargetByName('Sen. Alexander') && pdb.findTargetByName('Sen. Alexander').name === 'Ted Alexander', 'findTargetByName: strips honorific ("Sen. Alexander" → Ted Alexander)');
ok(pdb.findTargetByName('Zzz Nobody') === null, 'findTargetByName: unknown → null (not surfaced)');

pdb.close();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
