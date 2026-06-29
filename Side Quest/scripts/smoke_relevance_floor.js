/* Smoke: retrieveScored relevance floor. Deterministic via the precomputed `qv` param + fixed
 * note embeddings (no model). Proves off-topic notes are excluded, a no-match query returns
 * nothing, and floor=0 preserves the old behavior.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_relevance_floor.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_floor_${process.pid}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const memory = require('C:/Users/azrae/Desktop/Side Quest/lib/memory');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const v = (a) => JSON.stringify(a);

(async () => {
  try {
    db.init();
    // Unit vectors; cosine(qv,·) = dot product. qv = [1,0,0,0].
    db.insertKnowledge({ kind: 'note', content: 'RELEVANT (1.0)', source: 'reflection_knowledge', embedding: v([1, 0, 0, 0]) });
    db.insertKnowledge({ kind: 'note', content: 'MID (0.6)', source: 'reflection_knowledge', embedding: v([0.6, 0.8, 0, 0]) });
    db.insertKnowledge({ kind: 'note', content: 'WEAK (0.3)', source: 'reflection_knowledge', embedding: v([0.3, 0.9539392, 0, 0]) });
    db.insertKnowledge({ kind: 'note', content: 'OFFTOPIC (0.0)', source: 'reflection_knowledge', embedding: v([0, 1, 0, 0]) });

    const qvMatch = [1, 0, 0, 0];
    const got = await memory.retrieveScored('ignored', { k: 6, minRelevance: 0.35, qv: qvMatch });
    const contents = got.map(r => r.content);
    console.log('floor 0.35, matching query:');
    ok(got.length === 2, 'only the 2 notes clearing the floor are returned');
    ok(contents.some(c => /RELEVANT/.test(c)) && contents.some(c => /MID/.test(c)), 'kept RELEVANT + MID');
    ok(!contents.some(c => /WEAK|OFFTOPIC/.test(c)), 'dropped WEAK + OFFTOPIC (below floor)');

    console.log('floor 0.35, query that matches NOTHING:');
    const none = await memory.retrieveScored('ignored', { k: 6, minRelevance: 0.35, qv: [0, 0, 1, 0] });
    ok(none.length === 0, 'returns nothing rather than the least-irrelevant filler');

    console.log('floor 0 (default) — unchanged behavior:');
    const all = await memory.retrieveScored('ignored', { k: 6, minRelevance: 0, qv: qvMatch });
    ok(all.length === 4, 'all 4 notes returned when no floor is set');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
