/**
 * DRY RUN — consolidate the REAL active threads. Writes NOTHING (apply:false).
 * Prints the umbrellas it would keep and the merges it would make, so the plan
 * can be reviewed before applying. Uses the real bge-small + Ollama classifier.
 */
const db = require('../lib/db');
const consolidate = require('../lib/consolidate');

async function run() {
  db.init();
  const before = db.getActiveOpenThreads(200).length;
  console.log(`active threads before: ${before}\nrunning dry-run (embeds + LLM ADD/NOOP decisions)…\n`);
  const plan = await consolidate.consolidateThreads({ apply: false });
  console.log(`PLAN → keep ${plan.kept.length} umbrellas, merge ${plan.merges.length} threads (would collapse ${before} → ${plan.kept.length})\n`);
  console.log('UMBRELLAS (kept):');
  for (const k of plan.kept) console.log(`  #${k.id}  ${k.content}`);
  console.log('\nMERGES (child → umbrella):');
  for (const m of plan.merges) console.log(`  #${m.childId} "${(m.childContent || '').slice(0, 60)}"  →  #${m.parentId} "${(m.parentContent || '').slice(0, 60)}"`);
  db.getDb().close();
}
run();
