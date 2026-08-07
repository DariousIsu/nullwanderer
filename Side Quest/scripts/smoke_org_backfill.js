'use strict';
/* smoke_org_backfill.js — the pre-door org-kind re-kind sweep (lib/puller_db.backfillOrgKinds).
 * Hermetic: PULLER_DB_PATH temp file; pre-door stock seeded via raw INSERT (createTarget would
 * apply the door and defeat the point). Run: node scripts/smoke_org_backfill.js */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgbf-smoke-'));
process.env.PULLER_DB_PATH = path.join(tmp, 'puller.db');
const pdb = require(path.join(__dirname, '..', 'lib', 'puller_db'));
pdb.init();

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };

// Seed PRE-DOOR-style rows: direct INSERTs with kind='person' regardless of shape.
const raw = new (require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3')))(process.env.PULLER_DB_PATH);
const ins = raw.prepare('INSERT INTO targets (name, kind, created_at, last_accessed_at) VALUES (?, ?, ?, ?)');
const seed = (name, kind) => ins.run(name, kind, Date.now(), Date.now());
seed('Rainey Center for Public Policy', 'person');          // org-shaped, mis-kinded (the real case)
seed('Louisiana Public Service Commission', 'person');      // org-shaped, mis-kinded
seed('Acadia Parish Police Jury', 'person');                // org-shaped (parish token)
seed('Jane Ellen Smith', 'person');                         // real person — must NOT flip
seed('Frank Church', 'person');                             // the surname trap — 'church' absent from tokens, must NOT flip
seed('Hartfield Family Foundation', 'org');                 // already org — untouched, not rescanned

(async () => {
  const r1 = await pdb.backfillOrgKinds({ chunk: 2 });      // tiny chunk exercises the pagination
  ok('scans only person rows', r1.scanned === 5);
  ok('re-kinds exactly the org-shaped mis-kinds', r1.rekinded === 3);
  ok('org rows now org', raw.prepare(`SELECT COUNT(*) n FROM targets WHERE kind='org'`).get().n === 4);
  ok('real people untouched', raw.prepare(`SELECT kind FROM targets WHERE name='Jane Ellen Smith'`).get().kind === 'person');
  ok('Frank Church survives the surname trap', raw.prepare(`SELECT kind FROM targets WHERE name='Frank Church'`).get().kind === 'person');
  const r2 = await pdb.backfillOrgKinds({ chunk: 2 });
  ok('idempotent: second sweep re-kinds nothing', r2.rekinded === 0 && r2.scanned === 2);
  ok('detector parity: the door and the sweep agree', pdb.orgShapedName('Rainey Center for Public Policy') && !pdb.orgShapedName('Jane Ellen Smith'));

  console.log(`smoke_org_backfill: ${pass} passed, ${fail} failed`);
  raw.close(); pdb.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
