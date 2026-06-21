/** Prove episodic recall: a Father's-Day-style turn is retrievable later by a related
 *  query, the min-sim gate suppresses unrelated queries, and excludeIds drops recency-window
 *  turns. Real bge-small embedder, temp DB. */
const os = require('os'), path = require('path'), fs = require('fs');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_recall_${Date.now()}.db`);
const db = require('../lib/db'); db.init();
const mem = require('../lib/memory');
let pass = 0, fail = 0;
const ok = (n, c) => { (c ? pass++ : fail++); console.log(`  ${c ? '✓' : '✗'} ${n}`); };

(async () => {
  const sid = db.startSession();
  // seed a few turns + their embeddings (simulating insert-time embedding)
  const seed = async (speaker, content) => {
    const r = db.insertTurn({ sessionId: sid, speaker, content });
    const v = await mem.embed(content);
    db.setTurnEmbedding(r.id, JSON.stringify(v));
    return r.id;
  };
  const fdId = await seed('user', "My kids are cooking me breakfast for Father's Day this Sunday, then we're going to the park.");
  await seed('user', 'The permitting reform bill has fixed environmental review deadlines.');
  await seed('ai_said', 'Salesforce duplicate rules can be tuned with matching rules.');

  console.log('relevant query recalls the Father\'s Day turn:');
  const hits = await mem.retrieveTurns("remind me what my Father's Day plans were", { k: 3, excludeIds: [] });
  ok('returns at least one match', hits.length >= 1);
  ok('top match IS the Father\'s Day turn', hits[0] && hits[0].id === fdId);

  console.log('\nunrelated query is suppressed by the min-sim gate:');
  const none = await mem.retrieveTurns('explain quantum chromodynamics gluon confinement', { k: 3, excludeIds: [] });
  ok('returns nothing (no false recall)', none.length === 0);

  console.log('\nexcludeIds drops a recency-window turn:');
  const ex = await mem.retrieveTurns("remind me what my Father's Day plans were", { k: 3, excludeIds: [fdId] });
  ok('Father\'s Day turn excluded when in the recency window', !ex.some(h => h.id === fdId));

  db.getDb().close();
  try { for (const e of ['', '-wal', '-shm']) fs.existsSync(process.env.SQ_DB_PATH + e) && fs.unlinkSync(process.env.SQ_DB_PATH + e); } catch {}
  console.log(`\n${fail === 0 ? 'EPISODIC RECALL OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
