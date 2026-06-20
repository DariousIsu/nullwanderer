/**
 * LIVE smoke against the REAL data/sq.db (no SQ_DB_PATH override).
 *
 * Run with the app CLOSED. It (1) applies the new A–F migrations to the real
 * database and verifies they took, (2) confirms existing data is intact, and
 * (3) probes the now-free model for the live importance-scoring path. READ-ONLY
 * apart from the idempotent additive migrations — never deletes or mutates rows.
 */

const db = require('../lib/db');

async function run() {
  db.init(); // applies additive migrations to the real DB (idempotent)
  console.log('LIVE smoke — real data/sq.db\n');

  const cols = db.getDb().prepare('PRAGMA table_info(monologue)').all().map(c => c.name);
  const tbls = db.getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(t => t.name);
  console.log('schema migrations applied to real DB:');
  console.log('  monologue.importance column :', cols.includes('importance'));
  console.log('  agent_events table          :', tbls.includes('agent_events'));
  console.log('  capability_gaps table       :', tbls.includes('capability_gaps'));

  const turns = db.getDb().prepare('SELECT COUNT(*) n FROM turns').get().n;
  const mono = db.getDb().prepare('SELECT COUNT(*) n FROM monologue').get().n;
  const threads = db.getDb().prepare('SELECT COUNT(*) n FROM open_threads').get().n;
  const know = db.countKnowledge();
  console.log(`\nexisting data intact — turns:${turns} monologue:${mono} open_threads:${threads} knowledge:${know}`);

  console.log('\nlive model probe:');
  try {
    const r = await fetch('http://localhost:11434/api/tags');
    console.log('  ollama reachable:', r.ok);
    if (r.ok) {
      const imp = require('../lib/importance');
      const t1 = await imp.score('I noticed the cursor blink while I waited.', { kind: 'thought' });
      const t2 = await imp.score('Lucas hesitates on email autonomy because he fears I will misjudge tone with someone important — I should propose a review step.', { kind: 'thought' });
      console.log(`  importance scoring — trivial:${t1}  significant:${t2}  discriminates:${t2 > t1}`);
    }
  } catch (e) { console.log('  ollama probe failed:', e.message); }

  db.getDb().close();
}
run();
