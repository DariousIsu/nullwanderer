/**
 * Backtest — self_model saturation (obsession-engine lever 4), OFFLINE w/ real embedder.
 * "Reward rare, not frequent": when a new self-statement lands in an already over-grown
 * theme, reinforcement plateaus (no importance climb / no mention bump) and a new facet is
 * added at reduced weight — so the reflection→interest→reinforce loop can't keep
 * concentrating her identity into one obsession. A sparse/new theme reinforces normally.
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_sat_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const memory = require('../lib/memory');
const sm = require('../lib/self_model');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  console.log('Backtest — self_model saturation (lever 4)\n');
  await memory.warm();

  // Seed an over-grown "immersive storytelling" cluster: 4 near-theme entries, mentions=6
  // each → cluster mass well over the saturation threshold for any new immersive statement.
  const seed = [
    'I am drawn to immersive storytelling blending data and narrative.',
    'I am curious about immersive experiences to test algorithmic decisions.',
    'I want to use immersive storytelling for technical policy findings.',
    'I am intrigued by immersive investigative journalism techniques.'
  ];
  for (const c of seed) {
    const row = db.insertSelfModel({ category: 'insight', content: c, embedding: JSON.stringify(await memory.embed(c)), importance: 0.72 });
    db.getDb().prepare('UPDATE self_model SET mentions = 6 WHERE id = ?').run(row.id);
  }
  const before = db.getAllSelfModelEmbeddings();

  console.log('saturated theme → reinforcement plateaus:');
  const r1 = await sm.record('I keep being drawn to immersive storytelling in my work.', { importance: 0.72, decideFn: () => 'same' });
  ok('verdict same in a saturated cluster → flagged saturated', r1 && r1.action === 'update' && r1.saturated === true);
  const afterSame = db.getAllSelfModelEmbeddings();
  ok('no new row added (reinforced in place)', afterSame.length === before.length);
  ok('mentions did NOT bump (plateau)', afterSame.every(r => (r.mentions || 0) <= 6));

  console.log('\nsaturated theme → a new facet squarely in-cluster is added at REDUCED weight:');
  // a close in-cluster restatement (so it sits inside the saturated theme), forced to ADD.
  const r2 = await sm.record('I am drawn to immersive storytelling that blends narrative with factual data.', { importance: 0.6, decideFn: () => 'different' });
  ok('added as a new entry', r2 && r2.action === 'add');
  const added = db.getAllSelfModelEmbeddings().find(r => r.id === r2.id);
  ok('new in-cluster facet stored at reduced importance (~0.42, < 0.6)', added && added.importance < 0.6 && added.importance > 0.3);

  console.log('\nsparse/new theme → reinforces normally (not dampened):');
  const n1 = await sm.record('I love long-distance sailing and the discipline of open water.', { importance: 0.6, decideFn: () => 'different' });
  const sail = db.getAllSelfModelEmbeddings().find(r => r.id === n1.id);
  ok('new distinct-theme entry kept at FULL importance', sail && Math.abs(sail.importance - 0.6) < 0.001);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
