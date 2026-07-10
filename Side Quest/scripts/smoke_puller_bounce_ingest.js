/* Smoke: lib/puller_ipc.applyBounceRows — the drop-zone application path (F4.2), end-to-end on an
 * in-memory puller.db. Proof: a format-agnostic bounce report resolves to targets and drives the
 * negative-signal loop — a HARD bounce on the held email proposes a pattern flip; a SOFT bounce is
 * deferred (no flip); a COMPLAINT is recorded as suppression WITHOUT marking the address invalid; an
 * unmatched address is counted, not invented.
 *
 * Run: PULLER_DB_PATH=:memory: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_puller_bounce_ingest.js
 */
'use strict';
process.env.PULLER_DB_PATH = ':memory:';
const db = require('../lib/puller_db');
const ipc = require('../lib/puller_ipc');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

db.init();
// a tracked person whose held email follows first.last at a domain we've seen work → so a bounce can flip
const t = db.createTarget({ kind: 'person', name: 'Jane Doe', company: 'Acme', domain: 'acme.com' });
db.addObservation(t.id, { attr: 'email', value: 'jane.doe@acme.com', kind: 'verified', source: 'seed' });
db.upsertBelief(t.id, 'email', { value: 'jane.doe@acme.com', confidence: 0.8, derivation: 'seed' });
// give the domain a prior so the flip has a next-pattern to reach for
const B = require('../studio/puller_beliefs');
db.savePatternState('acme.com', B.seedPrior(B.seedPrior(B.emptyState(), 'first.last', 0.6), 'flast', 0.5));

console.log('== HARD bounce (DSN 5.1.1) on the held email → flip proposed ==');
const dsn = [
  'Content-Type: message/delivery-status', '',
  'Final-Recipient: rfc822; jane.doe@acme.com', 'Action: failed', 'Status: 5.1.1', '',
].join('\n');
const s1 = ipc.applyBounceRows(dsn);
ok(s1.format === 'dsn' && s1.matched === 1 && s1.applied === 1, 'dsn matched the target and applied');
ok(s1.flips === 1, 'a hard bounce on the held value proposed a pattern-flip revision');
ok(db.listRevisions({ status: 'pending', targetId: t.id }).length === 1, 'the revision is queued for operator review');

console.log('== SOFT bounce (4.x.x) → deferred, no flip, no belief damage ==');
const t2 = db.createTarget({ kind: 'person', name: 'Sam Roe', domain: 'beta.com' });
db.upsertBelief(t2.id, 'email', { value: 'sam.roe@beta.com', confidence: 0.8, derivation: 'seed' });
db.addObservation(t2.id, { attr: 'email', value: 'sam.roe@beta.com', kind: 'verified', source: 'seed' });
const soft = 'Final-Recipient: rfc822; sam.roe@beta.com\nAction: failed\nStatus: 4.4.1\n';
const s2 = ipc.applyBounceRows(soft);
ok(s2.deferred === 1 && s2.applied === 0, 'soft bounce is DEFERRED — not applied as a negative');
ok(db.listRevisions({ status: 'pending', targetId: t2.id }).length === 0, 'no flip proposed on a soft bounce');

console.log('== COMPLAINT (ARF) → suppression recorded, validity untouched ==');
const t3 = db.createTarget({ kind: 'person', name: 'Kai Lee', domain: 'gamma.com' });
db.upsertBelief(t3.id, 'email', { value: 'kai.lee@gamma.com', confidence: 0.8, derivation: 'seed' });
db.addObservation(t3.id, { attr: 'email', value: 'kai.lee@gamma.com', kind: 'verified', source: 'seed' });
const arf = 'Feedback-Type: abuse\nOriginal-Rcpt-To: rfc822; kai.lee@gamma.com\n';
const s3 = ipc.applyBounceRows(arf);
ok(s3.format === 'arf' && s3.suppressed === 1 && s3.applied === 0, 'complaint counted as suppressed, NOT applied as invalid');
const supp = db.listObservations(t3.id, { attr: 'email' }).filter(o => o.kind === 'suppressed');
ok(supp.length === 1 && supp[0].meta && supp[0].meta.suppression === true, 'a suppression observation is on the timeline');
const Q = require('../studio/puller_confidence');
ok(Q.qualify(db.listObservations(t3.id, { attr: 'email' }), 'kai.lee@gamma.com').confidence >= 0.8,
   'the address keeps its qualification — suppression did NOT poison the validity belief');

console.log('== unmatched address is counted, never invented ==');
const s4 = ipc.applyBounceRows('nobody@nowhere.com,invalid\n', { format: 'csv' });
ok(s4.unmatched === 1 && s4.matched === 0, 'an address we do not track → unmatched, no target created');

console.log('== testList flag stamps the observation weight ==');
const s5 = ipc.applyBounceRows('jane.doe@acme.com,valid\n', { format: 'csv', testList: true });
ok(s5.applied === 1, 'a test-list valid result applies');

console.log('== duplicate events for ONE mailbox collapse to a single signal (no dup revisions / miss-inflation) ==');
const dt = db.createTarget({ kind: 'person', name: 'Dup Person', company: 'Dc', domain: 'dc.com' });
db.addObservation(dt.id, { attr: 'email', value: 'dup.person@dc.com', kind: 'verified', source: 'seed' });
db.upsertBelief(dt.id, 'email', { value: 'dup.person@dc.com', confidence: 0.8 });
db.savePatternState('dc.com', B.seedPrior(B.seedPrior(B.emptyState(), 'first.last', 0.6), 'flast', 0.5));
const dumpJson = JSON.stringify([
  { email: 'dup.person@dc.com', event: 'bounce', type: 'bounce' },
  { email: 'dup.person@dc.com', event: 'bounce', type: 'bounce' },
  { email: 'dup.person@dc.com', event: 'bounce', type: 'bounce' },
]);
const sd = ipc.applyBounceRows(dumpJson);
ok(sd.parsed === 3 && sd.unique === 1, 'three duplicate events parse but collapse to ONE unique mailbox');
ok(sd.applied === 1 && sd.flips === 1, 'applied ONCE → exactly one flip revision (was 2 before the fix)');
ok(db.listRevisions({ status: 'pending', targetId: dt.id }).length === 1, 'exactly one pending revision, not a pile of duplicates');
ok(((db.getPatternState('dc.com').patterns['first.last'] || {}).misses || 0) === 1, 'the domain Beta recorded ONE miss from one mailbox, not three');
ok(sd.infra === 0, 'a single mailbox no longer falsely trips the gateway-block detector');

db.close();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
