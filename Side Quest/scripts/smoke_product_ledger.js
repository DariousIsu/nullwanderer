'use strict';
/* smoke_product_ledger.js — the pull-up gate's core (lib/product_ledger.js).
 * Hermetic: temp sq.db + temp notes dir. The load-bearing case is the LIVE miss verbatim (#11102):
 * "pull up that most recent list of ten people in Louisiana that we found contact information for"
 * must detect AND rank the inquiry-product doc above news/conversation/CRM noise.
 * Run: node scripts/smoke_product_ledger.js */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-smoke-'));
process.env.SQ_DB_PATH = path.join(tmp, 'sq.db');
const db = require(path.join(__dirname, '..', 'lib', 'db'));
db.init();
const pl = require(path.join(__dirname, '..', 'lib', 'product_ledger'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };

// ── detectAsk: the live miss + friends ──────────────────────────────────────────────────────────
const live = pl.detectAsk('Can you pull up that most recent list of ten people in Louisiana that we found contact information for?');
ok('live #11102 detects', !!live);
ok('live subject carries the real keywords', live && /louisiana/i.test(live.subject) && /contact/i.test(live.subject));
ok('shared-history phrasing detects', !!pl.detectAsk("show me that brief you wrote on the Hartfield Foundation"));
ok('"where\'s the X we put together" detects', !!pl.detectAsk("where's the parish spreadsheet we put together?"));
ok('"open the latest report" detects', !!pl.detectAsk('open the latest report on Green South'));

// negatives — build orders, data queries, content questions
ok('"make me a list" is a build, not a retrieval', !pl.detectAsk('Can you make me a list of Louisiana representatives?'));
ok('"build the final report on X" stays with report-cmd', !pl.detectAsk('I want you to build the final report on the Hartfield Foundation'));
ok('CRM record ask does not fire (not a product noun)', !pl.detectAsk('pull up the CRM record for John Smith'));
ok('content question does not fire', !pl.detectAsk('what does that report we made say about donors?'));
ok('no episodic anchor → no fire', !pl.detectAsk('show me a list of good restaurants'));

// ── searchProducts: ranking over seeded stores ──────────────────────────────────────────────────
const now = Date.now();
const idProduct = db.insertDocument({ title: 'Inquiry #201 touch 2 — What are the email addresses and office phone numbers for the ten Louisiana contacts Lucas asked about', body: '1. Jane Doe — jane@la.gov — (225) 555-0101 …', source: 'inquiry' }).id;
db.insertDocument({ title: 'News — Louisiana contact tracing budget passes committee', body: 'news body about louisiana contact tracing', source: 'news' });
db.insertDocument({ title: 'Conversation — Lucas asked about the Louisiana list', body: 'transcript where lucas asks for the list of contacts', source: 'conversation' });
const idOld = db.insertDocument({ title: 'Louisiana parish contacts survey (June)', body: 'old survey of louisiana contact points', source: 'autonomy' }).id;
try { db.getDb().prepare('UPDATE documents SET created_ts = ? WHERE id = ?').run(now - 40 * 86400000, idOld); } catch {}

const notesDir = path.join(tmp, 'notes');
fs.mkdirSync(notesDir);
fs.writeFileSync(path.join(notesDir, 'report-hartfield-foundation.md'), '# Report — Hartfield Foundation\nfindings…');
fs.writeFileSync(path.join(notesDir, 'unrelated-topic.md'), '# Something else entirely\nnothing here');

const hits = pl.searchProducts({ db, query: live.subject, notesDir, limit: 3, now });
ok('the inquiry product ranks first', hits.length && hits[0].kind === 'doc' && hits[0].id === idProduct);
ok('news is excluded', !hits.some((h) => /News —/.test(h.title)));
ok('conversation transcripts are excluded', !hits.some((h) => /Conversation/.test(h.title)));
ok('recency outranks the stale near-match', !hits.length || hits.findIndex((h) => h.id === idOld) !== 0);

const hHits = pl.searchProducts({ db, query: 'report hartfield foundation', notesDir, limit: 3, now });
ok('notes files are found', hHits.some((h) => h.kind === 'note' && /hartfield/.test(h.path)));

// FILENAME SIGNAL (08-09, B3 census): a deliverable is found by its NAME even with a THIN body —
// the fix for slice(-400) silently dropping the 64-parish deliverable at file #1169 of 1,963.
fs.writeFileSync(path.join(notesDir, 'acadia-parish-roster.md'), 'x');   // name carries the topic, body is nothing
const fnHits = pl.searchProducts({ db, query: 'acadia parish roster', notesDir, limit: 3, now });
ok('a note matched by FILENAME alone is found (thin body)', fnHits.some((h) => h.kind === 'note' && /acadia-parish-roster/.test(h.path)));

const miss = pl.searchProducts({ db, query: 'quarterly kraken sightings ledger', notesDir, limit: 3, now });
ok('an unmade product honestly misses', miss.length === 0);

// ── FAILURE RECORDS are not products (08-08 audit defect 4: doc #14529 verbatim shape) ─────────
// An inquiry closure that RECORDS A MISS documents the product's absence — presenting it as "the
// ACTUAL artifact" hands Lucas a failure note wearing the product's name.
db.insertDocument({ title: 'Inquiry #205 — the Gulf pipeline operators contact list Lucas asked about',
  body: 'The list could not be obtained: every registry search came up empty and the operator site was down.', source: 'inquiry' });
const failHits = pl.searchProducts({ db, query: 'Gulf pipeline operators contact list', notesDir, limit: 3, now });
ok('an inquiry FAILURE record never ranks as the product', !failHits.some((h) => /Gulf pipeline/.test(h.title)));
// ...but a SUCCESSFUL inquiry product still ranks (the doc #201-style real artifact from above)
ok('a successful inquiry product still ranks', pl.searchProducts({ db, query: live.subject, notesDir, limit: 3, now })
  .some((h) => h.kind === 'doc' && h.id === idProduct));

// ── SUPERSESSION (08-08 census): the finished product outranks its own earlier draft ────────────
// Live shape verbatim: the 9:01 AM "report-parish-leadership-of-louisiana" (whose body carried the
// extra weak token "list") outscored the complete "louisiana-parishes-leadership" made at 1:57 PM.
// Near-identical titles = one product line; the NEWEST version must lead, the draft trails.
fs.writeFileSync(path.join(notesDir, 'report-parish-leadership-of-louisiana.md'),
  '# Report — parish leadership of Louisiana\nA gap-analysis list of parish leadership…');
fs.writeFileSync(path.join(notesDir, 'louisiana-parishes-leadership.md'),
  '# Louisiana Parishes — Government & Leadership\nComplete rosters for all 64 parishes…');
const early = now - 5 * 3600000, late = now - 300000;
fs.utimesSync(path.join(notesDir, 'report-parish-leadership-of-louisiana.md'), early / 1000, early / 1000);
fs.utimesSync(path.join(notesDir, 'louisiana-parishes-leadership.md'), late / 1000, late / 1000);
const sib = pl.searchProducts({ db: { getDb: () => { throw new Error('notes only'); } }, query: 'Louisiana parish leadership list', notesDir, limit: 3, now });
ok('sibling versions both found', sib.filter((h) => /parish/i.test(h.title)).length >= 2);
ok('the NEWEST sibling leads (supersession)', sib.length && /louisiana-parishes-leadership\.md/.test(sib[0].path || ''));
ok('the draft trails as an alternate, not ahead', sib.findIndex((h) => /report-parish-leadership/.test(h.path || '')) > 0);
// different products with distinguishing tokens must NOT cluster (order still score-driven)
fs.writeFileSync(path.join(notesDir, 'louisiana-energy-companies.md'), '# Louisiana energy companies\ncorporate list…');
const dif = pl.searchProducts({ db: { getDb: () => { throw new Error('notes only'); } }, query: 'louisiana', notesDir, limit: 5, now });
ok('distinct products stay unclustered', dif.some((h) => /energy/.test(h.path || '')) && dif.some((h) => /parishes-leadership/.test(h.path || '')));

console.log(`smoke_product_ledger: ${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
