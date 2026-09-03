/* smoke_knowledge_vectors.js — the knowledge store's parsed-vector cache (lib/memory knowledgeVectors).
 *
 * Freeze cut 11 (2026-09-03): the stall profiler named a 2.1s block on boot_p262 — every reader of the
 * embedding store re-read + JSON.parsed all 7,342 embeddings (59MB) per call. The cache keeps the parsed
 * vectors; metadata stays fresh; a changed/cleared/deleted vector rebuilds it (db.js version stamp).
 * Hermetic temp sq.db, no embedder (retrieveScored takes a precomputed query vector).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_knowledge_vectors.js
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kvec-smoke-'));
process.env.SQ_DB_PATH = path.join(tmp, 'sq.db');
const db = require('../lib/db');
db.init();
const memory = require('../lib/memory');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const unit = (i, n = 8) => { const v = new Array(n).fill(0); v[i % n] = 1; return v; };   // one-hot, L2-normalized
const land = (content, vec, extra = {}) => db.insertKnowledge({ kind: 'note', content, embedding: JSON.stringify(vec), source: 'smoke', importance: 0.5, ...extra }).id;

(async () => {
  const a = land('alpha fact', unit(0));
  const b = land('bravo fact', unit(1));
  const c = land('charlie topic', unit(2), { level: 'topic' });
  const v1 = memory.knowledgeVectors();
  ok(v1.length === 3 && v1.every((r) => r.vec instanceof Float64Array && r.vec.length === 8), 'every stored embedding comes back parsed once, as a Float64Array');
  ok(v1.find((r) => r.id === c).level === 'topic' && v1.find((r) => r.id === a).kind === 'note', 'the light rows carry the metadata the readers use (level, kind, …)');
  const s1 = memory._knowledgeVectorsStats();
  ok(s1.fetched === 3 && s1.rebuilds === 0, `the first call fetched the three vectors (${s1.fetched}), no rebuild`);

  // a new row is fetched by id — the cache is not rebuilt, the others are not re-parsed
  const d = land('delta fact', unit(3));
  const v2 = memory.knowledgeVectors();
  const s2 = memory._knowledgeVectorsStats();
  ok(v2.length === 4 && v2.some((r) => r.id === d) && s2.fetched === 4 && s2.rebuilds === 0, 'CRITICAL: a new note is fetched by id — one parse, no rebuild, nothing re-read');
  ok(memory.knowledgeVectors().length === 4 && memory._knowledgeVectorsStats().fetched === 4, 'a call with nothing new parses nothing');

  // recency metadata is FRESH even though the vectors are cached
  const before = memory.knowledgeVectors().find((r) => r.id === a).last_used_ts;
  await new Promise((r) => setTimeout(r, 5));
  db.touchKnowledge(a);
  const after = memory.knowledgeVectors().find((r) => r.id === a).last_used_ts;
  ok((after || 0) > (before || 0) && memory._knowledgeVectorsStats().rebuilds === 0, 'a touch (recency) is seen on the next call without a rebuild — the metadata is read fresh');

  // a CHANGED vector rebuilds: the reader sees the new embedding, not the cached one
  db.setKnowledgeEmbedding(b, JSON.stringify(unit(5)));
  const vb = memory.knowledgeVectors().find((r) => r.id === b);
  ok(vb.vec[5] === 1 && vb.vec[1] === 0 && memory._knowledgeVectorsStats().rebuilds === 1, 'CRITICAL: a re-set embedding bumps the version → the cache rebuilds and serves the NEW vector');

  // a CLEARED vector leaves the set; a deleted source leaves the set
  db.updateKnowledge(c, { content: 'charlie topic (re-merged, re-embed failed)', clearEmbedding: true });
  ok(!memory.knowledgeVectors().some((r) => r.id === c) && memory._knowledgeVectorsStats().rebuilds === 2, 'a cleared embedding drops the row (and rebuilds)');
  const e = land('echo fact', unit(6), { source: 'smoke-doomed' });
  ok(memory.knowledgeVectors().some((r) => r.id === e), 'a row under another source is present…');
  db.deleteKnowledgeBySource('smoke-doomed');
  ok(!memory.knowledgeVectors().some((r) => r.id === e) && memory._knowledgeVectorsStats().rebuilds === 3, '…and gone after its source is deleted (a rebuild)');

  // the readers agree with the old arithmetic: scored retrieval with a precomputed query vector
  const top = await memory.retrieveScored('', { k: 1, qv: unit(3), minRelevance: 0.5 });
  ok(top.length === 1 && top[0].id === d, 'retrieveScored over the cache finds the exact-match note first (cosine 1.0 on the same doubles)');
  const none = await memory.retrieveScored('', { k: 2, qv: unit(7), minRelevance: 0.5 });
  ok(none.length === 0, 'the relevance floor still holds (no note near the query → nothing)');

  // a store without the light doors (a mock) still works through the old shape
  const mockRows = [{ id: 1, kind: 'note', source: 's', embedding: JSON.stringify(unit(0)), importance: 0.5, created_ts: 1, last_used_ts: 1, level: null, parent_id: null }];
  const realGet = db.getKnowledgeVectorRows; db.getKnowledgeVectorRows = undefined;
  const realAll = db.getAllKnowledgeEmbeddings; db.getAllKnowledgeEmbeddings = () => mockRows;
  const mv = memory.knowledgeVectors();
  ok(mv.length === 1 && Array.isArray(mv[0].vec) && mv[0].vec[0] === 1, 'without the doors the reader falls back to parsing the full rows (a mock store keeps working)');
  db.getKnowledgeVectorRows = realGet; db.getAllKnowledgeEmbeddings = realAll;

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke_knowledge_vectors crashed:', e); process.exit(1); });
