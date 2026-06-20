/**
 * Phase D backtest — scored retrieval + significance-reflection gating.
 *
 * Deterministic, no model and no embedder: retrieveScored is exercised with
 * query=null (relevance drops out → ranking by recency × importance), and the
 * significance-reflection trigger is tested only on its no-model gate branches.
 * The embedding-relevance path and insight generation run live in the app.
 *
 * Run under electron-as-node.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `sq_smoke_retr_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;

const db = require('../lib/db');
const memory = require('../lib/memory');
const reflection = require('../lib/reflection');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } }

const DUMMY_EMB = JSON.stringify(new Array(8).fill(0.1)); // never parsed when query=null
// Insert a knowledge row and force its timestamps (insertKnowledge always stamps now).
function addKnowledge({ content, importance, ageHours = 0, kind = 'note' }) {
  const r = db.insertKnowledge({ kind, content, embedding: DUMMY_EMB, source: 'test', importance });
  const ts = Date.now() - ageHours * 3600000;
  db.getDb().prepare('UPDATE knowledge SET created_ts = ?, last_used_ts = ? WHERE id = ?').run(ts, ts, r.id);
  return r.id;
}

async function run() {
  db.init();
  console.log('Phase D backtest — scored retrieval + significance gating\n');

  // --- _normalize ---
  console.log('_normalize (min-max → [0,1], zero-range → 0.5):');
  const n1 = memory._normalize(new Map([['a', 1], ['b', 3], ['c', 5]]));
  ok('min→0, mid→0.5, max→1', n1.get('a') === 0 && n1.get('b') === 0.5 && n1.get('c') === 1);
  const n2 = memory._normalize(new Map([['a', 7]]));
  ok('single value → 0.5', n2.get('a') === 0.5);
  const n3 = memory._normalize(new Map([['a', 4], ['b', 4]]));
  ok('all-equal (zero range) → 0.5', n3.get('a') === 0.5 && n3.get('b') === 0.5);

  // --- scored retrieval (query=null → recency × importance) ---
  console.log('\nretrieveScored ranking (query=null):');
  const recentHigh = addKnowledge({ content: 'recent and important insight', importance: 0.9, ageHours: 0 });
  const staleLow = addKnowledge({ content: 'old and trivial note', importance: 0.2, ageHours: 200 });
  const midMid = addKnowledge({ content: 'a middling middle-aged note', importance: 0.5, ageHours: 50 });

  const top = await memory.retrieveScored(null, { k: 3 });
  ok('returns all 3 candidates', top.length === 3);
  ok('recent+important ranks first', top[0].id === recentHigh);
  ok('stale+trivial ranks last', top[2].id === staleLow);
  const top1 = await memory.retrieveScored(null, { k: 1 });
  ok('k=1 returns only the top', top1.length === 1 && top1[0].id === recentHigh);

  // --- importance 1..10 normalization path ---
  console.log('\n1–10 importance normalized onto 0..1 axis:');
  db.getDb().prepare('DELETE FROM knowledge').run();
  const big = addKnowledge({ content: 'poignancy-scaled note (8/10)', importance: 8, ageHours: 0 });   // >1 → /10
  const small = addKnowledge({ content: 'poignancy-scaled note (2/10)', importance: 2, ageHours: 0 }); // >1 → /10
  const order = await memory.retrieveScored(null, { k: 2 });
  ok('importance 8 outranks importance 2 at equal recency', order[0].id === big && order[1].id === small);

  // --- kinds filter ---
  console.log('\nkinds filter:');
  db.getDb().prepare('DELETE FROM knowledge').run();
  addKnowledge({ content: 'a note', importance: 0.5, kind: 'note' });
  const traj = addKnowledge({ content: 'a trajectory', importance: 0.5, kind: 'trajectory' });
  const onlyTraj = await memory.retrieveScored(null, { k: 5, kinds: ['trajectory'] });
  ok('only requested kind returned', onlyTraj.length === 1 && onlyTraj[0].id === traj);

  // --- empty store ---
  db.getDb().prepare('DELETE FROM knowledge').run();
  ok('empty store → []', (await memory.retrieveScored(null, { k: 4 })).length === 0);

  // --- significance trigger gating (no-model branches only) ---
  console.log('\nsignificance-reflection gating:');
  db.setMeta('reflection_importance_accum', '0');
  ok('below threshold → no reflection', (await reflection.maybeSignificanceReflect()) === false);

  // threshold tripped but too little fresh material → decays accumulator, no model call
  db.setMeta('reflection_importance_accum', String(reflection.SIGNIFICANCE_THRESHOLD + 20));
  db.setMeta('last_significance_monologue_id', '0');
  db.insertMonologue({ content: 'one lonely thought', type: 'thought', importance: 5 });
  const before = parseInt(db.getMeta('reflection_importance_accum'), 10);
  const did = await reflection.maybeSignificanceReflect();
  const after = parseInt(db.getMeta('reflection_importance_accum'), 10);
  ok('tripped but < MIN_ITEMS → no reflection', did === false);
  ok('accumulator decayed (not stuck tripped)', after < before && after === Math.floor(before / 2));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}

run();
