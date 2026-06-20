/**
 * READ-ONLY: list active open_threads and cluster them by semantic similarity
 * (live bge-small) to see how much is near-duplicate. Makes NO writes — a dry run
 * to validate the "unifier" idea against real data before building it.
 */
const db = require('../lib/db');
const memory = require('../lib/memory');

const THRESHOLD = parseFloat(process.env.SIM || '0.84');

async function run() {
  db.init();
  const threads = db.getActiveOpenThreads(200);
  console.log(`active open_threads: ${threads.length} (clustering at cosine ≥ ${THRESHOLD})\n`);
  console.log('--- ALL ACTIVE THREADS ---');
  for (const t of threads) console.log(`  #${t.id} [${t.status} a:${t.action_count} m:${t.mention_count}] ${(t.content || '').replace(/\s+/g, ' ').slice(0, 100)}`);
  console.log('--- END LIST ---');

  // embed each
  const vecs = [];
  for (const t of threads) {
    let v = null;
    try { v = await memory.embed(t.content); } catch (e) { /* leave null */ }
    vecs.push(v);
  }

  // greedy clustering
  const clusters = []; // { repIdx, members:[idx] }
  for (let i = 0; i < threads.length; i++) {
    if (!vecs[i]) { clusters.push({ repIdx: i, members: [i] }); continue; }
    let placed = false;
    for (const c of clusters) {
      if (!vecs[c.repIdx]) continue;
      if (memory.cosine(vecs[i], vecs[c.repIdx]) >= THRESHOLD) { c.members.push(i); placed = true; break; }
    }
    if (!placed) clusters.push({ repIdx: i, members: [i] });
  }

  clusters.sort((a, b) => b.members.length - a.members.length);
  let dupes = 0;
  for (const c of clusters) {
    if (c.members.length > 1) {
      dupes += c.members.length - 1;
      console.log(`\n● CLUSTER (${c.members.length}):`);
      for (const idx of c.members) {
        const t = threads[idx];
        console.log(`    #${t.id} [${t.status} a:${t.action_count} m:${t.mention_count}] ${(t.content || '').replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }
  const singles = clusters.filter(c => c.members.length === 1).length;
  console.log(`\n— ${clusters.length} clusters from ${threads.length} threads; ${dupes} would be merged away; ${singles} unique singletons —`);
  db.getDb().close();
}
run();
