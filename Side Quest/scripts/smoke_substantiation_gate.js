/* smoke_substantiation_gate.js — the READ half of lane-boundary §1.4.
 *
 * A node minted from one county PDF and a node confirmed against a register are both
 * status:'resolved' to the conversation lane, and they must not read the same in the prompt. The
 * write half stamps substantiation_state at the sink; this gate is what the prompt assembler calls
 * to tell them apart. pinned ⇔ identity-confirmed; unknown is NOT pinned.
 *
 * Runs against an in-memory database.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_substantiation_gate.js
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
process.env.SQ_DB_PATH = ':memory:';

const db = require('../lib/db');
db.init();
const store = require('../lib/curation_store');
const gate = require('../lib/substantiation_gate');
const SUB = require('../lib/substantiation');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ── unknown is not pinned ────────────────────────────────────────────────────────────────────────
ok(gate.stateFor(db, 'Never Observed Org') === null, 'an entity the log never saw → null');
ok(gate.isPinned(db, 'Never Observed Org') === false, 'CRITICAL: …and null reads NOT PINNED — unknown never vouches');
ok(gate.stateFor(db, '') === null && gate.stateFor(db, null) === null, 'garbage names → null, never a throw');

// ── the lifecycle: unsubstantiated mint → source-vouched sighting → identity confirmation ────────
// 1. what _mintUnsubstantiated writes (explicit state, as doc_decompose does)
store.record(db, { feed: 'doc-decomp', sourceEntity: 'Rainey Center Freedom Project', relation: 'exists',
  url: 'docstore:77', status: 'promoted', substantiationState: SUB.UNSUBSTANTIATED });
{
  const r = gate.stateFor(db, 'Rainey Center Freedom Project');
  ok(r && r.state === SUB.UNSUBSTANTIATED && !r.pinned, 'an unsubstantiated mint is visible and NOT pinned');
}
// 2. a cited sighting (the sink derives source-vouched from the doc-decomp feed + provenance)
store.record(db, { feed: 'doc-decomp', sourceEntity: 'Rainey Center Freedom Project', relation: 'related_to',
  target: 'Joseph Rainey Center for Public Policy', url: 'https://www.raineyfreedom.org/about' });
{
  const r = gate.stateFor(db, 'Rainey Center Freedom Project');
  ok(r && r.state === SUB.SOURCE_VOUCHED, 'strongest-across-observations: a vouched sighting outranks the unsub mint');
  ok(!r.pinned, 'CRITICAL: source-vouched is still NOT pinned — a source stands behind the claim, nothing confirmed the identity');
  ok(r.observations === 2 && r.counts[SUB.UNSUBSTANTIATED] === 1 && r.counts[SUB.SOURCE_VOUCHED] === 1,
    'the counts tell the whole story, not just the winner');
}
// 3. the async lane confirms identity (resolved:true → identity-confirmed at the sink)
store.record(db, { feed: 'doc-decomp', sourceEntity: 'Rainey Center Freedom Project', relation: 'exists',
  url: 'https://www.wikidata.org/wiki/Q999', resolved: true, kind: 'confirm' });
{
  const r = gate.stateFor(db, 'Rainey Center Freedom Project');
  ok(r && r.state === SUB.IDENTITY_CONFIRMED && r.pinned === true, 'identity confirmation PINS the node');
  ok(gate.isPinned(db, 'Rainey Center Freedom Project') === true, 'isPinned agrees');
}

// ── the upgrade path the async lane actually uses (in-place state flip, no new row) ──────────────
store.record(db, { feed: 'doc-decomp', sourceEntity: 'Alcona County Fair Board', relation: 'exists',
  url: 'docstore:78', substantiationState: SUB.UNSUBSTANTIATED });
ok(gate.isPinned(db, 'Alcona County Fair Board') === false, 'starts unpinned');
db.setSubstantiationForEntity('Alcona County Fair Board', SUB.IDENTITY_CONFIRMED);
ok(gate.isPinned(db, 'Alcona County Fair Board') === true, 'db.setSubstantiationForEntity upgrade is visible through the gate');

// ── case-insensitive fallback (exact indexed lookup first, scan second) ──────────────────────────
ok(gate.isPinned(db, 'rainey center freedom project') === true, 'a case-different lookup still finds the record');

// ── archived (faded) rows never vouch ────────────────────────────────────────────────────────────
{
  const rec = store.record(db, { feed: 'doc-decomp', sourceEntity: 'Faded Stub Committee', relation: 'exists',
    url: 'docstore:79', substantiationState: SUB.UNSUBSTANTIATED });
  ok(gate.stateFor(db, 'Faded Stub Committee') !== null, 'visible while live');
  db.setKgObservationStatus(rec.id, 'archived');
  ok(gate.stateFor(db, 'Faded Stub Committee') === null, 'CRITICAL: a faded row stops vouching entirely');
}

// ── a pre-substrate row with a NULL state counts as a sighting, never a vouching ─────────────────
db.recordKgObservation({ feed: 'legacy', sourceEntity: 'Old Import Person', obsKey: 'legacy:1' });
{
  const r = gate.stateFor(db, 'Old Import Person');
  ok(r && r.state === null && r.pinned === false && r.observations === 1 && r.counts.unstated === 1,
    'null-state rows are counted but cannot become the state');
}

// ── gateResolved — the one call the prompt assembler makes ───────────────────────────────────────
ok(gate.gateResolved(db, { status: 'resolved', object: { name: 'Rainey Center Freedom Project' } }).pinned === true,
  'a resolved mention of a confirmed node → pinned');
{
  const g = gate.gateResolved(db, { status: 'resolved', object: { name: 'Some Echo Bulk Import' } });
  ok(g.pinned === false && g.why === 'no-local-record', 'CRITICAL: resolved-by-Echo but never locally observed → NOT pinned (the §1.4 laundering case)');
}
ok(gate.gateResolved(db, { status: 'nil' }).pinned === false, 'a nil resolution is never pinned');
ok(gate.gateResolved(db, null).pinned === false, 'garbage input → unpinned, never a throw');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
