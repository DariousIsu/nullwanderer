/**
 * Backtest — rumination guard (semantic-loop detection → auto-escalate to focus).
 * Deterministic, offline: stub embedder (one-hot by leading letter → exact cosine)
 * and stub theme-namer. Proves detection, the focus-active suppression, the
 * free-thought filter, escalation into a focus, and spawn-gate suppression.
 *
 * Run under electron-as-node.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `sq_smoke_rum_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;

const db = require('../lib/db');
const blackboard = require('../lib/blackboard');
const focus = require('../lib/focus');
const rumination = require('../lib/rumination');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } }
function reset() {
  db.getDb().prepare('DELETE FROM agent_events').run();
  db.getDb().prepare('DELETE FROM open_threads').run();
  db.getDb().prepare('DELETE FROM knowledge').run();
  db.setMeta('current_focus_id', ''); db.setMeta('focus_state', '');
  db.setMeta('rumination_last_id', '');
}
async function stubEmbed(text) {
  const c = (text || '').trim()[0]?.toUpperCase();
  return { A: [1, 0, 0, 0], B: [0, 1, 0, 0], C: [0, 0, 1, 0], D: [0, 0, 0, 1] }[c] || [0, 0, 0, 1];
}
function addThought(content, focusId = null) { return blackboard.append({ source: 'monologue', kind: 'thought', focusId, content }); }

async function run() {
  db.init();
  console.log('Backtest — rumination guard\n');

  // --- detection ---
  console.log('detect:');
  reset();
  addThought('A: I avoided the question'); addThought('A: I keep avoiding it'); addThought('A: I should stop avoiding');
  ok('fewer than K thoughts → not ruminating', (await rumination.detect({ embedFn: stubEmbed })).ruminating === false);
  addThought('A: I really must answer it');
  const r = await rumination.detect({ embedFn: stubEmbed });
  ok('K tight-clustered thoughts → RUMINATING', r.ruminating === true && r.avg >= 0.8);

  reset();
  addThought('A: topic one'); addThought('B: topic two'); addThought('C: topic three'); addThought('D: topic four');
  ok('K distinct thoughts → not ruminating', (await rumination.detect({ embedFn: stubEmbed })).ruminating === false);

  // --- never during an active focus ---
  console.log('\nfocus-active suppression:');
  reset();
  for (let i = 0; i < 5; i++) addThought('A: circling thought');
  const f = db.insertOpenThread({ content: 'an active focus' }); focus.setCurrent(f.id);
  ok('does NOT fire while a focus is active', (await rumination.detect({ embedFn: stubEmbed })).reason === 'focus-active');

  // --- free-thought filter (focus-tagged thoughts ignored) ---
  console.log('\nfree-thought filter:');
  reset();
  for (let i = 0; i < 5; i++) addThought('A: focus-scoped circling', 999); // all tied to a focus
  ok('focus-tagged thoughts are not counted', (await rumination.detect({ embedFn: stubEmbed })).reason === 'too-few');

  // --- escalation into a focus ---
  console.log('\nescalate → focus:');
  reset();
  for (let i = 0; i < 4; i++) addThought('A: circling the same preoccupation');
  const thoughts = rumination.recentFreeThoughts(4);
  const set = await rumination.escalate(thoughts, 'Lucas', { nameFn: async () => 'answer the open question about Google tools' });
  ok('escalate creates + activates a focus', !!set && focus.isActive());
  ok('focus content = named theme', focus.getCurrent().content === 'answer the open question about Google tools');

  // --- escalation respects the spawn gate (recently tombstoned) ---
  console.log('\nescalate respects spawn-gate:');
  reset();
  db.insertKnowledge({ kind: 'note', content: 'Focus "answer the open question about Google tools" → stalled: x', embedding: null, source: 'focus_tombstone', importance: 0.5 });
  for (let i = 0; i < 4; i++) addThought('A: circling again');
  const set2 = await rumination.escalate(rumination.recentFreeThoughts(4), 'Lucas', { nameFn: async () => 'answer the open question about Google tools' });
  ok('suppressed when theme matches a recent tombstone', set2 === null && focus.isActive() === false);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}

run();
