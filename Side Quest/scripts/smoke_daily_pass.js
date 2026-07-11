/* Smoke: cloud_curator.runDailyPass orchestration. Deterministic (injected relate/merge/embed),
 * isolated temp DB. Proves all four stages run + report through the orchestrator, and that a
 * failing stage is isolated (the pass continues). Run via ELECTRON_RUN_AS_NODE.
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_pass_${process.pid}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const gm = require('C:/Users/azrae/Desktop/Side Quest/lib/graph_memory');
const curator = require('C:/Users/azrae/Desktop/Side Quest/lib/cloud_curator');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const v = (a) => JSON.stringify(a);
const relateFn = async () => ({ same: true });           // every cluster here is a real dup
const mergeFn = async () => 'MERGED consolidated note.';
const embedFn = async () => [9, 9, 9, 9];

(async () => {
  try {
    db.init();
    db.insertKnowledge({ kind: 'note', content: 'ungrounded speculation', source: 'reflection_speculation' });          // quarantine
    db.insertKnowledge({ kind: 'note', content: 'dup note one', source: 'reflection_knowledge', embedding: v([1, 0, 0, 0]) }); // near-dup
    db.insertKnowledge({ kind: 'note', content: 'dup note two', source: 'reflection_knowledge', embedding: v([1, 0, 0, 0]) });
    db.insertKnowledge({ kind: 'note', content: 'My view evolved — a', source: 'self_evolution', embedding: v([0, 1, 0, 0]) }); // self-evo
    db.insertKnowledge({ kind: 'note', content: 'My view evolved — b', source: 'self_evolution', embedding: v([0, 1, 0, 0]) });
    gm.recordEntity({ name: 'Foo Corp', type: 'org', epistemic: 'told' });                                               // canonical
    db.graphInsertEntityProposal({ name: 'Foo Corp', entityType: 'org', epistemic: 'speculated' });                     // superseded → graph reject

    console.log('runDailyPass(apply=false) surfaces would-collapse counts:');
    const dry = await curator.runDailyPass({ apply: false, relateFn, mergeFn, embedFn, onLog: () => {} });
    ok(dry.stages.quarantine.removed === 0, 'dry run prunes nothing');
    ok(dry.stages.nearDup.wouldCollapse === 1, 'dry run reports near-dup wouldCollapse=1');
    ok(dry.stages.selfEvo.wouldCollapse === 1, 'dry run reports self-evo wouldCollapse=1');

    console.log('runDailyPass(apply=true):');
    const logs = [];
    const r = await curator.runDailyPass({ apply: true, relateFn, mergeFn, embedFn, onLog: (m) => logs.push(m) });

    ok(r.stages.quarantine.removed === 1, 'quarantine stage pruned the speculation row');
    ok(r.stages.nearDup.collapsed === 1, 'near-dup stage collapsed the dup cluster (−1)');
    ok(r.stages.selfEvo.collapsed === 1, 'self-evo stage collapsed its cluster (−1)');
    ok(r.stages.graph.rejected === 1, 'graph stage rejected the superseded proposal');
    ok(r.stages.verified && r.stages.verified.superseded === 0, 'verified stage ran (no facts → 0 superseded)');
    ok(r.stages.interests && !r.stages.interests.error, 'interests reweight stage ran (no interests → no-op, no error)');
    ok(r.stages.meta && !r.stages.meta.error, 'meta pass stage ran (no interests → no-op, no error)');
    ok(logs.length === 8, 'every stage emitted a log line (quarantine, verified, near-dup, self-evo, graph, graph-promote, interests, meta)');

    const k = db.getDb().prepare('SELECT COUNT(*) n FROM knowledge').get().n;
    const ftc = db.getDb().prepare('SELECT COUNT(*) n FROM knowledge_fts').get().n;
    ok(k === ftc, 'FTS index in lockstep after the full pass');
    ok(db.graphListPendingEntityProposals(10).length === 0, 'no pending proposals remain');

    console.log('isolation — a throwing stage does not abort the pass:');
    db.insertKnowledge({ kind: 'note', content: 'dup three', source: 'reflection_knowledge', embedding: v([1, 0, 0, 0]) });
    db.insertKnowledge({ kind: 'note', content: 'dup four', source: 'reflection_knowledge', embedding: v([1, 0, 0, 0]) });
    const boom = async () => { throw new Error('cloud down'); };
    const r2 = await curator.runDailyPass({ apply: true, relateFn: boom, mergeFn, embedFn, onLog: () => {} });
    ok(r2.stages.nearDup && !r2.stages.nearDup.error, 'near-dup survived (relate threw per-cluster → skip, not abort)');
    ok(!!r2.stages.graph && r2.stages.graph.error === undefined, 'graph stage still ran after the cloud-dependent ones');

    console.log('graph stage — RELATION-proposal arm (Slice 2, the previously-unadjudicated queue):');
    // A grounded canonical edge (recordRelation mints BOTH endpoints) → a proposal for the SAME edge is redundant.
    gm.recordRelation({ source: 'Acme LLC', target: 'Beta Fund', type: 'DONATED_TO', epistemic: 'read' });
    db.graphInsertRelationProposal({ sourceName: 'Acme LLC', targetName: 'Beta Fund', relationType: 'DONATED_TO', epistemic: 'speculated' });  // → superseded
    db.graphInsertRelationProposal({ sourceName: 'Gamma PAC', targetName: 'Delta Org', relationType: 'FUNDS', epistemic: 'speculated' });       // → ungrounded → kept now, stale later
    const adjNow = curator.adjudicateGraphProposals({ apply: false });
    ok(adjNow.relation.pending === 2, 'relation arm: sees both pending relation proposals (queue is now adjudicated)');
    ok(adjNow.relation.superseded === 1, 'relation arm: a proposal matching a grounded canonical edge → superseded');
    ok(adjNow.relation.stale === 0, 'relation arm: the fresh ungrounded proposal is NOT stale yet');
    const future = Date.now() + 8 * 24 * 3600 * 1000;
    const adjFuture = curator.adjudicateGraphProposals({ apply: false, now: future });
    ok(adjFuture.relation.stale === 1, 'relation arm: an ungrounded proposal past staleDays → stale (falls away, reversibly)');
    const adjApply = curator.adjudicateGraphProposals({ apply: true, now: future });
    ok(adjApply.rejected >= 2, 'relation arm(apply): rejects both the superseded and the stale relation proposal');
    ok(db.graphListPendingRelationProposals(10).length === 0, 'relation arm(apply): no pending relation proposals remain');

    console.log('graph promote-up arm (Slice 3 — cross matured local edges UP to Echo, Echo is the gate):');
    gm.recordRelation({ source: 'Local Source Co', target: 'Local Target Co', type: 'PARTNERS_WITH', epistemic: 'read', sourceObj: { kind: 'reading', ref: 'https://ex.com/lsc' } });
    const dryUp = await curator.promoteLocalEdgesUp({ apply: false });
    ok(dryUp.candidates >= 1, 'promote-up(dry): a grounded, not-yet-crossed local edge is a candidate');
    ok(dryUp.promoted === 0, 'promote-up(dry): nothing crosses on a dry run');
    // Echo REJECTS (endpoint still young) → not marked, stays retryable next pass
    const upReject = await curator.promoteLocalEdgesUp({ apply: true, proposeFn: async () => ({ ok: false, action: 'rejected' }) });
    ok(upReject.promoted === 0 && upReject.skipped >= 1, 'promote-up(reject): a young-endpoint edge does NOT cross; counted skipped');
    ok((await curator.promoteLocalEdgesUp({ apply: false })).candidates >= 1, 'promote-up(reject): the un-crossed edge is STILL a candidate (promoted_up unchanged → self-healing retry)');
    // Echo ACCEPTS → edge crosses + is marked promoted_up (carrying its citation), never re-sent
    const seen = [];
    const upOk = await curator.promoteLocalEdgesUp({ apply: true, proposeFn: async (e) => { seen.push(e); return { ok: true, action: 'proposed' }; } });
    ok(upOk.promoted >= 1, 'promote-up(accept): the edge crosses to Echo (action=proposed)');
    ok(seen.some(e => e.source === 'Local Source Co' && e.target === 'Local Target Co' && e.relation_type === 'PARTNERS_WITH'), 'promote-up(accept): proposeFn receives the edge endpoints + relation_type');
    ok(seen.some(e => e.metadata && Array.isArray(e.metadata.source_set) && e.metadata.source_set[0] === 'https://ex.com/lsc'), 'promote-up(accept): the crossing carries the local citation url (provenance preserved)');
    ok((await curator.promoteLocalEdgesUp({ apply: false })).candidates === 0, 'promote-up(accept): a crossed edge is marked promoted_up → NOT re-sent next pass');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
