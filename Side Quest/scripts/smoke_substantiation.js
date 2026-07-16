/* Smoke: lib/substantiation — the SUBSTRATE classifier (substantiation-grading Slice 1).
 *
 * Part A (pure): classifySubstantiation truth table (identity/source/unsubstantiated precedence, held
 *   override, self-vouching feeds, junk/docstore handling), classifyFrame, and the frame predicates.
 * Part B (REAL sqlite via isolated SQ_DB_PATH): a curation_store.record round-trips substantiation_state +
 *   frame into the new kg_observations columns and reads back (proves the migration + record-only wiring).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_substantiation.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const S = require('../lib/substantiation');
const CS = require('../lib/curation_store');

// ---------------------------------------------------------------------------
// Part A — pure classifier.
// ---------------------------------------------------------------------------

// STATE precedence + the core rules.
ok(S.classifySubstantiation({ resolved: true, feed: 'graph-walk' }) === S.IDENTITY_CONFIRMED,
  'state: a resolved (matched-existing) entity → identity-confirmed (highest precedence)');
ok(S.classifySubstantiation({ resolved: true, status: 'held' }) === S.IDENTITY_CONFIRMED,
  'state: resolved wins even over a held status');
ok(S.classifySubstantiation({ status: 'held', feed: 'doc-decomp', url: 'docstore:5' }) === S.UNSUBSTANTIATED,
  'state: a HELD observation → unsubstantiated even from a self-vouching feed with a pointer');
ok(S.classifySubstantiation({ feed: 'doc-decomp', url: 'docstore:5', status: 'promoted' }) === S.SOURCE_VOUCHED,
  'state: a promoted doc-decomp claim (the document is the citation) → source-vouched');
ok(S.classifySubstantiation({ feed: 'news', url: 'https://apnews.com/x' }) === S.SOURCE_VOUCHED,
  'state: a news claim (the story is the substantiation) → source-vouched');
ok(S.classifySubstantiation({ feed: 'doc-decomp', url: null }) === S.UNSUBSTANTIATED,
  'state: a self-vouching feed with NO provenance pointer → unsubstantiated');
ok(S.classifySubstantiation({ feed: 'graph-walk', url: 'https://en.wikipedia.org/wiki/X' }) === S.SOURCE_VOUCHED,
  'state: a non-self-vouching feed with a real http source → source-vouched');
ok(S.classifySubstantiation({ feed: 'graph-walk', url: 'https://fandom.com/x' }) === S.UNSUBSTANTIATED,
  'state: a junk-host source (fandom) → unsubstantiated (the bottom floor)');
ok(S.classifySubstantiation({ feed: 'graph-walk', url: 'docstore:9' }) === S.UNSUBSTANTIATED,
  'state: a docstore pointer on a NON-self-vouching feed is not an external citation → unsubstantiated');
ok(S.classifySubstantiation({ feed: 'graph-walk' }) === S.UNSUBSTANTIATED,
  'state: a bare mention with no source → unsubstantiated');
ok(S.classifySubstantiation({ feed: 'fiction', url: 'docstore:1', selfVouching: true }) === S.SOURCE_VOUCHED,
  'state: an explicit selfVouching claim with a pointer → source-vouched (fiction is real to its fiction)');
ok(S.classifySubstantiation({ feed: 'graph-walk', sources: [{ url: 'https://senate.gov/x' }] }) === S.SOURCE_VOUCHED,
  'state: a real source in the sources[] list → source-vouched');

// isSubstantiated convenience.
ok(S.isSubstantiated(S.SOURCE_VOUCHED) && S.isSubstantiated(S.IDENTITY_CONFIRMED), 'isSubstantiated: true for both substantiated states');
ok(S.isSubstantiated(S.UNSUBSTANTIATED) === false, 'isSubstantiated: false for unsubstantiated');

// FRAME.
ok(S.classifyFrame({ feed: 'news', url: 'https://x.com' }) === S.FRAME_REAL, 'frame: civic/news defaults to real');
ok(S.classifyFrame({ fiction: 'The Matrix' }) === 'fiction:the-matrix', 'frame: a fiction hint → fiction:<slug>');
ok(S.classifyFrame({ fiction: '  !!!  ' }) === S.FRAME_REAL, 'frame: an empty fiction slug falls back to real');
ok(S.isNamedFloodFrame('domain:medical') === true, 'flood: domain:medical is a named-flood frame (Slice-5 hard wall)');
ok(S.isNamedFloodFrame('real') === false, 'flood: real is not a flood frame');
ok(S.isFictionFrame('fiction:dune') === true && S.isFictionFrame('real') === false, 'frame: isFictionFrame detects the fiction: prefix');

// isRealSourceUrl / hasRealHttpSource.
ok(S.isRealSourceUrl('https://ok.gov/p') === true && S.isRealSourceUrl('docstore:5') === false && S.isRealSourceUrl('https://reddit.com/x') === false,
  'url: real http non-junk → true; docstore pointer → false; junk host → false');

// ---------------------------------------------------------------------------
// Part B — REAL sqlite (isolated throwaway DB): the columns exist + round-trip through curation_store.
// ---------------------------------------------------------------------------
const tmp = path.join(os.tmpdir(), `sq_substantiation_smoke_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;
let realOk = true;
try {
  const realDb = require('../lib/db');
  realDb.init();

  // A doc-decomp promoted claim → source-vouched, frame real; persists into the new columns.
  CS.record(realDb, { feed: 'doc-decomp', sourceEntity: 'Jane Roe', relation: 'exists', url: 'docstore:7', status: 'promoted' });
  const rows = CS.list(realDb, { sourceEntity: 'Jane Roe' });
  ok(rows.length === 1, 'real: observation inserts with the new columns present');
  ok(rows[0].substantiation_state === S.SOURCE_VOUCHED, 'real: substantiation_state column persisted (source-vouched)');
  ok(rows[0].frame === S.FRAME_REAL, 'real: frame column persisted (real)');

  // A held claim → unsubstantiated.
  CS.record(realDb, { feed: 'doc-decomp', sourceEntity: 'Held Thing', relation: 'exists', url: 'docstore:8', status: 'held' });
  const held = CS.list(realDb, { sourceEntity: 'Held Thing' });
  ok(held[0].substantiation_state === S.UNSUBSTANTIATED, 'real: a held observation stored as unsubstantiated');

  // An explicit override is honored (a caller that KNOWS the entity resolved).
  CS.record(realDb, { feed: 'graph-walk', sourceEntity: 'Known Person', relation: 'exists', substantiationState: S.IDENTITY_CONFIRMED });
  const known = CS.list(realDb, { sourceEntity: 'Known Person' });
  ok(known[0].substantiation_state === S.IDENTITY_CONFIRMED, 'real: an explicit substantiationState override is stored verbatim');

  // graph_entities carries the columns too (schema check — nullable, populated by Slice 2).
  const cols = realDb.getDb().prepare("PRAGMA table_info(graph_entities)").all().map(c => c.name);
  ok(cols.includes('substantiation_state') && cols.includes('frame'), 'real: graph_entities gained substantiation_state + frame columns');
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
