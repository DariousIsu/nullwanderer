/* Smoke: lib/fade — Slice 6, the TTL→archive "fade" arm of prove-or-fade (offline; clock injected).
 *
 * Part A (pure): plan() archives rows aged past the TTL, keeps fresh + bad-data rows, honors a custom TTL.
 * Part B (REAL sqlite): the db path — listFadeCandidates returns unsubstantiated non-archived rows;
 *   setKgObservationStatus archives one; the archived row is RETAINED but drops off the prove queue + the
 *   fade-candidate list (idempotent), while the fresh unsubstantiated node stays.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_fade.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const F = require('../lib/fade');
const CS = require('../lib/curation_store');
const D = 86400000;

// --- Part A: pure plan() ---------------------------------------------------------------------------
const NOW = 1000000000000;
const rows = [
  { id: 1, captured_at: NOW - 20 * D },   // aged past 14d → archive
  { id: 2, captured_at: NOW - 1 * D },    // fresh → keep
  { id: 3, captured_at: NOW - 15 * D },   // just past 14d → archive
  { id: 4 },                              // no captured_at → keep (never archive on bad data)
  { captured_at: NOW - 30 * D },          // no id → keep
];
const p = F.plan(rows, { ttlMs: 14 * D, now: NOW });
ok(p.archive.length === 2 && p.archive.includes(1) && p.archive.includes(3), 'plan: rows aged past the TTL are archived');
ok(p.kept === 3, 'plan: fresh + bad-data (no id / no captured_at) rows are kept');
ok(F.plan([{ id: 9, captured_at: NOW - 100 * D }], { ttlMs: 200 * D, now: NOW }).archive.length === 0, 'plan: a longer TTL keeps an older row');
ok(F.plan(rows, { now: NOW }).archive.length >= 1, 'plan: the default 14d TTL applies when ttlMs omitted');
ok(F.plan(null, { now: NOW }).archive.length === 0 && F.plan([], { now: NOW }).archive.length === 0, 'plan: null / empty rows → empty');
ok(F.plan([{ id: 1, captured_at: NOW - 20 * D }], {}).archive.length === 0, 'plan: no `now` → nothing archived (needs a clock)');

// --- Part B: REAL sqlite fade round-trip -----------------------------------------------------------
const tmp = path.join(os.tmpdir(), `sq_fade_smoke_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;
let realOk = true;
try {
  const db = require('../lib/db');
  db.init();
  const NOWB = 2000000000000;
  CS.record(db, { feed: 'doc-decomp', sourceEntity: 'Old Ghost', relation: 'exists', url: 'docstore:1', status: 'promoted', substantiationState: 'unsubstantiated', capturedAt: NOWB - 30 * D });
  CS.record(db, { feed: 'doc-decomp', sourceEntity: 'Fresh Ghost', relation: 'exists', url: 'docstore:2', status: 'promoted', substantiationState: 'unsubstantiated', capturedAt: NOWB - 1 * D });
  CS.record(db, { feed: 'graph-walk', sourceEntity: 'Real Person', relation: 'exists', url: 'https://en.wikipedia.org/wiki/R', status: 'promoted', substantiationState: 'source-vouched', capturedAt: NOWB - 40 * D });

  const cands = db.listFadeCandidates({ limit: 100 });
  ok(cands.length === 2, 'db: fade candidates are the 2 unsubstantiated rows (the substantiated one is excluded)');
  const planB = F.plan(cands, { ttlMs: 14 * D, now: NOWB });
  ok(planB.archive.length === 1, 'db+plan: only the aged (30d) unsubstantiated row is archived, not the fresh (1d)');
  let archived = 0;
  for (const id of planB.archive) archived += db.setKgObservationStatus(id, 'archived');
  ok(archived === 1, 'db: setKgObservationStatus archives the aged row');

  ok(db.listUnsubstantiatedObservations({ limit: 10 }).every((r) => r.name !== 'Old Ghost'), 'db: the archived node drops OFF the prove queue');
  ok(db.listFadeCandidates({ limit: 100 }).length === 1, 'db: the archived row is no longer a fade candidate (idempotent — never re-archived)');
  const oldRows = db.listKgObservations({ sourceEntity: 'Old Ghost' });
  ok(oldRows.length === 1 && oldRows[0].status === 'archived', 'db: the row is RETAINED as archived (never hard-deleted — restorable)');
  ok(db.listUnsubstantiatedObservations({ limit: 10 }).some((r) => r.name === 'Fresh Ghost'), 'db: the fresh unsubstantiated node stays on the prove queue');
} catch (e) {
  realOk = false;
  console.log('  ✗ real-db section threw:', e && e.message);
  fail++;
} finally {
  try { require('../lib/db').getDb().close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + suffix); } catch {} }
}
ok(realOk, 'real: sqlite section completed without throwing');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
