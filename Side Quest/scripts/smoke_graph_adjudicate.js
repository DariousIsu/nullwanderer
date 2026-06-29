/* Smoke: cloud_curator.adjudicateGraphProposals (deterministic). Isolated temp DB.
 * Proves: a proposal whose entity is now grounded canonically is SUPERSEDED; an old ungrounded
 * one is STALE; a recent ungrounded one is KEPT; apply rejects the resolved ones only.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_graph_adjudicate.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_gadj_${process.pid}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const gm = require('C:/Users/azrae/Desktop/Side Quest/lib/graph_memory');
const curator = require('C:/Users/azrae/Desktop/Side Quest/lib/cloud_curator');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

try {
  db.init();
  // A grounded canonical entity that a pending proposal duplicates → that proposal is superseded.
  gm.recordEntity({ name: 'Alpha Corp', type: 'org', epistemic: 'told' });
  db.graphInsertEntityProposal({ name: 'Alpha Corp', entityType: 'org', epistemic: 'speculated' }); // superseded
  db.graphInsertEntityProposal({ name: 'Beta Thing', entityType: 'concept', epistemic: 'speculated' }); // stale-or-kept
  db.graphInsertEntityProposal({ name: 'Gamma Co', entityType: 'org', epistemic: 'speculated' });     // stale-or-kept
  const pendCount = () => db.graphListPendingEntityProposals(1000).length;

  console.log('dry-run at normal time — only the superseded one is resolvable:');
  const dryNow = curator.adjudicateGraphProposals({ apply: false });
  ok(dryNow.pending === 3, 'sees 3 pending proposals');
  ok(dryNow.superseded === 1, '1 superseded (Alpha Corp is already canonical)');
  ok(dryNow.stale === 0 && dryNow.kept === 2, '0 stale, 2 kept (Beta/Gamma still fresh + ungrounded)');
  ok(pendCount() === 3, 'dry run rejected nothing');

  console.log('dry-run with time advanced past the stale window:');
  const future = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const dryFuture = curator.adjudicateGraphProposals({ apply: false, now: future });
  ok(dryFuture.superseded === 1 && dryFuture.stale === 2 && dryFuture.kept === 0, '1 superseded + 2 stale, 0 kept');

  console.log('apply (future): rejects the resolved ones, canonical untouched:');
  const applied = curator.adjudicateGraphProposals({ apply: true, now: future });
  ok(applied.rejected === 3, 'rejected all 3 (1 superseded + 2 stale)');
  ok(pendCount() === 0, 'no pending proposals remain');
  ok(!!db.graphGetEntityByKey(gm.normalizeName('Alpha Corp')), 'the grounded canonical entity is untouched');
} catch (e) {
  fail++; console.error('  ✗ threw:', e.stack || e.message);
} finally {
  try { db.getDb().close(); } catch {}
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
