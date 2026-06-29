/* scripts/smoke_puller_ipc.js — the dossier aggregator + write loop the UI relies on (in-memory db).
 * Proves buildDossier surfaces axis-1 qualification correctly through bounce → accept → dedicated.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_puller_ipc.js */
'use strict';
const DB = require('../lib/puller_db');
const IPC = require('../lib/puller_ipc');
const R = require('../studio/puller_revise');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

DB.init({ path: ':memory:' });

const t = DB.createTarget({ name: 'Brian Huseman', company: 'Acme', domain: 'acme.com' });
DB.addObservation(t.id, { attr: 'email', value: 'brian.huseman@acme.com', kind: 'pattern' });
DB.upsertBelief(t.id, 'email', { value: 'brian.huseman@acme.com', confidence: 0.80 });

let d = IPC.buildDossier(t.id);
ok('qualification present (grade C, 80%, not conflicted)', d.qualification && d.qualification.grade === 'C' && d.qualification.confidence === 0.80 && !d.qualification.conflicted);
ok('domainPattern present', d.domainPattern && d.domainPattern.domain === 'acme.com');

// bounce → conflicted + flip proposed
R.applyVerification(t.id, { value: 'brian.huseman@acme.com', result: 'invalid' });
d = IPC.buildDossier(t.id);
ok('after bounce: conflicted at 20%', d.qualification.conflicted === true && d.qualification.confidence === 0.20);
ok('dossier surfaces the pending flip', d.revisions.length === 1 && /bounced/.test(d.revisions[0].rationale));
ok('retest queued for this target', d.retests.length === 1);

// accept the flip → new held value qualifies as a fresh derived guess (D, 50%)
R.decideRevision(d.revisions[0].id, 'accepted');
d = IPC.buildDossier(t.id);
ok('after accept: held value flipped', (d.beliefs.find(b => b.type === 'email') || {}).value === 'bhuseman@acme.com');
ok('after accept: grade D, 50%, no conflict', d.qualification.grade === 'D' && d.qualification.confidence === 0.50 && !d.qualification.conflicted);
ok('no pending revisions left', d.revisions.length === 0);

// dedicated source → 100% (grade A)
R.markDedicatedSource(t.id, { value: 'b.huseman@acme.com', note: 'business card' });
d = IPC.buildDossier(t.id);
ok('dedicated source → grade A, 100%', d.qualification.grade === 'A' && d.qualification.confidence === 1.00);

ok('listTargets returns trimmed row', IPC.listTargets({}).some(x => x.id === t.id && x.name === 'Brian Huseman'));
ok('buildDossier null for unknown target', IPC.buildDossier(99999) === null);

// export path: promote → build Contact-shape rows from the live aggregator
DB.promoteTarget(t.id, 'local');
const X = require('../studio/puller_export');
const items = DB.listTargets({ status: 'promoted', limit: 100 }).map(x => IPC.buildDossier(x.id));
const xr = X.toContactRows(items);
ok('export yields a Contact row for the promoted target', xr.rows.length === 1 && xr.rows[0].external_id === `PULLER:${t.id}`);
ok('export maps grade-A → 100% deliverable prospect', xr.rows[0].Email_Quality_Score__c === 100 && xr.rows[0].Email_Deliverable__c === 1 && xr.rows[0].Contact_Kind__c === 'prospect');

// ---- v2 wiring: seed priors → infra detection surfaces in the dossier ----
const P = require('../studio/puller_priors');
const N = require('../studio/puller_negatives');
P.seedInto(DB);
const tm = DB.createTarget({ name: 'Block Person', company: 'MSFT', domain: 'microsoft.com' });
DB.addObservation(tm.id, { attr: 'email', value: 'block.person@microsoft.com', kind: 'pattern' });
DB.upsertBelief(tm.id, 'email', { value: 'block.person@microsoft.com', confidence: 0.80 });
let last;
for (let i = 0; i < 3; i++) last = R.applyVerification(tm.id, { value: 'block.person@microsoft.com', result: 'invalid' });
ok('seeded hyperscaler bounces → infraSuspect, no flip', last.infraSuspect === true && last.revisionId === null);
ok('buildDossier surfaces infraBlocked', IPC.buildDossier(tm.id).domainPattern.infraBlocked === true);

// ---- v2 wiring: email→target resolver + ingest-negatives composition ----
ok('findTargetByEmail resolves held email', (DB.findTargetByEmail('block.person@microsoft.com') || {}).id === tm.id);
ok('findTargetByEmail unknown → null', DB.findTargetByEmail('nobody@nowhere.com') === null);
const ingest = N.parseResults('email,status\nblock.person@microsoft.com,invalid\nghost@nowhere.com,invalid');
let matched = 0, applied = 0;
for (const row of ingest.rows) { const tx = DB.findTargetByEmail(row.email); if (tx) { matched++; R.applyVerification(tx.id, { value: row.email, result: row.result }); applied++; } }
ok('ingest resolves known email, skips unknown', matched === 1 && applied === 1);

DB.close();
console.log(`\nsmoke_puller_ipc: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
