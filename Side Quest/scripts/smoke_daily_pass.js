/* Smoke: cloud_curator.runDailyPass orchestration. Deterministic (injected relate/merge/embed),
 * isolated temp DB. Proves all four stages run + report through the orchestrator, and that a
 * failing stage is isolated (the pass continues). Run via ELECTRON_RUN_AS_NODE.
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_pass_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
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
    const T_REJ = Date.now();
    const upReject = await curator.promoteLocalEdgesUp({ apply: true, proposeFn: async () => ({ ok: false, action: 'rejected' }), now: T_REJ });
    ok(upReject.promoted === 0 && upReject.skipped >= 1, 'promote-up(reject): a young-endpoint edge does NOT cross; counted skipped');
    // (continuity cure #1) a rejected edge is NOTED and backs off a day — it is not hammered the same night…
    ok((await curator.promoteLocalEdgesUp({ apply: false, now: T_REJ + 60 * 1000 })).candidates === 0, 'promote-up(reject): inside its 1-day backoff the un-crossed edge steps aside (noted, not hammered)');
    // …and after the backoff it is a candidate again (promoted_up unchanged → self-healing retry)
    ok((await curator.promoteLocalEdgesUp({ apply: false, now: T_REJ + 24 * 3600 * 1000 + 1000 })).candidates >= 1, 'promote-up(reject): after the backoff the un-crossed edge is a candidate again (self-healing retry)');
    // Echo ACCEPTS → edge crosses + is marked promoted_up (carrying its citation), never re-sent
    const seen = [];
    const upOk = await curator.promoteLocalEdgesUp({ apply: true, proposeFn: async (e) => { seen.push(e); return { ok: true, action: 'proposed' }; }, now: T_REJ + 24 * 3600 * 1000 + 1000 });
    ok(upOk.promoted >= 1, 'promote-up(accept): the edge crosses to Echo (action=proposed)');
    ok(seen.some(e => e.source === 'Local Source Co' && e.target === 'Local Target Co' && e.relation_type === 'PARTNERS_WITH'), 'promote-up(accept): proposeFn receives the edge endpoints + relation_type');
    ok(seen.some(e => e.metadata && Array.isArray(e.metadata.source_set) && e.metadata.source_set[0] === 'https://ex.com/lsc'), 'promote-up(accept): the crossing carries the local citation url (provenance preserved)');
    ok((await curator.promoteLocalEdgesUp({ apply: false, now: T_REJ + 40 * 24 * 3600 * 1000 })).candidates === 0, 'promote-up(accept): a crossed edge is marked promoted_up → NOT re-sent next pass (even past every backoff)');

    console.log('⭐ promote-up LEDGER + ROTATION (continuity cure #1, 2026-09-02 — 20 crossed EVER against 20,714: the head ate every turn):');
    {
      const DAY = 24 * 3600 * 1000;
      const T0 = T_REJ + 41 * DAY;   // past every backoff the pins above left behind — a clean clock for this block
      // three fresh edges: A (highest confidence, will HOLD forever), B and C (crossable)
      gm.recordRelation({ source: 'Held Source', target: 'Young Target', type: 'HOLDS_FOREVER', epistemic: 'read', confidence: 0.99 });
      gm.recordRelation({ source: 'Cross Source', target: 'Cross Target', type: 'CROSSES', epistemic: 'read', confidence: 0.9 });
      gm.recordRelation({ source: 'Cross Source 2', target: 'Cross Target 2', type: 'CROSSES', epistemic: 'read', confidence: 0.85 });
      const held = new Set();
      const gate = async (e) => (e.relation_type === 'HOLDS_FOREVER' ? { ok: false, action: 'held:target-mint' } : { ok: true, action: 'proposed' });
      // pass 1 with maxEdges 1: the head (0.99) is tried first and holds — it is NOTED, not silently retried
      const p1 = await curator.promoteLocalEdgesUp({ apply: true, proposeFn: gate, maxEdges: 1, now: T0 });
      const rowA = db.getDb().prepare("SELECT promote_attempts a, promote_last_ts t, promote_hold h FROM graph_relations WHERE relation_type = 'HOLDS_FOREVER'").get();
      ok(p1.promoted === 0 && p1.skipped === 1 && rowA.a === 1 && rowA.t >= T0 && rowA.h === 'held:target-mint', `⭐ a held edge leaves its ledger on the row (attempts 1, time, hold reason) — ${JSON.stringify(rowA)}`);
      ok(p1.held && p1.held['held:target-mint'] === 1, 'the report carries the hold histogram (what the gate actually said)');
      // pass 2 (same hour) with maxEdges 1: the head is INSIDE its 1-day backoff → the next edge gets the turn and crosses
      const p2 = await curator.promoteLocalEdgesUp({ apply: true, proposeFn: gate, maxEdges: 1, now: T0 + 60 * 1000 });
      ok(p2.promoted === 1 && p2.results[0].type === 'CROSSES', '⭐ ROTATION: inside its backoff the held head steps aside and the next edge crosses (the backlog gets its turn)');
      const crossed = db.getDb().prepare("SELECT promote_last_ts t, promoted_up u FROM graph_relations WHERE id = ?").get(p2.results[0].id);
      ok(crossed.u === 1 && crossed.t >= T0, 'a crossing stamps promote_last_ts — the memory map reads a real "last crossed"');
      // untried edges come before tried ones regardless of confidence
      const p3 = await curator.promoteLocalEdgesUp({ apply: false, maxEdges: 5, now: T0 + 60 * 1000 });
      ok(p3.candidates >= 1 && p3.results.every((r) => r.type !== 'HOLDS_FOREVER'), 'fewest-attempts-first: the held head is not among the candidates while it backs off');
      // after the backoff (1 day for one attempt) the held edge takes another turn; two attempts → 2 days
      const p4 = await curator.promoteLocalEdgesUp({ apply: true, proposeFn: gate, maxEdges: 5, now: T0 + DAY + 1000 });
      const rowA2 = db.getDb().prepare("SELECT promote_attempts a FROM graph_relations WHERE relation_type = 'HOLDS_FOREVER'").get();
      ok(p4.results.some((r) => r.type === 'HOLDS_FOREVER') && rowA2.a === 2, '⭐ BACKOFF: after 1 day the held edge takes another turn (attempts 2) — never dropped, never hammered');
      const p5 = await curator.promoteLocalEdgesUp({ apply: false, maxEdges: 5, now: T0 + DAY + DAY + 1000 });
      ok(!p5.results.some((r) => r.type === 'HOLDS_FOREVER'), 'two attempts → a 2-day backoff: one day after the second try it is still inside it (the doubling holds)');
      const p6 = await curator.promoteLocalEdgesUp({ apply: false, maxEdges: 5, now: T0 + 3 * DAY + 5000 });
      ok(p6.results.some((r) => r.type === 'HOLDS_FOREVER'), 'and past the 2-day backoff it is eligible again');
      // the time budget: a pass stops when its budget is spent and the rest keep their turn untouched
      gm.recordRelation({ source: 'Slow A', target: 'Slow B', type: 'SLOW', epistemic: 'read', confidence: 0.5 });
      gm.recordRelation({ source: 'Slow C', target: 'Slow D', type: 'SLOW', epistemic: 'read', confidence: 0.5 });
      const slow = async () => { await new Promise((r) => setTimeout(r, 60)); return { ok: false, action: 'held:target-review' }; };
      const p7 = await curator.promoteLocalEdgesUp({ apply: true, proposeFn: slow, maxEdges: 10, timeBudgetMs: 30, now: T0 + 10 * DAY });
      ok(p7.budgetHit === true && p7.results.length < p7.candidates, `⭐ TIME BUDGET: the pass stops when its budget is spent (${p7.results.length} of ${p7.candidates} tried) — the rest keep their turn`);
      const bl = db.graphPromoteUpBacklog({ now: T0 + 10 * DAY });
      ok(Number.isInteger(bl.pending) && Number.isInteger(bl.eligible) && Array.isArray(bl.holds) && bl.holds.some((h) => /held:/.test(h.hold)), `the backlog shape for the tee: ${JSON.stringify(bl)}`);
      // the wiring: the 20-min beat in main.js runs the SAME arm with the SAME gate, idle-gated, and says what it did
      const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
      ok(/function _promoteUpTick/.test(mainSrc) && /promoteLocalEdgesUp\(\{ apply: true, proposeFn: _makeProposeEchoRelationFn\(\)/.test(mainSrc) && /\[promote-up\]/.test(mainSrc),
        '⭐ WIRING: the promote-up BEAT (main.js) runs the arm on its own tick with the resolution-gate proposeFn — the bridge no longer waits for the nightly pass');
      ok(/const r = await cloudCurator\.runDailyPass\(\{ apply: true, proposeEchoRelationFn: _makeProposeEchoRelationFn\(\)/.test(mainSrc),
        'the nightly pass uses the same factored proposeFn (one gate, two cadences)');
      ok(/_conversationActive\(\)\) return;[^\n]*promote-up|lastUserTurnTs < PROMOTE_UP_IDLE_MS/.test(mainSrc), 'the beat yields to the live conversation (idle-gated like curation)');
    }
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
