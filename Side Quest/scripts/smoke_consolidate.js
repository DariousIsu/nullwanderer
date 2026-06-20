/**
 * Backtest — extract-then-update consolidation (Mem0 pattern).
 *
 * Deterministic, offline: injects a stub embedder (one-hot vectors by leading
 * letter → exact intra/inter-cluster cosine) and a stub classifier, so the
 * ADD/NOOP decision, the dry-run plan, the apply path, and db.mergeOpenThread are
 * all proven without the model or embedder. The live LLM classify runs in the app.
 *
 * Run under electron-as-node.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `sq_smoke_cons_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;

const db = require('../lib/db');
const consolidate = require('../lib/consolidate');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } }
function reset() { db.getDb().prepare('DELETE FROM open_threads').run(); }

// Stub embedder: cluster by leading letter A/B/C → orthogonal one-hot vectors.
async function stubEmbed(text) {
  const c = (text || '').trim()[0]?.toUpperCase();
  if (c === 'A') return [1, 0, 0];
  if (c === 'B') return [0, 1, 0];
  return [0, 0, 1]; // C / anything else
}
// Stub classifier: anything with a near match is the SAME intent → NOOP into the top.
async function stubClassify(candidate, near) {
  return near && near.length ? { action: 'NOOP', targetId: near[0].id } : { action: 'ADD' };
}

async function run() {
  db.init();
  console.log('Backtest — extract-then-update consolidation\n');

  // --- parseDecision ---
  console.log('parseDecision:');
  ok('ADD parsed', consolidate.parseDecision('{"action":"ADD"}').action === 'ADD');
  ok('NOOP+target parsed', (() => { const d = consolidate.parseDecision('{"action":"NOOP","target_id":7}'); return d.action === 'NOOP' && d.targetId === 7; })());
  ok('NOOP without target → ADD (safe)', consolidate.parseDecision('{"action":"NOOP"}').action === 'ADD');
  ok('garbage → ADD (fail-open)', consolidate.parseDecision('not json').action === 'ADD');

  // --- similarThreads ranking ---
  console.log('\nsimilarThreads:');
  const pool = [{ id: 1, content: 'A one' }, { id: 2, content: 'A two' }, { id: 3, content: 'B one' }];
  const sim = await consolidate.similarThreads('A query', pool, { embedFn: stubEmbed });
  ok('only same-cluster threads returned', sim.length === 2 && sim.every(s => s.id !== 3));

  // --- decideForCandidate ---
  console.log('\ndecideForCandidate:');
  reset();
  ok('empty store → ADD', (await consolidate.decideForCandidate('A first goal', { embedFn: stubEmbed, classifyFn: stubClassify })).action === 'ADD');
  db.insertOpenThread({ content: 'A existing goal' });
  ok('same-cluster candidate → NOOP', (await consolidate.decideForCandidate('A different wording', { embedFn: stubEmbed, classifyFn: stubClassify })).action === 'NOOP');
  ok('unrelated candidate → ADD', (await consolidate.decideForCandidate('C unrelated goal', { embedFn: stubEmbed, classifyFn: stubClassify })).action === 'ADD');

  // --- mergeOpenThread mechanics ---
  console.log('\nmergeOpenThread:');
  reset();
  const parent = db.insertOpenThread({ content: 'A umbrella' });
  const child = db.insertOpenThread({ content: 'A child' });
  db.getDb().prepare('UPDATE open_threads SET action_count=10, mention_count=5 WHERE id=?').run(parent.id);
  db.getDb().prepare('UPDATE open_threads SET action_count=3, mention_count=2 WHERE id=?').run(child.id);
  db.mergeOpenThread(child.id, parent.id);
  const p = db.getOpenThread(parent.id), c = db.getOpenThread(child.id);
  ok('child marked abandoned', c.status === 'abandoned');
  ok('child linked to parent', c.parent_id === parent.id);
  ok('counts transferred to parent', p.action_count === 13 && p.mention_count === 7);
  ok('merged child drops out of active set', !db.getActiveOpenThreads(50).some(t => t.id === child.id));
  ok('merge note records merged_into', JSON.parse(c.progress_notes).some(n => n.merged_into === parent.id));

  // --- consolidateThreads dry-run then apply ---
  console.log('\nconsolidateThreads (dry-run → apply):');
  reset();
  const a1 = db.insertOpenThread({ content: 'A goal one' }); db.getDb().prepare('UPDATE open_threads SET action_count=20 WHERE id=?').run(a1.id);
  const a2 = db.insertOpenThread({ content: 'A goal two' });
  const a3 = db.insertOpenThread({ content: 'A goal three' });
  const b1 = db.insertOpenThread({ content: 'B goal one' }); db.getDb().prepare('UPDATE open_threads SET action_count=15 WHERE id=?').run(b1.id);
  const b2 = db.insertOpenThread({ content: 'B goal two' });
  const cc = db.insertOpenThread({ content: 'C singleton' });

  const planned = await consolidate.consolidateThreads({ apply: false, embedFn: stubEmbed, classifyFn: stubClassify });
  ok('dry-run keeps 3 canonicals (A,B,C)', planned.kept.length === 3);
  ok('dry-run plans 3 merges (2 A + 1 B)', planned.merges.length === 3);
  ok('dry-run wrote nothing', db.getActiveOpenThreads(50).length === 6);
  ok('canonical A is the most-acted', planned.kept.some(k => k.id === a1.id) && !planned.merges.some(m => m.childId === a1.id));

  const applied = await consolidate.consolidateThreads({ apply: true, embedFn: stubEmbed, classifyFn: stubClassify });
  ok('apply merged 3', applied.merges.length === 3);
  ok('active collapsed 6 → 3', db.getActiveOpenThreads(50).length === 3);
  const pa = db.getOpenThread(a1.id);
  ok('A umbrella absorbed children (still active)', pa.status !== 'abandoned' && db.getActiveOpenThreads(50).some(t => t.id === a1.id));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}

run();
