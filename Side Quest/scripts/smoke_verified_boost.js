/* Smoke: memory verified-fact BOOST + FRAMING (piece 5). Deterministic — precomputed qv, no embedder.
 * Proves: an on-topic verified_fact wins the top slot via VERIFIED_BONUS even when a peer note is
 * newer (recency-favored); the relevance floor still excludes an off-topic fact; formatForPrompt
 * renders the [VERIFIED — as of …, source …] override line, not a peer [note].
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_verified_boost.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_vboost_${process.pid}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const memory = require('C:/Users/azrae/Desktop/Side Quest/lib/memory');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const v = (a) => JSON.stringify(a);

(async () => {
  try {
    db.init();
    // Verified fact inserted FIRST (so the peer note is newer → recency-favored without the boost).
    const verifiedId = db.insertKnowledge({ kind: 'note', content: 'The president is Y.', source: 'verified_fact', importance: 0.5, embedding: v([1, 0, 0, 0]), provenance: { as_of: '2026-06', url: 'https://example.gov/potus' } }).id;
    const normalId = db.insertKnowledge({ kind: 'note', content: 'A general note about presidents.', source: 'reflection_knowledge', importance: 0.5, embedding: v([1, 0, 0, 0]) }).id;
    const offId = db.insertKnowledge({ kind: 'note', content: 'Something unrelated.', source: 'reflection_knowledge', importance: 0.9, embedding: v([0, 1, 0, 0]) }).id;

    const res = await memory.retrieveScored('president', { k: 3, minRelevance: 0.3, qv: [1, 0, 0, 0] });
    ok(res.length === 2, 'floor excluded the off-topic fact (2 of 3 returned)');
    ok(!res.find(r => r.id === offId), 'off-topic fact not retrieved');
    ok(res[0] && res[0].id === verifiedId, 'verified_fact takes the TOP slot despite the peer note being newer (boost works)');

    const block = memory.formatForPrompt(res, 'Lucas');
    ok(/\[VERIFIED — as of 2026-06, source https:\/\/example\.gov\/potus\]/.test(block), 'framing: verified rendered with as_of + source');
    ok(/prefer THIS over anything you recall/.test(block), 'framing: explicit override instruction present');
    ok(!/\[note\] The president is Y/.test(block), 'verified fact NOT rendered as a peer [note]');
    void normalId;
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
