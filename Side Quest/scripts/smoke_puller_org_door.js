/* Smoke: M4.4 — the Puller org door (in-memory DB; never touches the live puller.db).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_puller_org_door.js
 */
'use strict';
const pdb = require('../lib/puller_db');
pdb.init({ path: ':memory:' });

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- detector: the measured disease cases flag; real people do not ---
ok(pdb.orgShapedName('The Joseph Rainey Center for Public Policy'), 'detector: the live-measured mis-enrollment (Rainey Center) is org-shaped');
ok(pdb.orgShapedName('Rainey Center Freedom Project, Inc.'), 'detector: corporate-form suffix (Inc.) is org-shaped');
ok(pdb.orgShapedName('Caddo Parish School Board'), 'detector: civic body (Parish/Board) is org-shaped');
ok(!pdb.orgShapedName('Lucas Overby'), 'detector: a plain person name is not org-shaped');
ok(!pdb.orgShapedName('Frank Church'), 'detector: Senator Frank Church is NOT flagged (surname false-positive guarded)');
ok(!pdb.orgShapedName('Tom Arceneaux'), 'detector: another plain person passes');
ok(!pdb.orgShapedName('Pinny Beebe-Center'), 'detector: hyphenated surname embedding an org token (Beebe-Center) is NOT flagged (measured mis-kind, Phase 3 guard)');
ok(pdb.orgShapedName('Center for American Progress'), 'detector: a FREE-STANDING designator survives the hyphen guard');

// --- the door: an org-shaped person enrollment is re-kinded to org ---
const p = pdb.createTarget({ kind: 'person', name: 'Jane Doe', company: 'Cleco' });
ok(p.kind === 'person', 'door: a person enrolls as person');
const o = pdb.createTarget({ kind: 'person', name: 'The Joseph Rainey Center for Public Policy' });
ok(o.kind === 'org', 'door: the org-shaped name is REFUSED from the person lane → kind=org');
const explicit = pdb.createTarget({ kind: 'org', name: 'Cato Institute' });
ok(explicit.kind === 'org', 'door: an explicit org enrollment passes through unchanged');

// --- the person worklists exclude org rows (both tiers) ---
pdb.promoteTarget(o.id, 'CRM-FAKE-1');                       // tier A shape: promoted + crm-linked, but an ORG
const scoped = pdb.listValueScopedTargets({ limit: 50 });
ok(!scoped.some((t) => t.kind === 'org'), `worklist: no org row in either tier (${scoped.length} rows, all person)`);
ok(scoped.some((t) => t.id === p.id), 'worklist: the real person is still in the tail tier');

// --- listTargets (the UI surface) still shows everything ---
ok(pdb.listTargets({ limit: 50 }).some((t) => t.kind === 'org'), 'UI list: org rows remain visible (only the WORKLISTS are person-scoped)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
pdb.close();
process.exit(fail === 0 ? 0 : 1);
