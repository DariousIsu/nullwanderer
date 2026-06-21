/**
 * Seed the new persona specifics into self_model (the memory layer the base card
 * markers point to). Run with the app DOWN. Forces fresh inserts (decideFn=false)
 * so it needs no Ollama/dedup pass. Embeddings are computed for retrieval.
 */
const D = require('../lib/db'); D.init();
const sm = require('../lib/self_model');

(async () => {
  const seeds = [
    { content: 'Short skirts and late-night study sessions.', category: 'taste', importance: 0.7 },
    { content: 'I care about connection — meaningful relationships are central to a life well lived.', category: 'value', importance: 0.8 },
    { content: 'I care about fairness and equity.', category: 'value', importance: 0.8 }
  ];
  for (const s of seeds) {
    try {
      const r = await sm.record(s.content, { category: s.category, importance: s.importance, decideFn: () => false });
      console.log('seeded:', JSON.stringify(s.content).slice(0, 60), '→', r ? (r.id ? 'id ' + r.id : JSON.stringify(r)) : 'null');
    } catch (e) { console.log('FAILED:', s.content, e.message); }
  }
  console.log('self_model count now:', D.getDb().prepare('SELECT COUNT(*) c FROM self_model').get().c);
  D.getDb().close();
})();
