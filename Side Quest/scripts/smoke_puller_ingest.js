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

// ---- contactToRow / contactsToRows (the puller_add tool bridge: research find → ingest row) ----
ok('contactToRow: verified email → 95%', I.contactToRow({ name: 'Ann Lee', title: 'CEO', email: 'ann.lee@acme.com', verified: true }, 'Acme').confidence === '95%');
ok('contactToRow: plain email → 50% candidate (no pattern pollution)', I.contactToRow({ name: 'Ann Lee', email: 'ann.lee@acme.com' }, 'Acme').confidence === '50%');
ok('contactToRow: role/position aliases → title', I.contactToRow({ name: 'B', role: 'CFO' }).title === 'CFO' && I.contactToRow({ name: 'C', position: 'COO' }).title === 'COO');
ok('contactToRow: default company filled', I.contactToRow({ name: 'D', email: 'd@x.com' }, 'DefaultCo').company === 'DefaultCo');
ok('contactToRow: explicit confidence wins', I.contactToRow({ name: 'E', confidence: '80%', email: 'e@x.com' }).confidence === '80%');
ok('contactsToRows: parses a JSON string + drops the nameless', I.contactsToRows('[{"name":"F","email":"f@x.com"},{"name":""}]', 'Co').length === 1);

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
  { confidence: '95%', name: 'Finance Director', company: 'AES', email: 'finance@aes.com' }, // #43: a ROLE, not a person → dropped
];

const s = I.ingestRows(DB, rows, { source: 'test' });
ok('targets created = 5', s.targets === 5);   // the role row does NOT become a 6th target
ok('#43 junkName = 1 (role dropped before createTarget)', s.junkName === 1);
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

// F4 size-seed: a COLD domain with a company size seeds its pattern-guess order (small co → {first}@)
const s4 = I.ingestRows(DB, [{ confidence: '50%', name: 'Solo Founder', company: 'TinyCo', email: 'founder@tinyco.io', employeeCount: 12 }], { source: 'test' });
ok('size-seed counted', (s4.sizeSeeded || 0) >= 1);
const tiny = DB.getPatternState('tinyco.io');
ok('tinyco.io seeded a "first" prior from the small-company size bucket', tiny.patterns['first'] && tiny.patterns['first'].prior >= 0.5);

// puller_add bridge end-to-end: contactsToRows → ingestRows credits the pattern for a verified email
const bridged = I.contactsToRows([{ name: 'Tina Fox', title: 'CEO', email: 'tina.fox@newco.io', verified: true }], 'NewCo');
ok('contactsToRows → one verified NewCo row', bridged.length === 1 && bridged[0].confidence === '95%');
const s3 = I.ingestRows(DB, bridged, { source: 'research:NewCo' });
ok('bridged verified contact credits the newco.io first.last pattern', s3.targets === 1 && s3.patternHits === 1 && !!DB.getPatternState('newco.io').patterns['first.last']);

// ⭐REGRESSION (the ~16s main-thread freeze): ingestRows rebuilds its (name,company)→id dedup set from the
// WHOLE store on every call — fires on every doc-decomp. It MUST stream only the 3 lean columns via
// eachTargetKey, NEVER listTargets({limit:1e7}) which SELECT *'d the entire ~271k-target population
// synchronously and pegged the main thread (profiler-confirmed). Spy on which path runs.
{
  let usedEach = 0, usedFullList = 0;
  const spy = { ...DB,
    eachTargetKey: (cb) => { usedEach++; return DB.eachTargetKey(cb); },
    listTargets: (o) => { if (o && (o.limit || 0) >= 1e6) usedFullList++; return DB.listTargets(o); },
  };
  I.ingestRows(spy, [{ confidence: '95%', name: 'Spy One', company: 'SpyCo', email: 's@spyco.io' }], { source: 'spy' });
  ok('ingest builds its dedup set via eachTargetKey (lean stream), never a full-population SELECT *', usedEach === 1 && usedFullList === 0);
}

DB.close();
console.log(`\nsmoke_puller_ingest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
