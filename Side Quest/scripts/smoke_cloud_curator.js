/* Smoke: cloud_curator Slice 1a local pre-clean. Deterministic, model-free (hand-injected
 * embeddings), isolated temp DB via SQ_DB_PATH. Validates the quarantine prune respects the
 * spawn-gate window, prunes only stale rows, and that self_evolution clustering is report-only.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_cloud_curator.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_curator_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const curator = require('C:/Users/azrae/Desktop/Side Quest/lib/cloud_curator');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const v = (a) => JSON.stringify(a);   // 4-dim fixture embeddings (consistent length → cosine works)

try {
  db.init();
  // Fixtures: tombstones + speculation (quarantine) and two self_evolution clusters + a singleton.
  db.insertKnowledge({ kind: 'note', content: 'Focus "A" → resolved', source: 'focus_tombstone' });
  db.insertKnowledge({ kind: 'note', content: 'Focus "B" → resolved', source: 'focus_tombstone' });
  db.insertKnowledge({ kind: 'note', content: 'Focus "C" → resolved', source: 'focus_tombstone' });
  db.insertKnowledge({ kind: 'note', content: 'ungrounded guess', source: 'reflection_speculation' });
  // self_evolution cluster 1 (3 rows, same trait), cluster 2 (2 rows), + 1 singleton — all distinct vectors.
  db.insertKnowledge({ kind: 'note', content: 'My view evolved — trait X (1)', source: 'self_evolution', embedding: v([1, 0, 0, 0]) });
  db.insertKnowledge({ kind: 'note', content: 'My view evolved — trait X (2)', source: 'self_evolution', embedding: v([1, 0, 0, 0]) });
  db.insertKnowledge({ kind: 'note', content: 'My view evolved — trait X (3)', source: 'self_evolution', embedding: v([1, 0, 0, 0]) });
  db.insertKnowledge({ kind: 'note', content: 'My view evolved — trait Y (1)', source: 'self_evolution', embedding: v([0, 1, 0, 0]) });
  db.insertKnowledge({ kind: 'note', content: 'My view evolved — trait Y (2)', source: 'self_evolution', embedding: v([0, 1, 0, 0]) });
  db.insertKnowledge({ kind: 'note', content: 'My view evolved — trait Z (solo)', source: 'self_evolution', embedding: v([0, 0, 1, 0]) });
  // A normal recallable note that must NEVER be touched.
  db.insertKnowledge({ kind: 'note', content: 'The Maastricht Treaty set EU convergence criteria in 1992.', source: 'reflection_knowledge', embedding: v([0, 0, 0, 1]) });

  const total0 = db.getDb().prepare('SELECT COUNT(*) n FROM knowledge').get().n;

  console.log('safety: recent tombstones are NOT prunable (spawn-gate window respected):');
  const planNow = curator.planQuarantinePrune({ now: Date.now() });
  ok(planNow.detail.stale_tombstones === 0, 'fresh tombstones counted as stale: 0');
  ok(planNow.detail.kept_recent_tombstones === 3, 'all 3 fresh tombstones kept for the spawn-gate');
  ok(planNow.detail.speculation === 1, 'speculation row flagged regardless of age');

  console.log('R4: volume cap prunes oldest overflow even within the window:');
  const capped = curator.planQuarantinePrune({ now: Date.now(), keepMax: 2 });
  ok(capped.detail.overflow_tombstones === 1, 'keepMax=2 with 3 fresh tombstones → 1 overflow (oldest) pruned');
  ok(capped.detail.kept_recent_tombstones === 2, 'newest 2 kept');
  ok(capped.pruneIds.length === 2, 'prune plan = 1 overflow tombstone + 1 speculation');

  console.log('dry-run with time advanced past the 48h window:');
  const future = Date.now() + 3 * curator.TOMBSTONE_SAFE_MS;
  const dry = curator.preClean({ apply: false, now: future });
  ok(dry.apply === false && dry.knowledge_after === total0, 'dry run wrote nothing');
  ok(dry.quarantine.detail.stale_tombstones === 3, 'now 3 tombstones are stale');
  ok(dry.quarantine.pruneIds.length === 4, 'prune plan = 3 stale tombstones + 1 speculation');

  console.log('self_evolution clustering (report-only):');
  ok(dry.self_evolution.clusters.length === 2, 'found 2 multi-row clusters (trait X, trait Y)');
  ok(dry.self_evolution.would_collapse === 3, 'would collapse 3 dup rows (2 from X + 1 from Y)');

  console.log('apply (Job A only): prunes quarantine, leaves self_evolution + real notes intact:');
  const applied = curator.preClean({ apply: true, now: future });
  ok(applied.removed === 4, 'removed exactly the 4 quarantine rows');
  const remTomb = db.getDb().prepare("SELECT COUNT(*) n FROM knowledge WHERE source='focus_tombstone'").get().n;
  const remSpec = db.getDb().prepare("SELECT COUNT(*) n FROM knowledge WHERE source='reflection_speculation'").get().n;
  const remSelf = db.getDb().prepare("SELECT COUNT(*) n FROM knowledge WHERE source='self_evolution'").get().n;
  const remReal = db.getDb().prepare("SELECT COUNT(*) n FROM knowledge WHERE source='reflection_knowledge'").get().n;
  ok(remTomb === 0 && remSpec === 0, 'quarantine rows gone');
  ok(remSelf === 6, 'self_evolution rows untouched (apply deferred to cloud stage)');
  ok(remReal === 1, 'recallable knowledge untouched');
  // FTS shadow stays consistent (deleted rows removed from the index — no orphan match).
  const ftsOrphan = db.ftsSearchKnowledge('Focus resolved', 10).length;
  ok(ftsOrphan === 0, 'pruned rows also removed from the FTS index (no orphans)');
} catch (e) {
  fail++; console.error('  ✗ threw:', e.stack || e.message);
} finally {
  try { db.getDb().close(); } catch {}
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
