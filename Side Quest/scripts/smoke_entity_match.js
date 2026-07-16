/* Smoke: lib/entity_match — the PRECISION MATCHER core (node-resolution-&-fusion gate, build step 1).
 * The acceptance test IS the real failure cases: the Howell/Cole false merges must be NO-MATCH, the LAMP
 * surname fan-out must never auto-merge, and the McHenry/strong-id true matches must MATCH.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_entity_match.js
 */
'use strict';
const M = require('../lib/entity_match');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const P = (name, extra = {}) => ({ name, type: 'person', ...extra });
const O = (name, type = 'organization') => ({ name, type });
const dec = (a, b) => M.matchPair(a, b).decision;

// --- parseEntity: ids + jurisdiction + given/surname ------------------------------------------------
const pe = M.parseEntity(P('Janet D. Howell (VA)'));
ok(pe.given === 'Janet' && pe.surname === 'Howell' && pe.jurisdiction === 'VA', 'parse: given/surname/jurisdiction from "Janet D. Howell (VA)"');
ok(M.parseEntity({ name: 'Kevin McCarty [wd:Q6396892]' }).ids.wikidata === 'Q6396892', 'parse: [wd:Q…] → wikidata id');
ok(M.parseEntity({ name: 'MR FOR OHIO STATE SENATE [FEC:C00890582]' }).ids.fec === 'C00890582', 'parse: [FEC:C…] → fec id');
ok(M.parseEntity({ name: 'CITY OF SACRAMENTO [lda_client:119039]', type: 'organization' }).ids.lda === '119039', 'parse: [lda_client:…] → lda id');
ok(M.parseEntity({ name: 'Elizabeth Mathis [M000244]' }).ids.bioguide === 'M000244', 'parse: [M######] → bioguide id');
ok(M.parseEntity(P('Chang (HI)')).given === null && M.parseEntity(P('Chang (HI)')).surname === 'Chang', 'parse: single-token person = surname only (no fabricated given)');

// --- Tier 1: DETERMINISTIC strong-id ----------------------------------------------------------------
ok(M.matchPair(P('Kevin McCarty [wd:Q6396892]'), P('Kevin McCarty [wd:Q6396892]')).tier === 'strong-id', 'strong-id: same QID → match (tier strong-id)');
ok(dec(P('Kevin McCarty [wd:Q6396892]'), P('K. McCarty [wd:Q6396892]')) === 'match', 'strong-id: same QID wins even when surface names differ');
ok(dec(P('Kevin McCarty [wd:Q6396892]'), P('Kevin McCarty [723bd312]')) === 'review', 'strong-id: DIFFERENT-system ids (wd vs openstates) don\'t auto-merge — full name → review');

// --- THE HOWELL / COLE FALSE MERGES → must be NO-MATCH -----------------------------------------------
ok(dec(P('Janet D. Howell (VA)'), P('William J. Howell (VA)')) === 'no-match', 'HOWELL: Janet ≠ William (given-name conflict) → NO-MATCH (the false merge this system made)');
ok(M.matchPair(P('Janet D. Howell (VA)'), P('William J. Howell (VA)')).reason === 'given-name-conflict', 'HOWELL: reason is the given-name gate, not a score');
ok(dec(P('Mark L. Cole (VA)'), P('Joshua G. Cole (VA)')) === 'no-match', 'COLE: Mark ≠ Joshua → NO-MATCH');
ok(dec(P('J. Howell (VA)'), P('William Howell (VA)')) === 'no-match', 'initial conflict: "J." ≠ William → NO-MATCH (disagreeing initial is still a conflict)');

// --- true person matches → MATCH --------------------------------------------------------------------
ok(dec(P('Patrick McHenry (US-US)'), P('Patrick T. McHenry (US)')) === 'match', 'McHENRY: full given+surname, compatible federal jurisdiction → MATCH');
ok(dec(P('W. Howell (VA)'), P('William Howell (VA)')) === 'review', 'weak given (initial agrees) + surname + jurisdiction, no corroboration → REVIEW (not an auto-merge)');
ok(dec(P('John Smith (VA)'), P('John Smith (CA)')) === 'review', 'same full name, DIFFERENT jurisdiction → REVIEW (possible move, never auto-merge)');

// --- THE LAMP FAN-OUT → surname+jurisdiction alone must NOT auto-merge -------------------------------
ok(dec(P('Chang (HI)'), P('David Chang (HI)')) === 'review', 'LAMP: bare surname "Chang (HI)" vs "David Chang (HI)" → REVIEW, not match (insufficient corroboration)');
ok(dec(P('Chang (HI)'), P('Stanley Chang (HI)')) === 'review', 'LAMP: bare surname vs a different Chang → REVIEW');
// corroboration RESCUES a weak-given case: same office promotes surname+jurisdiction to a match
ok(dec(P('Chang (HI)', { office: 'hi house district 23' }), P('David Chang (HI)', { office: 'hi house district 23' })) === 'match', 'corroboration: surname+jurisdiction+shared office → MATCH (weak given rescued by a real field)');

// --- non-person (org/place): identical name ≠ identical entity without a shared id -------------------
ok(dec(O('CITY OF SACRAMENTO [lda_client:119039]'), O('CITY OF SACRAMENTO [lda_client:69925]')) === 'review', 'org: identical name but CONFLICTING lda ids → REVIEW (needs a human/collective step, not auto-merge)');
ok(dec(O('CITY OF SACRAMENTO'), O('CITY OF WEST SACRAMENTO')) === 'no-match', 'org: "CITY OF SACRAMENTO" ≠ "CITY OF WEST SACRAMENTO" → NO-MATCH');
ok(dec(O('CITY OF SACRAMENTO [lda_client:5]'), O('CITY OF SACRAMENTO [lda_client:5]')) === 'match', 'org: same lda id → MATCH (strong-id)');
ok(dec(O('Acme Corp'), O('Acme Corp')) === 'review', 'org: identical name, no id on either side → REVIEW');

// --- resolveAgainst: the ANTI-FAN rule --------------------------------------------------------------
console.log('== resolveAgainst (anti-fan) ==');
const r1 = M.resolveAgainst(P('Kevin McCarty [wd:Q6396892]'), [P('Kevin McCarty [wd:Q6396892]'), P('Kevin McCarty [723bd312]')]);
ok(r1.action === 'merge' && r1.tier === 'strong-id', 'resolve: a single strong-id match wins outright');
const r2 = M.resolveAgainst(P('Chang (HI)'), [P('David Chang (HI)'), P('Stanley Chang (HI)'), P('Mel Chang (HI)')]);
ok(r2.action === 'review', 'resolve: a bare surname against many same-surname candidates → REVIEW, never fan onto all of them (the LAMP bug)');
const r3 = M.resolveAgainst(P('Patrick McHenry (US-US)'), [P('Patrick T. McHenry (US)'), P('Nancy Pelosi (US)')]);
ok(r3.action === 'merge' && r3.target.name === 'Patrick T. McHenry (US)', 'resolve: exactly one probabilistic match, no competitors → merge to it');
const r4 = M.resolveAgainst(P('Brand New Person (TX)'), [P('Someone Else (TX)'), P('Nobody Here (TX)')]);
ok(r4.action === 'mint', 'resolve: no candidate matches → MINT (genuinely new, hand to the Slice-2 mint path)');
const r5 = M.resolveAgainst(P('John Smith (VA)'), [P('John Smith (VA)'), P('John Q. Smith (VA)', { office: 'x' })]);
ok(r5.action === 'review', 'resolve: two plausible matches → REVIEW (anti-fan hold), never guess');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
