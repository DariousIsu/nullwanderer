/* smoke_birth_context.js — an object's ROUGH EDGE: where it was born, and what that refuses.
 *
 * Lucas: "What if we included rough edges in the new object creation from the context of where the
 * object was born. We have an issue with meetings being processed without context and leading to false
 * identifications, sounds like something similar here."
 *
 * The load-bearing property is that a birth context REFUSES and never asserts. A county website
 * publishing a name does not make the name a county thing — but a candidate reading placed in another
 * state is contradicted by it. That asymmetry is what makes a wrong prior cost a resolution instead of
 * manufacturing one.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_birth_context.js
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
process.env.SQ_DB_PATH = ':memory:';

const db = require('../lib/db');
db.init();
const bc = require('../lib/birth_context');
const enc = require('../lib/encounters');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ── reading a jurisdiction out of a hostname ─────────────────────────────────────────────────────
ok(bc.hostJurisdiction('apachecountyaz.gov').state === 'az', 'a place+state compound resolves');
ok(bc.hostJurisdiction('sec.state.ma.us').state === 'ma', 'a .us domain label resolves');
ok(bc.hostJurisdiction('nj.com').state === 'nj' && bc.hostJurisdiction('mlive.com').state === 'mi',
  'local mastheads resolve — they are the single largest source of births in the live log');

// THE GEORGIA→IOWA BUG. A two-letter suffix rule over a namespace containing full state names is a
// trap: georg-IA, califirn-IA, pennsylvan-IA, virgin-IA, louisia-NA, monta-NA. Whole names go first.
ok(bc.hostJurisdiction('team.georgia.gov').state === 'ga',
  'CRITICAL: georgia.gov is GEORGIA, not Iowa — the same mid-word matching that fired on Ro-NA-ld');
for (const [h, want] of [['legis.iowa.gov', 'ia'], ['lrb.hawaii.gov', 'hi'], ['archive.sos.idaho.gov', 'id']]) {
  ok(bc.hostJurisdiction(h).state === want, `a state name in ANY label resolves (${h})`);
}
ok(bc.hostJurisdiction('california.gov').state === 'ca' && bc.hostJurisdiction('virginia.gov').state === 'va',
  'the states whose names END in a different state code are read correctly');

// va.gov is the Department of Veterans Affairs, not Virginia.
ok(bc.hostJurisdiction('va.gov') === null,
  'CRITICAL: va.gov is Veterans Affairs — reading it as Virginia would falsely place every VA object');

// A national publisher has no jurisdiction, and inventing one would create a prior that refuses correct
// readings. Absence is the honest answer.
for (const h of ['foxnews.com', 'nasa.gov', 'irs.gov', 'gao.gov', '2009-2017.state.gov', '']) {
  ok(bc.hostJurisdiction(h) === null, `no jurisdiction is claimed for "${h || '(empty)'}"`);
}
ok(bc.hostJurisdiction(null) === null && bc.hostJurisdiction(undefined) === null, 'garbage in → null, never throws');

// ── THE REFUSE-ONLY RULE ─────────────────────────────────────────────────────────────────────────
ok(bc.contradicts({ state: 'ga' }, { state: 'wi' }) === true, 'a candidate in another state is contradicted');
ok(bc.contradicts({ state: 'ga' }, { state: 'ga' }) === false, 'agreement is not a contradiction');
ok(bc.contradicts({ state: 'ga' }, null) === false && bc.contradicts(null, { state: 'wi' }) === false,
  'CRITICAL: an unknown on either side is NOT a conflict — punishing absent metadata refuses most of the corpus');
ok(bc.contradicts({}, {}) === false, 'two unknowns are not a conflict either');

// ── the birth row is the EARLIEST encounter, because the log is append-only ──────────────────────
{
  const src = (h, hash, ref) => ({
    object_type: 'org', object_label: 'Osceola', claim_class: 'existence',
    source_kind: 'document', source_ref: ref, origin_host: h, content_hash: hash,
  });
  enc.record(src('applingcountyga.gov', 'h1', 'doc:1'));      // born here
  enc.record(src('foxnews.com', 'h2', 'doc:2'));              // seen later, elsewhere
  const key = enc.objectKey('org', 'Osceola');
  const ctx = bc.birthContext(key, { db });
  ok(ctx && ctx.host === 'applingcountyga.gov',
    'CRITICAL: the FIRST encounter is the birth — a later national mention does not relocate the object');
  ok(ctx.jurisdiction && ctx.jurisdiction.state === 'ga', 'and its jurisdiction comes with it');
  ok(ctx.lane === 'document' && ctx.sourceRef === 'doc:1', 'the lane and the citing document travel too');

  // The payoff: "Osceola" born in a Georgia county document is contradicted by a Wisconsin reading.
  ok(bc.contradicts(ctx.jurisdiction, { state: 'wi' }) === true,
    'CRITICAL: a Georgia-born Osceola refuses a Wisconsin candidate — this is the whole point');
  ok(bc.contradicts(ctx.jurisdiction, { state: 'ga' }) === false, '…and does not refuse a Georgia one');
}
ok(bc.birthContext('nope:nothing', { db }) === null && bc.birthContext(null, { db }) === null,
  'an object with no encounters has no birth context');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
