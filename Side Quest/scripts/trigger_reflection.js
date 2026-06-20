// One-shot: force a significance reflection on the LIVE DB and show how it routes
// into the two tracks. Shares the running app's ollama (num_ctx 8192) + WAL DB.
const D = require('../lib/db'); D.init();
const reflection = require('../lib/reflection');
const memory = require('../lib/memory');
(async () => {
  await memory.warm().catch(() => {});
  const recent = D.getRecentMonologue(40).filter(m => m.type === 'thought' || m.type === 'reading');
  if (recent.length >= 4) D.setMeta('last_significance_monologue_id', String(recent[recent.length - 5].id - 1));
  D.setMeta('reflection_importance_accum', '200');
  console.log('firing significance reflection (router)...');
  const did = await reflection.maybeSignificanceReflect();
  console.log('fired:', did, '\n');
  console.log(`=== SELF-MODEL (identity track): ${D.countSelfModel()} entries ===`);
  for (const r of D.getAllSelfModel().slice(0, 10)) console.log(`  [${r.category}] ${(r.content || '').slice(0, 95)}`);
  const know = D.getKnowledgeBySourceSince('reflection_%', 0);
  console.log(`\n=== CAPABILITY track (reflection_knowledge / reflection_skill): ${know.length} ===`);
  for (const r of know.slice(0, 10)) console.log(`  [${r.kind}] ${(r.content || '').slice(0, 90)} ${r.links ? '(linked ' + r.links + ')' : ''}`);
  D.getDb().close();
})();
