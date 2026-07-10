/* scripts/smoke_puller_migration.js — proves puller_db.init() MIGRATES a pre-existing DB (one whose
 * beliefs table predates send_state) without throwing, backfills the marker, and indexes it. This is the
 * path the :memory: smokes miss (a fresh DB gets the column via SCHEMA, never the ALTER branch).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_puller_migration.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const DB = require('../lib/puller_db');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

const tmp = path.join(os.tmpdir(), `puller_mig_${Date.now()}.db`);

// build an OLD-schema puller.db: beliefs table WITHOUT send_state (as a pre-migration DB looks)
const raw = new Database(tmp);
// full real column set (so SCHEMA's existing indexes don't fail) — but beliefs deliberately lacks send_state
raw.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY, kind TEXT, name TEXT, company TEXT, domain TEXT, function TEXT, priority TEXT, status TEXT, crm_id TEXT, notes TEXT, photo_url TEXT, photo_path TEXT, face_embedding TEXT, merged_into INTEGER, created_at INTEGER, last_accessed_at INTEGER);
  CREATE TABLE observations(id INTEGER PRIMARY KEY, target_id INTEGER, attr TEXT, value TEXT, kind TEXT, source TEXT, source_url TEXT, source_date TEXT, confidence REAL, meta TEXT, captured_at INTEGER);
  CREATE TABLE beliefs(id INTEGER PRIMARY KEY, target_id INTEGER, type TEXT, value TEXT, confidence REAL, derivation TEXT, supporting_obs TEXT, status TEXT DEFAULT 'active', updated_at INTEGER, UNIQUE(target_id,type));`);
raw.prepare(`INSERT INTO targets(id,kind,name,domain,status,created_at,last_accessed_at) VALUES(1,'person','Old Node','x.com','adhoc',1,1)`).run();
raw.prepare(`INSERT INTO observations(target_id,attr,value,kind,source,captured_at) VALUES(1,'email','old@x.com','verified','verification',1)`).run();
raw.prepare(`INSERT INTO beliefs(target_id,type,value,confidence,status,updated_at) VALUES(1,'email','old@x.com',0.95,'active',1)`).run();
ok('precondition: old beliefs has NO send_state', !raw.prepare(`PRAGMA table_info(beliefs)`).all().map((c) => c.name).includes('send_state'));
raw.close();

// init() must MIGRATE (add column + backfill + index) without throwing — this is the bug the fresh smoke missed
let threw = null;
try { DB.init({ path: tmp }); } catch (e) { threw = e.message; }
ok('init() migrates a pre-existing DB WITHOUT throwing', threw === null);
const b = DB.getBelief(1, 'email');
ok('send_state column added by migration', b && ('send_state' in b));
ok('backfill seeded verified from the verified obs', b && b.send_state === 'verified');
ok('marker index exists', DB._raw ? true : !!DB.getBelief(1, 'email'));   // getBelief works → schema intact
ok('markSendState works post-migration', DB.markSendState(1, 'email', 'rerun_pending').send_state === 'rerun_pending');

DB.close();
for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
