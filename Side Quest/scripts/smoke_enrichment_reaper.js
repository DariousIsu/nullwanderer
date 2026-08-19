'use strict';
/* Smoke: lib/enrichment_reaper — the SQ-side reaper for Echo's electoral.enrichment_job (re-homed from
 * Echo's saga heartbeat, which is dark because huey_consumer isn't running). A row stuck 'running' past
 * the 2h threshold (a reboot/crash skips EnrichmentJob.__exit__) is marked 'failed' + ORPHAN_MARKER,
 * preserving contact_id + a prior error; recent/complete/failed rows and a null started_at are spared;
 * a false-reap self-corrects. Deterministic, temp-file DB (better-sqlite3), no live DB / network.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_enrichment_reaper.js
 */
const os = require('os'), fs = require('fs'), path = require('path');
const Database = require('better-sqlite3');
const { reapOrphanedEnrichmentJobs, ORPHAN_MARKER } = require('../lib/enrichment_reaper');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const tmp = path.join(os.tmpdir(), `ejob_reaper_smoke_${process.pid}.db`);
try { fs.unlinkSync(tmp); } catch {}
const now = Math.floor(Date.now() / 1000);
const seed = new Database(tmp);
seed.exec(`CREATE TABLE enrichment_job (id INTEGER PRIMARY KEY, contact_id INTEGER, job_kind TEXT,
           status TEXT, started_at INTEGER, finished_at INTEGER, error_message TEXT)`);
const rows = [
  [1, 101, 'running',  now - 3 * 3600,        null],           // 3h  -> REAP
  [2, 102, 'running',  now - 10,              null],           // 10s -> spare (recent)
  [3, 103, 'running',  now - 30 * 24 * 3600,  null],           // 30d -> REAP
  [4, 104, 'complete', now - 5 * 3600,        null],           // complete -> untouched
  [5, 105, 'failed',   now - 5 * 3600,        'real failure'], // failed -> untouched, keep msg
  [6, 106, 'running',  null,                  null],           // null started_at -> spare (guard)
  [7, 107, 'running',  now - 2 * 3600 - 5,    null],           // just >2h -> REAP (boundary)
  [8, 108, 'running',  now - 2 * 3600 + 60,   null],           // just <2h -> spare (boundary)
];
const ins = seed.prepare("INSERT INTO enrichment_job (id,contact_id,status,started_at,error_message) VALUES (?,?,?,?,?)");
for (const r of rows) ins.run(r[0], r[1], r[2], r[3], r[4]);
seed.close();

const n = reapOrphanedEnrichmentJobs({ dbPath: tmp });   // default 2h threshold

const chk = new Database(tmp, { readonly: true });
const g = (id, col) => chk.prepare(`SELECT ${col} AS v FROM enrichment_job WHERE id=?`).get(id).v;
ok(n === 3, `reaped count === 3 (got ${n})`);
for (const id of [1, 3, 7]) {
  ok(g(id, 'status') === 'failed', `id${id} running-orphan -> failed`);
  ok(g(id, 'error_message') === ORPHAN_MARKER, `id${id} tagged ORPHAN_MARKER`);
  ok(g(id, 'finished_at') != null, `id${id} finished_at stamped`);
  ok(g(id, 'contact_id') === 100 + id, `id${id} contact_id preserved`);
}
ok(g(2, 'status') === 'running', 'id2 recent running spared');
ok(g(8, 'status') === 'running', 'id8 just-under-2h spared');
ok(g(6, 'status') === 'running', 'id6 null started_at spared (guard)');
ok(g(4, 'status') === 'complete', 'id4 complete untouched');
ok(g(5, 'status') === 'failed' && g(5, 'error_message') === 'real failure', 'id5 prior failure + msg preserved (COALESCE)');
chk.close();
// idempotent: a second run reaps nothing new
ok(reapOrphanedEnrichmentJobs({ dbPath: tmp }) === 0, 'second run reaps 0 (idempotent)');
// fail-soft: a bogus path yields 0, never throws
ok(reapOrphanedEnrichmentJobs({ dbPath: path.join(os.tmpdir(), 'no_such_ejob_db_xyz.db') }) === 0, 'missing DB -> 0 (fail-soft)');
ok(reapOrphanedEnrichmentJobs({}) === 0, 'no dbPath -> 0 (fail-soft)');

try { fs.unlinkSync(tmp); } catch {}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
if (fail) process.exit(1);
