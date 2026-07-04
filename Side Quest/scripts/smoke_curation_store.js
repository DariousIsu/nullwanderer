/* Smoke: lib/curation_store — the durable cross-feed OBSERVATION STORE (curation substrate Slice 1).
 *
 * Part A (pure, mock db): obsKey stability/idempotency, normalizeObservation coercion, record/recordMany,
 *   heldFor, and the Puller contact bridge (fromContact) grade mapping.
 * Part B (REAL sqlite via an isolated SQ_DB_PATH): INSERT OR IGNORE idempotency at the SQL grain,
 *   listKgObservations filters (entity/feed/status), and kgObservationStats grouping.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_curation_store.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const CS = require('../lib/curation_store');

// ---------------------------------------------------------------------------
// Part A — pure logic against a tiny in-memory mock db that honors obs_key uniqueness.
// ---------------------------------------------------------------------------
function mockDb() {
  const rows = [];
  return {
    rows,
    recordKgObservation(o) {
      if (rows.some(r => r.obs_key === o.obsKey)) return { id: null, inserted: false };
      const id = rows.length + 1;
      rows.push({ id, feed: o.feed, source_entity: o.sourceEntity, relation: o.relation, target: o.target, value: o.value, url: o.url, grade: o.grade, confidence: o.confidence, kind: o.kind, status: o.status, obs_key: o.obsKey, captured_at: o.capturedAt || 1 });
      return { id, inserted: true };
    },
    listKgObservations({ sourceEntity = null, feed = null, status = null, limit = 200 } = {}) {
      return rows.filter(r => (sourceEntity == null || r.source_entity === sourceEntity) && (feed == null || r.feed === feed) && (status == null || r.status === status)).slice(0, limit).reverse();
    },
    kgObservationStats() { return { total: rows.length, byGroup: [] }; },
  };
}

// obsKey — stable + collapses case/whitespace; target||value fallback.
const k1 = CS.obsKey({ feed: 'graph-walk', sourceEntity: 'Francis Lindquist', relation: 'represented', target: "Michigan's 11th", url: 'https://en.wikipedia.org/x' });
const k2 = CS.obsKey({ feed: 'graph-walk', sourceEntity: '  francis lindquist ', relation: 'REPRESENTED', target: "michigan's 11th", url: 'https://en.wikipedia.org/x' });
ok(k1 === k2, 'obsKey: case/whitespace-insensitive → identical key (idempotency backbone)');
ok(CS.obsKey({ sourceEntity: 'X', value: 'v@e.com' }).includes('v@e.com'), 'obsKey: falls back to value when target absent');
ok(CS.obsKey({ sourceEntity: 'X', relation: 'exists' }) !== CS.obsKey({ sourceEntity: 'X', relation: 'other' }), 'obsKey: relation participates in the key');

// normalizeObservation — grade→confidence fill, defaults, coercion.
const n = CS.normalizeObservation({ sourceEntity: 'A', relation: 'r', target: 'B', grade: 'B', url: 'u' });
ok(n.confidence === 0.95, 'normalize: fills send-confidence from grade B (0.95) when omitted');
ok(n.status === 'promoted' && n.feed === 'unknown', 'normalize: status defaults promoted, feed defaults unknown');
ok(CS.normalizeObservation({ sourceEntity: 'A', grade: 'D' }).confidence === 0.5, 'normalize: grade D → 0.50');
ok(CS.normalizeObservation({ sourceEntity: 'A', confidence: 0.42, grade: 'B' }).confidence === 0.42, 'normalize: an explicit confidence is NOT overwritten by the grade');
ok(CS.normalizeObservation({ sourceEntity: 'A' }).confidence === null, 'normalize: no grade + no confidence → null');
ok(CS.normalizeObservation({ sourceEntity: '  Trimmed  ' }).sourceEntity === 'Trimmed', 'normalize: trims subject');

// record — insert, dedup, no-subject refusal.
let db = mockDb();
const r1 = CS.record(db, { feed: 'graph-walk', sourceEntity: 'A', relation: 'r', target: 'B', grade: 'B', url: 'u' });
ok(r1.inserted === true && db.rows.length === 1, 'record: first observation inserts');
const r2 = CS.record(db, { feed: 'graph-walk', sourceEntity: 'A', relation: 'r', target: 'B', grade: 'B', url: 'u' });
ok(r2.inserted === false && db.rows.length === 1, 'record: identical claim is idempotent (no dup row)');
const r3 = CS.record(db, { feed: 'graph-walk', sourceEntity: '', relation: 'r', target: 'B' });
ok(r3.skipped === 'no-subject' && db.rows.length === 1, 'record: an observation with no subject is refused');

// recordMany — status tallies + dedup count.
db = mockDb();
const many = CS.recordMany(db, [
  { feed: 'f', sourceEntity: 'A', relation: 'r', target: 'B', status: 'promoted', grade: 'B', url: 'u1' },
  { feed: 'f', sourceEntity: 'A', relation: 'r', target: 'C', status: 'held', grade: 'D' },
  { feed: 'f', sourceEntity: 'A', relation: 'r', target: 'B', status: 'promoted', grade: 'B', url: 'u1' }, // dup
  { feed: 'f', sourceEntity: '', relation: 'r', target: 'Z' }, // no subject → skipped
]);
ok(many.total === 3 && many.promoted === 2 && many.held === 1, 'recordMany: tallies total/promoted/held, skips subjectless');
ok(many.inserted === 2, 'recordMany: inserted counts only NEW rows (dup collapsed)');

// heldFor — the enrichment queue.
db = mockDb();
CS.record(db, { feed: 'f', sourceEntity: 'Person', relation: 'a', target: 'X', status: 'held', grade: 'D' });
CS.record(db, { feed: 'f', sourceEntity: 'Person', relation: 'b', target: 'Y', status: 'promoted', grade: 'B', url: 'u' });
ok(CS.heldFor(db, 'Person').length === 1, 'heldFor: returns only HELD claims for the subject');

// fromContact — the Puller bridge, grade tiers verbatim.
ok(CS.fromContact({ name: 'Jane', email: 'jane@ex.com', confidence: 0.95 })[0].grade === 'B', 'fromContact: a verified (0.95) email → grade B');
ok(CS.fromContact({ name: 'Jane', email: 'jane@ex.com', confidence: 0.80 })[0].grade === 'C', 'fromContact: a pattern (0.80) email → grade C');
ok(CS.fromContact({ name: 'Jane', email: 'jane@ex.com', confidence: 0.50 })[0].grade === 'D', 'fromContact: a best-guess (0.50) email → grade D');
ok(CS.fromContact({ name: 'Jane', email: 'jane@ex.com', confidence: 0.30 })[0].grade === 'E', 'fromContact: a generic (0.30) email → grade E');
ok(CS.fromContact({ name: 'Jane', email: 'j@e.com', title: 'Director', confidence: 0.95 }).length === 2, 'fromContact: email + title → two observations');
ok(CS.fromContact({ email: 'noname@ex.com' }).length === 0, 'fromContact: no name → no observations');
ok(CS.fromContact({ name: 'Jane', email: 'JANE@EX.COM', confidence: 0.95 })[0].value === 'jane@ex.com', 'fromContact: lowercases the email value');

// ---------------------------------------------------------------------------
// Part B — REAL sqlite (isolated throwaway DB): SQL-level idempotency, filters, stats.
// ---------------------------------------------------------------------------
const tmp = path.join(os.tmpdir(), `sq_curation_store_smoke_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;
let realOk = true;
try {
  const realDb = require('../lib/db');
  realDb.init();

  const a = CS.record(realDb, { feed: 'graph-walk', sourceEntity: 'Francis Lindquist', relation: 'represented', target: "Michigan's 11th", grade: 'B', url: 'https://en.wikipedia.org/wiki/Francis_Lindquist', status: 'promoted', kind: 'source' });
  ok(a.inserted === true, 'real: promoted observation inserts into sqlite');
  const aDup = CS.record(realDb, { feed: 'graph-walk', sourceEntity: 'Francis Lindquist', relation: 'represented', target: "Michigan's 11th", grade: 'B', url: 'https://en.wikipedia.org/wiki/Francis_Lindquist', status: 'promoted', kind: 'source' });
  ok(aDup.inserted === false, 'real: INSERT OR IGNORE — re-seeing the same cited claim is a no-op');

  CS.record(realDb, { feed: 'graph-walk', sourceEntity: 'Francis Lindquist', relation: 'chaired', target: 'Some Committee', grade: 'D', status: 'held' });
  CS.record(realDb, { feed: 'puller', sourceEntity: 'Jane Roe', relation: 'email', value: 'jane@ex.com', grade: 'B', url: 'https://ex.com/dir', status: 'promoted' });

  ok(CS.list(realDb, { sourceEntity: 'Francis Lindquist' }).length === 2, 'real: list filters by subject (2 for Lindquist)');
  ok(CS.list(realDb, { feed: 'puller' }).length === 1, 'real: list filters by feed');
  ok(CS.list(realDb, { status: 'held' }).length === 1, 'real: list filters by status (held)');
  ok(CS.heldFor(realDb, 'Francis Lindquist').length === 1, 'real: heldFor returns the held candidate only');

  const st = CS.stats(realDb);
  ok(st.total === 3, 'real: stats total counts all observations (3)');
  ok(Array.isArray(st.byGroup) && st.byGroup.length >= 2, 'real: stats groups by feed/status/grade');

  // A promoted row on the SAME (entity,relation,target) but a DIFFERENT url is a distinct observation.
  const diffUrl = CS.record(realDb, { feed: 'graph-walk', sourceEntity: 'Francis Lindquist', relation: 'represented', target: "Michigan's 11th", grade: 'B', url: 'https://other.example/lindquist', status: 'promoted' });
  ok(diffUrl.inserted === true, 'real: a different backing url is a distinct (corroborating) observation');
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
