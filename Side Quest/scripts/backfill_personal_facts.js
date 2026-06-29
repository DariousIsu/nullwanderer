/* One-time backfill — seed the durable family facts Lucas already stated in chat history
 * (turns #3271/#3274/#3478/#3484) into retrievable knowledge (source 'personal_fact'), so
 * she knows Alice / Raegan immediately rather than waiting to re-learn them. Idempotent via
 * memory.storeDeduped. Run AFTER backing up data/sq.db.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/backfill_personal_facts.js
 */
require('../lib/db').init();
const memory = require('../lib/memory');

const FACTS = [
  "Lucas's youngest daughter is Alice — she is 12 (almost 13) and is in her first year of elite competitive cheerleading at Level 1 Elite; they recently started proper sports strength training.",
  "Lucas's oldest child is Raegan, who also goes by Jay — they are 16 (almost 17) and are exploring filmmaking.",
  "Lucas has two children: Alice (youngest, ~12) and Raegan/Jay (oldest, ~16).",
  "Lucas has played and coached many sports and athletes, but never cheerleading — he wants to learn it to support his daughter Alice."
];

(async () => {
  await memory.warm().catch(() => {});
  let added = 0, deduped = 0;
  for (const f of FACTS) {
    try {
      const r = await memory.storeDeduped({ kind: 'reference', content: f, source: 'personal_fact', importance: 0.9 });
      if (r && (r.action === 'add' || r.id)) { added++; console.log(`  + ${f.slice(0, 70)}`); }
      else { deduped++; console.log(`  = (deduped) ${f.slice(0, 60)}`); }
    } catch (e) { console.error('  ! store failed:', e.message); }
  }
  console.log(`\nbackfill done — ${added} added, ${deduped} deduped`);
  // Verify retrievability of the headline fact.
  try {
    const hit = await memory.retrieve("what is my youngest daughter's name", { k: 3 });
    const got = (hit || []).find(r => /alice/i.test(r.content || ''));
    console.log(got ? `VERIFY ok → "${got.content.slice(0, 80)}"` : 'VERIFY: Alice not retrieved (check)');
  } catch (e) { console.error('VERIFY failed:', e.message); }
  process.exit(0);
})();
