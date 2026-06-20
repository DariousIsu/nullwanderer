/**
 * READ-ONLY: how a web reading becomes durable, retrievable memory — and whether
 * it actually does. Traces the pipeline stage by stage against the live DB:
 *   reading (monologue) → importance → reflection_importance_accum
 *     → significance reflection → knowledge note (embedded) → scored retrieval
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\inspect_memory_pipeline.js
 */
const D = require('../lib/db');
D.init();
const memory = require('../lib/memory');
const db = D.getDb();
const short = (s, n = 100) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

(async () => {
  await memory.warm().catch(() => {});

  console.log('=== STAGE 1 — web readings (episodic, in monologue table) ===');
  const webReadings = db.prepare(`SELECT COUNT(*) n, MIN(importance) mn, MAX(importance) mx, AVG(importance) av FROM monologue WHERE type='reading' AND model IN ('web-read','web-open','duckduckgo','browser-read')`).get();
  console.log(`  web/search readings: ${webReadings.n} | importance min ${webReadings.mn} / avg ${webReadings.av == null ? '-' : webReadings.av.toFixed(1)} / max ${webReadings.mx}`);
  const lastDeep = db.prepare(`SELECT query, content, ts FROM monologue WHERE type='reading' AND model='web-read' AND content LIKE '%opened the top result%' ORDER BY ts DESC LIMIT 2`).all();
  console.log(`  readings that auto-deepened (real page content): ${db.prepare(`SELECT COUNT(*) n FROM monologue WHERE model='web-read' AND content LIKE '%opened the top result%'`).get().n}`);
  for (const r of lastDeep) console.log(`    • ${short(r.content, 130)}`);

  console.log('\n=== STAGE 2 — accumulator (drives reflection) ===');
  console.log(`  reflection_importance_accum: ${db.prepare(`SELECT value FROM meta WHERE key='reflection_importance_accum'`).get()?.value || '0'} / 150`);
  console.log(`  last_significance_monologue_id: ${db.prepare(`SELECT value FROM meta WHERE key='last_significance_monologue_id'`).get()?.value || '0'}`);

  console.log('\n=== STAGE 3 — durable knowledge by source/kind ===');
  for (const r of db.prepare(`SELECT source, kind, COUNT(*) n FROM knowledge GROUP BY source, kind ORDER BY n DESC`).all()) {
    console.log(`  ${String(r.n).padStart(4)}  ${(r.source || 'null')} / ${r.kind}`);
  }

  console.log('\n=== STAGE 3b — recent REFLECTION insight notes (what browsing compounds INTO) ===');
  for (const r of db.prepare(`SELECT content, importance, created_ts FROM knowledge WHERE source='reflection' ORDER BY created_ts DESC LIMIT 8`).all()) {
    console.log(`  • ${short(r.content, 120)}`);
  }
  const reflNoteCount = db.prepare(`SELECT COUNT(*) n FROM knowledge WHERE source='reflection'`).get().n;
  console.log(`  (total reflection notes: ${reflNoteCount})`);

  console.log('\n=== STAGE 4 — FUTURE USE: scored retrieval probes (would this come back when relevant?) ===');
  for (const q of ['writing a professional email', 'AI in everyday life', 'what Lucas meant by indulge']) {
    const hits = await memory.retrieveScored(q, { k: 3 });
    console.log(`  query: "${q}"`);
    if (!hits.length) console.log('    (nothing retrieved)');
    for (const h of hits) console.log(`    ← [${h.source || '?'}/${h.kind}] ${short(h.content, 90)}`);
  }

  console.log('\n=== LINKAGE — are notes connected (A-MEM style) or a flat bag? ===');
  const linked = db.prepare(`SELECT COUNT(*) n FROM knowledge WHERE links IS NOT NULL AND links != ''`).get().n;
  console.log(`  notes with links: ${linked} / ${D.countKnowledge()} total`);

  db.close();
})();
