/* scripts/smoke_puller_confidence.js — offline checks for the capped-ratchet qualification model.
 * Run: node scripts/smoke_puller_confidence.js  (pure, no db) */
'use strict';
const Q = require('../studio/puller_confidence');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

// ladder + mapping
ok('caps ordered A>B>C>D>E', Q.CAP.A === 1 && Q.CAP.B === 0.95 && Q.CAP.C === 0.80 && Q.CAP.D === 0.50 && Q.CAP.E === 0.30);
ok('gradeOf verified→B', Q.gradeOf('verified') === 'B');
ok('gradeOf pattern→C', Q.gradeOf({ kind: 'pattern' }) === 'C');
ok('gradeOf guess→D', Q.gradeOf('guess') === 'D');
ok('gradeOf generic→E', Q.gradeOf('generic') === 'E');
ok('gradeOf business_card→A', Q.gradeOf('business_card') === 'A');
ok('gradeOf bounce→neg', Q.gradeOf('bounce') === 'neg');
ok('gradeOf unknown→null', Q.gradeOf('whatever') === null);

// capped ratchet: highest grade wins, capped at its tier
ok('single C → 80%', Q.qualify([{ kind: 'pattern', value: 'a@x.com' }]).confidence === 0.80);
const climb = Q.qualify([
  { kind: 'guess', value: 'a@x.com', captured_at: 1 },
  { kind: 'pattern', value: 'a@x.com', captured_at: 2 },
  { kind: 'verified', value: 'a@x.com', captured_at: 3 },
]);
ok('ratchet picks highest grade (B)', climb.grade === 'B' && climb.confidence === 0.95);
ok('corroboration does NOT exceed cap', Q.qualify([
  { kind: 'pattern', value: 'a@x.com' }, { kind: 'pattern', value: 'a@x.com' }, { kind: 'pattern', value: 'a@x.com' },
]).confidence === 0.80);

// only grade-A reaches 100%
const a = Q.qualify([{ kind: 'business_card', value: 'a@x.com' }]);
ok('grade-A unlocks 100%', a.confidence === 1.00 && a.grade === 'A' && /fully qualified/.test(a.note));
ok('non-A note asks for dedicated source', /grade-A/.test(Q.qualify([{ kind: 'verified', value: 'a@x.com' }]).note));

// negative on the held value caps it down + flags conflict
const conf = Q.qualify([
  { kind: 'verified', value: 'a@x.com', captured_at: 1 },
  { kind: 'bounce', value: 'a@x.com', captured_at: 2 },
]);
ok('bounce on held value caps to NEG_CAP', conf.confidence === Q.NEG_CAP && conf.conflicted === true);
ok('bounce note says re-derive', /re-derive/.test(conf.note));
// a bounce on a DIFFERENT value doesn't drag the held one down
ok('bounce on other value → no conflict', Q.qualify([
  { kind: 'verified', value: 'a@x.com' }, { kind: 'bounce', value: 'old@x.com' },
]).confidence === 0.95);

// no positive evidence
const none = Q.qualify([{ kind: 'bounce', value: 'a@x.com' }]);
ok('only negatives → 0 confidence, conflicted', none.confidence === 0 && none.grade === null && none.conflicted === true);
ok('empty → 0', Q.qualify([]).confidence === 0);

console.log(`\nsmoke_puller_confidence: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
