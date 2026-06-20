// Live: real-model experience capture against the live DB. Proves the chain:
// completed action → synth procedure → stored in capability track WITH provenance →
// marker resolves back to raw data. Shares the running app's warm Ollama (8192).
const D=require('../lib/db'); D.init();
const memory=require('../lib/memory');
const experience=require('../lib/experience');
(async()=>{
  await memory.warm().catch(()=>{});
  // seed a raw reading the procedure can point at
  const rd = D.insertMonologue({ content:'I opened the Purdue OWL page and read that each sentence should carry one main idea.', model:'web-read', type:'reading', query:'purdue owl sentence clarity', urls: JSON.stringify(['https://owl.purdue.edu/owl/general_writing/mechanics/sentence_clarity.html']) });
  console.log('seeded reading row #'+rd.id+'\n');

  const r = await experience.captureActionOutcome({
    name:'email-reply',
    task:'reply to an email from a colleague',
    success:true,
    provenance: experience.marker('reading',{ refTable:'monologue', refId: rd.id, url:'https://owl.purdue.edu/owl/general_writing/mechanics/sentence_clarity.html', label:'Purdue OWL sentence clarity' })
  });
  console.log('capture result:', JSON.stringify(r));
  if (r && r.id) {
    const row = D.getKnowledgeByIds([r.id])[0];
    console.log('\nstored procedure:');
    console.log('  kind   :', row.kind, '| source:', row.source);
    console.log('  content:', (row.content||'').slice(0,140));
    const prov = row.provenance ? JSON.parse(row.provenance) : null;
    console.log('  provenance:', JSON.stringify(prov));
    if (prov && prov[0]) {
      const resolved = experience.resolveMarker(prov[0]);
      console.log('\nresolveMarker → raw source:');
      console.log('  url:', resolved.url);
      console.log('  raw row content:', resolved.raw ? resolved.raw.content.slice(0,120) : '(none)');
    }
  }
  D.getDb().close();
})();
