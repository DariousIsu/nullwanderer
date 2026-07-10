/* Smoke: lib/puller_supersession — a Puller belief FLIP routed through the D2 supersession law (F5.2).
 * Proof: a newer value with sufficient confidence supersedes the old (world-time), a STALE value that would
 * regress the belief is REFUSED (the anti-pattern guard), a WEAK new value is refused (confidence floor), the
 * same value is a no-op, and flipViaSupersession records the supersession on the append-only trail + flips the
 * single-valued belief. Then the end-to-end: an ACCEPTED revision goes through supersession, not an ad-hoc flip.
 *
 * Run: PULLER_DB_PATH=:memory: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_puller_supersession.js
 */
'use strict';
process.env.PULLER_DB_PATH = ':memory:';
const SS = require('../lib/puller_supersession');
const db = require('../lib/puller_db');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

console.log('== supersessionForFlip: the D2 law over a belief change ==');
const base = { targetId: 1, attr: 'email' };
ok(SS.supersessionForFlip({ ...base, from: { value: 'a@x.com', validFrom: 100, confidence: 0.8 }, to: { value: 'b@x.com', validFrom: 200, confidence: 0.8 } }).approved === true,
   'newer valid_from + confident → APPROVED replacement');
ok(SS.supersessionForFlip({ ...base, from: { value: 'a@x.com', validFrom: 200, confidence: 0.8 }, to: { value: 'b@x.com', validFrom: 100, confidence: 0.8 } }).reason === 'stale-would-regress',
   'an OLDER incoming value → REFUSED (anti-pattern guard: no ingest-recency overwrite of newer truth)');
ok(SS.supersessionForFlip({ ...base, from: { value: 'a@x.com', validFrom: 100, confidence: 0.8 }, to: { value: 'b@x.com', validFrom: 200, confidence: 0.2 } }).reason === 'weak-new-value',
   'a weak new value (below floor) → REFUSED (never supersede on a weak fact)');
ok(SS.supersessionForFlip({ ...base, from: { value: 'a@x.com', validFrom: 100, confidence: 0.8 }, to: { value: 'a@x.com', validFrom: 200, confidence: 0.9 } }).reason === 'same-value',
   'same value → no replacement');
ok(SS.supersessionForFlip({ ...base, from: { value: 'a@x.com', validFrom: null, confidence: 0.8 }, to: { value: 'b@x.com', validFrom: 200, confidence: 0.8 } }).reason === 'not-orderable',
   'missing world-time → not-orderable (left for operator, never guessed)');

console.log('== flipViaSupersession: applies an approved flip, refuses a stale one ==');
db.init();
const t = db.createTarget({ name: 'Flo Vance', domain: 'x.com' });
db.addObservation(t.id, { attr: 'email', value: 'flo.vance@x.com', kind: 'verified', source: 'seed' });
db.upsertBelief(t.id, 'email', { value: 'flo.vance@x.com', confidence: 0.8 });
// a NEWER, confident value supersedes
const r1 = SS.flipViaSupersession(db, { targetId: t.id, attr: 'email', toValue: 'f.vance@x.com', toConfidence: 0.8, toValidFrom: Date.now() + 1000 });
ok(r1.applied && r1.superseded, 'a newer confident value flips the belief as a supersession');
ok(db.getBelief(t.id, 'email').value === 'f.vance@x.com', 'the belief now holds the new value');
const supObs = db.listObservations(t.id, { attr: 'email' }).filter(o => o.kind === 'superseded');
ok(supObs.length === 1 && supObs[0].value === 'flo.vance@x.com', 'the OLD value is recorded superseded on the append-only trail');
// a STALE re-discovery of the original does NOT overwrite the newer truth
const r2 = SS.flipViaSupersession(db, { targetId: t.id, attr: 'email', toValue: 'flo.vance@x.com', toConfidence: 0.9, toValidFrom: 1 });
ok(!r2.applied && r2.reason === 'stale-would-regress', 'a stale re-discovery is REFUSED — the newer value stands');
ok(db.getBelief(t.id, 'email').value === 'f.vance@x.com', 'the belief is unchanged by the stale attempt');

console.log('== first-assert: no prior belief → plain assertion (not a supersession) ==');
const t2 = db.createTarget({ name: 'New Person' });
const r3 = SS.flipViaSupersession(db, { targetId: t2.id, attr: 'email', toValue: 'new@x.com', toConfidence: 0.8 });
ok(r3.applied && !r3.superseded, 'a first value is asserted, not superseded');

console.log('== end-to-end: an accepted revision flips VIA supersession ==');
const revise = require('../studio/puller_revise');
const B = require('../studio/puller_beliefs');
const t3 = db.createTarget({ name: 'Bo Kim', company: 'Co', domain: 'co.com' });
db.savePatternState('co.com', B.seedPrior(B.seedPrior(B.emptyState(), 'first.last', 0.6), 'flast', 0.5));
db.addObservation(t3.id, { attr: 'email', value: 'bo.kim@co.com', kind: 'verified', source: 'seed' });
db.upsertBelief(t3.id, 'email', { value: 'bo.kim@co.com', confidence: 0.8 });
// small delay so the current belief's updated_at is strictly < the flip time
const outcome = revise.applyVerification(t3.id, { value: 'bo.kim@co.com', result: 'invalid' });
ok(outcome.revisionId, 'a bounce proposed a flip revision');
const decision = revise.decideRevision(outcome.revisionId, 'accepted');
ok(decision.applied === true && decision.superseded === true, 'accepting the revision applied it AS a supersession');
ok(decision.supersessionReason === 'newer_valid_from', 'the flip carried the D2 reason (newer_valid_from)');

db.close();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
