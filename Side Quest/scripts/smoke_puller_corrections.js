/* Smoke: F4 correction loop — puller_db merge/reassign/split (reversible) + puller_corrections sweep.
 * Proof: a low-degree role-narrowed fragment AUTO-MERGES into its canonical (observations move, beliefs
 * adopted, donor tombstoned, resolvers follow the merge, correction logged) and unmerge fully restores it;
 * a high-degree attractor is FLAGGED not merged; reassign moves one observation; split peels an attractor
 * into a new target. The human is a watcher — the machine did the safe fold itself.
 *
 * Run: PULLER_DB_PATH=:memory: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_puller_corrections.js
 */
'use strict';
process.env.PULLER_DB_PATH = ':memory:';
const db = require('../lib/puller_db');
const corrections = require('../lib/puller_corrections');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

db.init();

console.log('== reversible mergeTarget: evidence moves, donor tombstoned, resolvers follow ==');
const canon = db.createTarget({ name: 'Tracy Bromley', kind: 'person', domain: 'acme.com' });
db.upsertBelief(canon.id, 'role', { value: 'Head of Finance', confidence: 0.8 });
db.addObservation(canon.id, { attr: 'email', value: 'tracy.bromley@acme.com', kind: 'verified', source: 'seed' });
db.upsertBelief(canon.id, 'email', { value: 'tracy.bromley@acme.com', confidence: 0.8 });
const frag = db.createTarget({ name: 'Tracy', kind: 'person' });
const fragObs = db.addObservation(frag.id, { attr: 'note', value: 'said hi in the finance sync', kind: 'meeting', source: 'meeting-1' });
const mr = db.mergeTarget(frag.id, canon.id, { actor: 'operator', reason: 'same person' });
ok(db.getTarget(frag.id).merged_into === canon.id, 'the fragment is tombstoned (merged_into = survivor)');
ok(db.listObservations(canon.id).some(o => o.id === fragObs), 'the fragment observation now hangs on the canonical');
ok(db.listTargets().every(t => t.id !== frag.id), 'listTargets hides the merged-away fragment');
ok(db.liveTarget(frag.id).id === canon.id, 'liveTarget follows the merge chain to the survivor');
ok(db.listCorrections({ status: 'applied' }).length === 1, 'the merge is logged as a reversible correction');

console.log('== unmerge restores identity exactly ==');
db.unmergeTarget(mr.correctionId);
ok(db.getTarget(frag.id).merged_into == null, 'unmerge un-tombstones the fragment');
ok(db.listObservations(frag.id).some(o => o.id === fragObs), 'the observation returned to the fragment');
ok(db.getCorrection(mr.correctionId).status === 'reverted', 'the correction is marked reverted');

console.log('== auto-sweep: confident low-degree role match folds itself; attractor is flagged ==');
db.close();
process.env.PULLER_DB_PATH = ':memory:';
// fresh in-memory db for the sweep scenario
const db2 = require('../lib/puller_db');
// (same module, re-init a clean memory db)
db2.init({ path: ':memory:' });
const c2 = db2.createTarget({ name: 'Dana Reed', kind: 'person', domain: 'x.com' });
db2.upsertBelief(c2.id, 'role', { value: 'Finance Manager', confidence: 0.8 });
db2.addObservation(c2.id, { attr: 'email', value: 'dana.reed@x.com', kind: 'verified' });
const low = db2.createTarget({ name: 'Dana the finance lady', kind: 'person' });
db2.addObservation(low.id, { attr: 'note', value: 'finance contact', kind: 'meeting' });   // degree 1
const attr = db2.createTarget({ name: 'Dana', kind: 'person' });
for (let i = 0; i < 12; i++) db2.addObservation(attr.id, { attr: 'note', value: `mention ${i}`, kind: 'meeting' });  // degree 12

const swept = corrections.runSweep({ db: db2, apply: true });
ok(swept.autoApplied.length === 1 && swept.autoApplied[0].fromId === low.id, 'the low-degree finance fragment auto-merged into Dana Reed');
ok(db2.liveTarget(low.id).id === c2.id, 'the auto-merge took effect (fragment now resolves to the canonical)');
ok(swept.attractorFlags.some(f => f.id === attr.id && f.kind === 'suspected-attractor'), 'the degree-12 "Dana" is flagged as a suspected attractor, NOT merged');
ok(db2.getTarget(attr.id).merged_into == null, 'the attractor was left intact for operator split');

console.log('== dry run (apply:false) surfaces everything, applies nothing ==');
const c3 = db2.createTarget({ name: 'Omar Vance', kind: 'person' });
db2.upsertBelief(c3.id, 'role', { value: 'Legal Counsel', confidence: 0.8 });
db2.addObservation(c3.id, { attr: 'email', value: 'omar.vance@y.com', kind: 'verified' });
const of2 = db2.createTarget({ name: 'Omar the legal guy', kind: 'person' });
db2.addObservation(of2.id, { attr: 'note', value: 'legal', kind: 'meeting' });
const dry = corrections.runSweep({ db: db2, apply: false });
ok(dry.autoApplied.length === 0, 'dry run auto-applies nothing');
ok(dry.proposals.some(p => p.fromId === of2.id), 'the Omar fragment comes back as a PROPOSAL for the window');
ok(db2.getTarget(of2.id).merged_into == null, 'dry run left the store untouched');

