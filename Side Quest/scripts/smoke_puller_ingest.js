/* scripts/smoke_puller_ingest.js — offline checks for studio/puller_ingest (in-memory db).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_puller_ingest.js */
'use strict';
const I = require('../studio/puller_ingest');
const B = require('../studio/puller_beliefs');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

// ---- pure helpers ----
ok('parseConfidence "95%"', I.parseConfidence('95%') === 0.95);
ok('parseConfidence "80 %"', I.parseConfidence('80 %') === 0.80);
ok('parseConfidence null', I.parseConfidence(null) === null);
ok('tierKind verified', I.tierKind(0.95) === 'verified');
ok('tierKind pattern', I.tierKind(0.80) === 'pattern');
ok('tierKind guess', I.tierKind(0.50) === 'guess');
ok('tierKind generic', I.tierKind(0.30) === 'generic');
ok('domainOf', I.domainOf('a.b@aes.com') === 'aes.com');
ok('creditsPattern verified/pattern only', I.creditsPattern('verified') && I.creditsPattern('pattern') && !I.creditsPattern('guess') && !I.creditsPattern('generic'));

const DB = require('../lib/puller_db');
DB.init({ path: ':memory:' });

const rows = [
  { confidence: '95%', name: 'Mark Miller', title: 'VP GA', company: 'AES', email: 'mark.miller@aes.com' },
  { confidence: '80%', name: 'Jane Doe', company: 'AES', email: 'jane.doe@aes.com' },
  { confidence: '80%', name: 'Brian Huseman', company: 'Amazon', email: 'bhuseman@amazon.com' },
  { confidence: '50%', name: 'Guess Person', company: 'Acme', email: 'guess.person@acme.com' },
  { confidence: '30%', name: 'Press Team', company: 'Acme', email: 'press@acme.com' },
  { confidence: '95%', name: 'Mark Miller', company: 'AES', email: 'mark.miller@aes.com' }, // dup (name|company)
  { confidence: '80%', name: '', company: 'X', email: 'a@x.com' },                          // no name
];

const s = I.ingestRows(DB, rows, { source: 'test' });
ok('targets created = 5', s.targets === 5);
ok('skippedDup = 1', s.skippedDup === 1);
ok('noName = 1', s.noName === 1);
ok('generic counted = 1', s.generic === 1);
ok('patternHits = 3 (2 AES + 1 Amazon)', s.patternHits === 3);

// AES first.last credited twice → strong belief, best pattern
const aes = DB.getPatternState('aes.com');
ok('aes.com first.last hits = 2', aes.patterns['first.last'] && aes.patterns['first.last'].hits === 2);
ok('aes.com best = first.last', B.bestPattern(aes) === 'first.last');
// Amazon flast credited
const amz = DB.getPatternState('amazon.com');
ok('amazon.com flast hits = 1', amz.patterns.flast && amz.patterns.flast.hits === 1);
ok('amazon.com best = flast', B.bestPattern(amz) === 'flast');
// guess + generic domains get NO pattern credit
ok('acme.com gets no pattern credit', Object.keys(DB.getPatternState('acme.com').patterns).length === 0);

// beliefs/observations landed
const targets = DB.listTargets({ limit: 100 });
const mark = targets.find(t => t.name === 'Mark Miller');
ok('Mark target has domain aes.com', mark && mark.domain === 'aes.com');
ok('Mark email belief @0.95', DB.getBelief(mark.id, 'email').value === 'mark.miller@aes.com' && DB.getBelief(mark.id, 'email').confidence === 0.95);
ok('Mark role belief stored', DB.getBelief(mark.id, 'role').value === 'VP GA');
ok('Mark has 2 observations (email+role)', DB.listObservations(mark.id).length === 2);

// idempotency: re-running creates nothing new
const s2 = I.ingestRows(DB, rows, { source: 'test' });
ok('re-run creates 0 targets (idempotent)', s2.targets === 0 && s2.skippedDup === 6);

DB.close();
console.log(`\nsmoke_puller_ingest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
