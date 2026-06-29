/* Smoke: cloud_curator.mergeNearDupKnowledge (deterministic — injected relate/merge/embed).
 * Proves: a confirmed near-dup cluster collapses to the highest-importance row (rewritten);
 * a distinct cluster is skipped; self_evolution + topic rows are EXCLUDED from clustering.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_neardup_knowledge.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_neardup_${process.pid}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const curator = require('C:/Users/azrae/Desktop/Side Quest/lib/cloud_curator');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const v = (a) => JSON.stringify(a);
const relateFn = async (texts) => ({ same: /Fact A/.test(texts.join(' ')) });
const mergeFn = async () => 'MERGED Fact A (consolidated).';
const embedFn = async () => [7, 7, 7, 7];

(async () => {
  try {
    db.init();
    // Cluster A — two near-dup notes (same embedding), different importance → keep the higher.
    const aLow = db.insertKnowledge({ kind: 'note', content: 'Fact A, phrasing one', source: 'reflection_knowledge', importance: 0.5, embedding: v([1, 0, 0, 0]) }).id;
    const aHigh = db.insertKnowledge({ kind: 'note', content: 'Fact A, phrasing two', source: 'reflection_knowledge', importance: 0.9, embedding: v([1, 0, 0, 0]) }).id;
    // Cluster B — distinct.
    const b1 = db.insertKnowledge({ kind: 'note', content: 'Fact B about tides', source: 'reflection_knowledge', importance: 0.5, embedding: v([0, 1, 0, 0]) }).id;
    const b2 = db.insertKnowledge({ kind: 'note', content: 'Fact B about something else', source: 'reflection_knowledge', importance: 0.5, embedding: v([0, 1, 0, 0]) }).id;
    // Excluded rows: a self_evolution note (same vector as cluster A) and a topic rollup.
    const selfEvo = db.insertKnowledge({ kind: 'note', content: 'My view evolved — trait', source: 'self_evolution', importance: 0.6, embedding: v([1, 0, 0, 0]) }).id;
    const topic = db.insertKnowledge({ kind: 'note', content: 'Topic overview', source: 'reflection_knowledge', importance: 0.6, level: 'topic', embedding: v([1, 0, 0, 0]) }).id;

    console.log('dry-run plans, writes nothing:');
    const dry = await curator.mergeNearDupKnowledge({ apply: false, relateFn, mergeFn, embedFn });
    ok(dry.clusters === 2, 'two clusters (A near-dup, B distinct) — self_evolution + topic excluded from clustering');
    ok(dry.collapsed === 0, 'dry run collapsed nothing');
    ok(dry.results.some(r => r.action === 'would-merge') && dry.results.some(r => r.action === 'skip-distinct'), 'A→merge, B→skip planned');

    console.log('apply:');
    const applied = await curator.mergeNearDupKnowledge({ apply: true, relateFn, mergeFn, embedFn });
    ok(applied.collapsed === 1, 'collapsed exactly 1 dup row (cluster A)');
    const aliveA = db.getDb().prepare(`SELECT id, content FROM knowledge WHERE id IN (${aLow},${aHigh})`).all();
    ok(aliveA.length === 1 && aliveA[0].id === aHigh, 'kept the HIGHER-importance row of cluster A');
    ok(aliveA[0] && /MERGED Fact A/.test(aliveA[0].content), 'survivor rewritten to the consolidated note');
    ok(db.getDb().prepare(`SELECT COUNT(*) n FROM knowledge WHERE id IN (${b1},${b2})`).get().n === 2, 'cluster B untouched (distinct)');
    ok(!!db.getDb().prepare(`SELECT 1 FROM knowledge WHERE id=${selfEvo}`).get(), 'self_evolution row untouched (excluded)');
    ok(!!db.getDb().prepare(`SELECT 1 FROM knowledge WHERE id=${topic}`).get(), 'topic rollup untouched (excluded)');
    const k = db.getDb().prepare('SELECT COUNT(*) n FROM knowledge').get().n;
    const ftc = db.getDb().prepare('SELECT COUNT(*) n FROM knowledge_fts').get().n;
    ok(k === ftc, 'FTS index in lockstep (no orphans)');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
