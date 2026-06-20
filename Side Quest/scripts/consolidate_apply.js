/**
 * APPLY consolidation to the REAL active threads (apply:true). Reversible: each
 * merged child is kept, marked 'abandoned', linked to its umbrella via parent_id,
 * with a merged_into note and its weight transferred. Prints before/after.
 */
const db = require('../lib/db');
const consolidate = require('../lib/consolidate');

async function run() {
  db.init();
  const before = db.getActiveOpenThreads(200).length;
  console.log(`active before: ${before}\napplying consolidation…\n`);
  const res = await consolidate.consolidateThreads({ apply: true });
  const after = db.getActiveOpenThreads(200).length;
  console.log(`MERGED ${res.merges.length} threads.`);
  for (const m of res.merges) console.log(`  #${m.childId} → #${m.parentId}`);
  console.log(`\nactive after: ${after} (was ${before})`);
  console.log('\nremaining active umbrellas:');
  for (const t of db.getActiveOpenThreads(200)) console.log(`  #${t.id} [a:${t.action_count} m:${t.mention_count}] ${(t.content || '').slice(0, 70)}`);
  db.getDb().close();
}
run();
