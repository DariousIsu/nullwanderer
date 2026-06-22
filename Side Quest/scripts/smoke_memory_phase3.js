/**
 * Backtest — Memory Phase 3 (hierarchy + Mem0 merge + leaf-preference), OFFLINE.
 * Uses the real CPU embedder (like smoke_consolidate) for similarity, but injects the
 * relate/merge decisions so no chat model is needed and the outcomes are deterministic.
 * Proves: level/parent_id schema + helpers, parent assignment on ADD, UPDATE-in-place
 * (augment) vs NOOP (same) vs ADD (distinct), and leaf-first retrieval with walk-up.
 */
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_mem3_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const memory = require('../lib/memory');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  console.log('Backtest — Memory Phase 3 (offline)\n');
  await memory.warm();

  console.log('db layer (level/parent_id + updateKnowledge):');
  const k = await memory.store({ content: 'A standalone fact about tides.', level: 'fact' });
  const got = db.getKnowledgeByIds([k.id])[0];
  ok('insertKnowledge defaults level=fact', got.level === 'fact' && got.parent_id == null);
  db.updateKnowledge(k.id, { content: 'A merged fact about tides and currents.' });
  ok('updateKnowledge rewrites content', db.getKnowledgeByIds([k.id])[0].content === 'A merged fact about tides and currents.');
  ok('FTS reflects the rewrite (old term gone, new term found)',
    db.ftsSearchKnowledge('currents', 5).some(r => r.id === k.id) && !db.ftsSearchKnowledge('standalone', 5).some(r => r.id === k.id));

  console.log('\nparent assignment on ADD (fact lands under nearest topic):');
  const topic = await memory.store({ content: 'Substack publishing workflow overview and steps.', level: 'topic' });
  const added = await memory.storeDeduped({ content: 'Substack publishing workflow overview and the steps involved.', relateFn: async () => 'distinct' });
  ok('a distinct near-neighbor still ADDs (not merged)', added.action === 'add');
  ok('the new fact is parented to the topic', added.parentId === topic.id && db.getKnowledgeByIds([added.id])[0].level === 'fact');

  console.log('\nMem0 decision (same → noop, augment → update-in-place):');
  const base = await memory.store({ content: 'The Maastricht Treaty set EU convergence criteria in 1992.' });
  const before = db.countKnowledge();
  const noop = await memory.storeDeduped({ content: 'In 1992 the Maastricht Treaty established the EU convergence criteria.', relateFn: async () => 'same' });
  ok('same → NOOP (no new row, points at existing)', noop.action === 'noop' && noop.id === base.id && db.countKnowledge() === before);
  const merged = await memory.storeDeduped({
    content: 'The Maastricht Treaty (1992) set convergence criteria including a 60% debt-to-GDP ceiling.',
    relateFn: async () => 'augment',
    mergeFn: async () => 'The Maastricht Treaty (1992) set EU convergence criteria, including a 60% debt-to-GDP ceiling.'
  });
  ok('augment → UPDATE existing in place (no new row)', merged.action === 'update' && merged.id === base.id && db.countKnowledge() === before);
  ok('merged content written to the existing note', /60% debt-to-GDP/.test(db.getKnowledgeByIds([base.id])[0].content));

  console.log('\ndistinct → genuine ADD:');
  const beforeD = db.countKnowledge();
  const distinct = await memory.storeDeduped({ content: 'Sea otters wrap themselves in kelp to avoid drifting while they sleep.', relateFn: async () => 'distinct' });
  ok('distinct fact ADDs a new row', distinct.action === 'add' && db.countKnowledge() === beforeD + 1);

  console.log('\nleaf-preference retrieval (narrow → leaf first, topic walk-up behind):');
  // a topic + two specific leaves on the same subject
  const tParent = await memory.store({ content: 'Overview: how the byline publishing pipeline works end to end.', level: 'topic' });
  await memory.store({ content: 'Byline pipeline: the research stage gathers sources before any drafting begins.', level: 'fact', parentId: tParent.id });
  await memory.store({ content: 'Byline pipeline: the publish stage pastes the local draft into Substack and clicks Publish now.', level: 'fact', parentId: tParent.id });
  const leafFirst = await memory.retrieve('what does the publish stage of the byline pipeline do', { k: 3, preferLeaf: true });
  ok('returns results', leafFirst.length > 0);
  const firstTopicIdx = leafFirst.findIndex(r => r.level === 'topic');
  const lastLeafIdx = leafFirst.map(r => r.level).lastIndexOf('fact');
  ok('no topic appears before a leaf (leaf-first ordering)', firstTopicIdx === -1 || firstTopicIdx > lastLeafIdx);
  ok('a specific leaf is the top hit', leafFirst[0].level !== 'topic');

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
