/* Smoke: lib/certainty — the UNIFIED certainty model (F5.1). Proof: one evidence state projects into TWO
 * readings that share the grade vocabulary + the recency-decay curve. Corroboration RAISES the KG pTrue but
 * NOT the Puller send cap; a bounce floors send-safety but is a separate axis; recency decays both together;
 * and fromObservations gives a Puller belief a KG-consumable pTrue without changing its send number at age 0.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_certainty.js
 */
'use strict';
const C = require('../lib/certainty');
const puller = require('../studio/puller_confidence');
const model = require('../lib/confidence_model');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

console.log('== two readings off one state; shared grade vocabulary ==');
const b1 = C.certainty({ grade: 'B', corroboration: 1 });
ok(near(b1.sendConfidence, puller.CAP.B), 'send reading = the Puller grade cap (B → 0.95)');
ok(near(b1.pTrue, model.GRADE_PRIOR.B), 'KG reading = the calibrated grade prior (B → 0.88)');
ok(b1.grade === 'B', 'grade echoed');

console.log('== corroboration RAISES pTrue, never the send cap ==');
const b3 = C.certainty({ grade: 'B', corroboration: 3 });
ok(b3.pTrue > b1.pTrue, 'more independent sources → higher pTrue (truth-discovery)');
ok(near(b3.sendConfidence, b1.sendConfidence), 'send cap unchanged by corroboration (send-safety policy)');
ok(b3.pTrue < 0.995, 'pTrue stays under the ceiling');

console.log('== a bounce floors the SEND reading (its own axis) ==');
const conf = C.certainty({ grade: 'B', corroboration: 3, conflicted: true });
ok(near(conf.sendConfidence, puller.NEG_CAP), 'conflicted → send-safety floored to NEG_CAP (≤0.20)');
ok(conf.pTrue > 0.2, 'pTrue is a separate axis — a send-conflict does not zero the KG belief here');

console.log('== recency decays BOTH readings together ==');
const fresh = C.certainty({ grade: 'A', corroboration: 1, attr: 'email', ageDays: 0 });
const stale = C.certainty({ grade: 'A', corroboration: 1, attr: 'email', ageDays: 550 });  // ~1 half-life (WORKS_FOR)
ok(stale.sendConfidence < fresh.sendConfidence && stale.pTrue < fresh.pTrue, 'aging lowers send AND pTrue');
ok(near(stale.recency, 0.5, 0.02), 'one half-life → recency factor ≈ 0.5');
const immutable = C.certainty({ grade: 'A', corroboration: 1, attr: 'name', ageDays: 5000 });
ok(near(immutable.recency, 1), 'an immutable attribute (name) never decays');

console.log('== monotonicity: better grade ⇒ both readings no lower ==');
const grades = ['E', 'D', 'C', 'B', 'A'];
let mono = true;
for (let i = 1; i < grades.length; i++) {
  const lo = C.certainty({ grade: grades[i - 1] }), hi = C.certainty({ grade: grades[i] });
  if (hi.pTrue < lo.pTrue || hi.sendConfidence < lo.sendConfidence) mono = false;
}
ok(mono, 'pTrue and sendConfidence both rise monotonically A>B>C>D>E');

console.log('== fromObservations: Puller pile → both readings, send unchanged at age 0 ==');
const obs = [
  { value: 'jane@acme.com', kind: 'verified', source: 'hunter' },      // grade B
  { value: 'jane@acme.com', kind: 'pattern', source: 'derivation' },   // grade C (independent source)
];
const u = C.fromObservations(obs, 'jane@acme.com', { attr: 'email', ageDays: 0 });
const q = puller.qualify(obs, 'jane@acme.com');
ok(near(u.sendConfidence, q.confidence), 'send reading is byte-identical to the existing qualify() ratchet at age 0');
ok(u.corroboration === 2 && u.pTrue > model.GRADE_PRIOR[q.grade], 'two independent sources lifted pTrue above the single-source prior');
ok(u.grade === q.grade, 'grade agrees with qualify()');

console.log('== aged Puller belief never presents staler-as-safer ==');
const aged = C.fromObservations(obs, 'jane@acme.com', { attr: 'email', ageDays: 800 });
ok(aged.sendConfidence <= q.confidence, 'an aged send reading is never higher than the fresh ratchet');

console.log('== a bounced value floors send but the OTHER value keeps its own certainty ==');
const obs2 = [
  { value: 'old@acme.com', kind: 'verified', source: 's1' },
  { value: 'old@acme.com', kind: 'bounce', source: 's2' },
  { value: 'new@acme.com', kind: 'verified', source: 's3' },
];
ok(C.fromObservations(obs2, 'old@acme.com', { attr: 'email' }).conflicted === true, 'the bounced value is conflicted');
ok(C.fromObservations(obs2, 'new@acme.com', { attr: 'email' }).conflicted === false, 'a different held value is NOT dragged down by the old bounce');

console.log('== firewall: no randomness in the confidence-write path (2026-08-18) ==');
const fs = require('fs'), path = require('path');
const certSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'certainty.js'), 'utf8');
ok(!/Math\.random/.test(certSrc), 'lib/certainty.js has NO Math.random() — pTrue inputs are deterministic');
// identity-less gradeable observations collapse to ONE source bucket (never inflate corroboration by count)
const idless = [{ value: 'x', kind: 'verified' }, { value: 'x', kind: 'verified' }];  // grade B, no source/id
ok(C.fromObservations(idless, 'x', { attr: 'email' }).corroboration === 1, 'two identity-less same-kind obs count as ONE source, not two');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