console.log('== reassign + split ==');
const p1 = db2.createTarget({ name: 'Person One', kind: 'person' });
const p2 = db2.createTarget({ name: 'Person Two', kind: 'person' });
const ro = db2.addObservation(p1.id, { attr: 'email', value: 'wrong@z.com', kind: 'guess' });
db2.reassignObservation(ro, p2.id, { reason: 'belongs to Two' });
ok(db2.listObservations(p2.id).some(o => o.id === ro), 'reassignObservation moved the single observation');
const big = db2.createTarget({ name: 'Ambiguous Node', kind: 'person' });
const o1 = db2.addObservation(big.id, { attr: 'note', value: 'alice thing', kind: 'meeting' });
const o2 = db2.addObservation(big.id, { attr: 'note', value: 'other thing', kind: 'meeting' });
const sp = db2.splitTarget(big.id, { obsIds: [o1], name: 'Alice Split', reason: 'two people' });
ok(sp.moved === 1 && db2.getTarget(sp.newTargetId).name === 'Alice Split', 'split created a new target with the peeled observation');
ok(db2.listObservations(big.id).some(o => o.id === o2) && !db2.listObservations(big.id).some(o => o.id === o1), 'split moved only the selected observation');

console.log('== storeFingerprint advances on a write (write-triggered gate) ==');
const fpBefore = db2.storeFingerprint();
db2.createTarget({ name: 'Fresh Target', kind: 'person' });
ok(db2.storeFingerprint() !== fpBefore, 'a new target advances the store fingerprint');
const fpMid = db2.storeFingerprint();
ok(db2.storeFingerprint() === fpMid, 'no write → fingerprint stable (idle poll skips the sweep)');

db2.close();

// ── OFF THE MAIN THREAD (freeze cut 9): the population reads + the scan run in a worker over a READ-ONLY
// handle to the store file; only the reversible merges apply here. p261 blocked 4.7s on the inline sweep.
(async () => {
  console.log('== the worker sweep: reads + scan off-thread, the same merges applied here ==');
  const fs = require('fs'), os = require('os'), path = require('path');
  const tmp = path.join(os.tmpdir(), `smoke_corrections_${process.pid}.db`);
  const db3 = require('../lib/puller_db');
  db3.init({ path: tmp });
  ok(db3.dbPath() === tmp, 'dbPath() names the store file the worker will open');
  const c4 = db3.createTarget({ name: 'Priya Nair', kind: 'person', domain: 'w.com' });
  db3.upsertBelief(c4.id, 'role', { value: 'Data Lead', confidence: 0.8 });
  db3.addObservation(c4.id, { attr: 'email', value: 'priya.nair@w.com', kind: 'verified' });
  const low4 = db3.createTarget({ name: 'Priya the data lead', kind: 'person' });
  db3.addObservation(low4.id, { attr: 'note', value: 'data contact', kind: 'meeting' });
  const attr4 = db3.createTarget({ name: 'Priya', kind: 'person' });
  for (let i = 0; i < 12; i++) db3.addObservation(attr4.id, { attr: 'note', value: `mention ${i}`, kind: 'meeting' });
  // the reader binds the SAME statements the live functions run — one SQL, two doors
  const reader = db3.populationReader(require('better-sqlite3')(tmp, { readonly: true }));
  ok(reader.listTargets({ limit: 10 }).length === 3 && reader.observationCounts().get(attr4.id) === 12 && reader.beliefValuesByType('role').get(c4.id) === 'Data Lead',
    'populationReader over a read-only handle reads the same population the live functions do');
  const dry = await corrections.runSweepInWorker({ db: db3, apply: false });
  ok(dry.via === 'worker' && dry.proposals.some((p) => p.fromId === low4.id) && dry.autoApplied.length === 0 && db3.getTarget(low4.id).merged_into == null,
    `CRITICAL: the WORKER found the fragment (via ${dry.via}); a dry run applies nothing and the store is untouched`);
  const sw = await corrections.runSweepInWorker({ db: db3, apply: true });
  ok(sw.via === 'worker' && sw.autoApplied.length === 1 && sw.autoApplied[0].fromId === low4.id && db3.liveTarget(low4.id).id === c4.id,
    'CRITICAL: the merges the worker found are applied HERE, reversibly — the fragment now resolves to its canonical');
  ok(sw.attractorFlags.some((f) => f.id === attr4.id && f.kind === 'suspected-attractor') && db3.getTarget(attr4.id).merged_into == null,
    'the attractor is flagged, not merged — identical verdicts to the inline sweep');
  const mem = await corrections.runSweepInWorker({ db: db3, dbPath: ':memory:', apply: false });
  ok(mem && mem.via !== 'worker' && Array.isArray(mem.proposals), 'an in-memory store (no shareable file) falls back to the inline sweep');
  db3.close();
  await new Promise((r) => setTimeout(r, 150));
  try { fs.unlinkSync(tmp); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('worker sweep section crashed:', e); process.exit(1); });
