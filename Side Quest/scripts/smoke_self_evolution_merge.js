/* Smoke: cloud_curator.selfEvolutionMerge. Deterministic — cloud relate/merge + embedder are
 * injected, so no cloud/model. Isolated temp DB. Proves: a confirmed cluster collapses to one
 * (rewritten + dups deleted); a cluster the cloud flags DISTINCT is left intact; dry-run writes
 * nothing. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_self_evolution_merge.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_selfevo_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const curator = require('C:/Users/azrae/Desktop/Side Quest/lib/cloud_curator');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const v = (a) => JSON.stringify(a);

// Injected "cloud": cluster about trait X is one evolving view; trait Y is (falsely) lumped → distinct.
const relateFn = async (texts) => ({ same: /trait X/.test(texts.join(' ')) && !/trait Y/.test(texts.join(' ')) });
const mergeFn = async () => 'CONSOLIDATED current view of trait X (it evolved).';
const embedFn = async () => [9, 9, 9, 9];

(async () => {
  try {
    db.init();
    const xs = [
      db.insertKnowledge({ kind: 'note', content: 'My view evolved — trait X (a)', source: 'self_evolution', embedding: v([1, 0, 0, 0]) }).id,
      db.insertKnowledge({ kind: 'note', content: 'My view evolved — trait X (b)', source: 'self_evolution', embedding: v([1, 0, 0, 0]) }).id,
      db.insertKnowledge({ kind: 'note', content: 'My view evolved — trait X (c)', source: 'self_evolution', embedding: v([1, 0, 0, 0]) }).id,
    ];
    const ys = [
      db.insertKnowledge({ kind: 'note', content: 'My view evolved — trait Y (a)', source: 'self_evolution', embedding: v([0, 1, 0, 0]) }).id,
      db.insertKnowledge({ kind: 'note', content: 'My view evolved — trait Y (b)', source: 'self_evolution', embedding: v([0, 1, 0, 0]) }).id,
    ];
    const cnt = () => db.getDb().prepare("SELECT COUNT(*) n FROM knowledge WHERE source='self_evolution'").get().n;

    console.log('dry-run plans but writes nothing:');
    const dry = await curator.selfEvolutionMerge({ apply: false, relateFn, mergeFn, embedFn });
    ok(dry.clusters === 2, 'two cosine clusters (trait X, trait Y)');
    ok(dry.collapsed === 0 && cnt() === 5, 'nothing collapsed or deleted on dry run');
    ok(dry.results.some(r => r.action === 'would-merge') && dry.results.some(r => r.action === 'skip-distinct'),
       'X planned to merge, Y planned to skip');

    console.log('apply collapses the confirmed cluster, leaves the distinct one:');
    const applied = await curator.selfEvolutionMerge({ apply: true, relateFn, mergeFn, embedFn });
    ok(applied.collapsed === 2, 'collapsed exactly the 2 redundant trait-X rows');
    ok(cnt() === 3, 'self_evolution 5 → 3 (one X survivor + two Y)');

    const xAlive = db.getDb().prepare(`SELECT id, content FROM knowledge WHERE id IN (${xs.join(',')})`).all();
    ok(xAlive.length === 1, 'exactly one trait-X row survives');
    ok(xAlive[0] && /CONSOLIDATED/.test(xAlive[0].content), 'the survivor was rewritten to the consolidated note');
    const yAlive = db.getDb().prepare(`SELECT COUNT(*) n FROM knowledge WHERE id IN (${ys.join(',')})`).get().n;
    ok(yAlive === 2, 'both trait-Y rows untouched (cloud said distinct)');
    const k = db.getDb().prepare('SELECT COUNT(*) n FROM knowledge').get().n;
    const fts = db.getDb().prepare('SELECT COUNT(*) n FROM knowledge_fts').get().n;
    ok(k === fts, 'FTS index stays in lockstep (no orphans)');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
