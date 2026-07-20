/* smoke_covered_union.js — db.coveredForBeat: a beat's work lives on EVERY thread that ever ran it.
 *
 * The bug (measured live, 2026-07-20). `sched.autonomic` maps a beat to ONE focus thread, and coverage
 * read only that thread's `covered` list. A re-seeded beat gets a NEW thread and leaves its finished
 * work on the old one — county-commissions-la had five threads holding 3, 22, 21, 21 and 17 parishes
 * with the scheduler pointing at the one holding 3. So 81 completed parishes were invisible, the
 * portfolio read 63% of the work actually done, and when Lucas asked how many parishes were finished
 * she answered "24 of 64" — one thread's slice, which was genuinely all the reader could see.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_covered_union.js
 */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_covunion_${process.pid}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require(path.join(__dirname, '..', 'lib', 'db'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗ FAIL:', m); } };

db.init();

// Rebuild the live shape: one beat, several threads, only one of them "current".
db.setMeta('focus.100.beat', 'county-commissions-la');
db.setMeta('focus.100.covered', JSON.stringify(['Acadia Parish Police Jury', 'Allen Parish Police Jury']));
db.setMeta('focus.200.beat', 'county-commissions-la');
db.setMeta('focus.200.covered', JSON.stringify(['Caddo Parish Commission', 'Bossier Parish Police Jury']));
db.setMeta('focus.300.beat', 'county-commissions-la');
db.setMeta('focus.300.covered', JSON.stringify(['East Baton Rouge Parish Metropolitan Council']));
// A different beat must not bleed in.
db.setMeta('focus.400.beat', 'county-commissions-fl');
db.setMeta('focus.400.covered', JSON.stringify(['Alachua County Commission']));
// A thread with no beat at all (a chat-originated run) is not part of any beat's coverage.
db.setMeta('focus.500.covered', JSON.stringify(['Some Ad-hoc Target']));
db.setMeta('sched.autonomic', JSON.stringify({ beats: { 'county-commissions-la': { thread: '300' } } }));

const la = db.coveredForBeat('county-commissions-la');
ok(la.length === 5, `THE FIX: all five entries across three threads (got ${la.length})`);
ok(la.includes('Acadia Parish Police Jury') && la.includes('Caddo Parish Commission'),
  'CRITICAL: work from threads the scheduler no longer points at is included');
ok(la.includes('East Baton Rouge Parish Metropolitan Council'), 'the current thread is included too');
ok(!la.includes('Alachua County Commission'), 'CRITICAL: another beat\'s work does not bleed in');
ok(!la.includes('Some Ad-hoc Target'), 'a thread with no beat belongs to no beat');

// Union, not sum — the same jurisdiction researched twice counts once.
db.setMeta('focus.600.beat', 'county-commissions-la');
db.setMeta('focus.600.covered', JSON.stringify(['Acadia Parish Police Jury', 'Iberia Parish Government']));
const la2 = db.coveredForBeat('county-commissions-la');
ok(la2.length === 6, `duplicate across threads counted ONCE (got ${la2.length}, expected 6)`);
ok(la2.filter((x) => x === 'Acadia Parish Police Jury').length === 1, 'CRITICAL: union, never sum');

// Degenerate inputs are fail-soft — coverage bookkeeping must never break research.
ok(db.coveredForBeat('no-such-beat').length === 0, 'unknown beat → empty, never throws');
ok(db.coveredForBeat('').length === 0, 'empty beat id → empty');
ok(db.coveredForBeat(null).length === 0, 'null beat id → empty');

// Malformed JSON on one thread must not lose the others.
db.setMeta('focus.700.beat', 'county-commissions-la');
db.setMeta('focus.700.covered', '{not json');
ok(db.coveredForBeat('county-commissions-la').length === 6, 'a corrupt thread is skipped, the rest survive');

try { fs.unlinkSync(tmp); } catch {}
console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
