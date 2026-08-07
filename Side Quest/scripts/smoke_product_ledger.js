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

const miss = pl.searchProducts({ db, query: 'quarterly kraken sightings ledger', notesDir, limit: 3, now });
ok('an unmade product honestly misses', miss.length === 0);

console.log(`smoke_product_ledger: ${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
