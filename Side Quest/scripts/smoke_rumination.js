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

// UPDATED 2026-08-12 (wave-3 triage): under the DEFAULT contract (S3 autonomic demotion) escalate →
// setFromText returns null, and this suite CRASHED on focus.getCurrent().content (the null focus).
// The escalation mechanics it proves exist only on the legacy path — pinned under the kill switch,
// same treatment as smoke_curator / smoke_rumination_breaker.
process.env.ZOE_AUTONOMIC = '0';

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } }
function reset() {
  db.getDb().prepare('DELETE FROM agent_events').run();
  db.getDb().prepare('DELETE FROM open_threads').run();
  db.getDb().prepare('DELETE FROM knowledge').run();
  db.setMeta('current_focus_id', ''); db.setMeta('focus_state', '');
  db.setMeta('rumination_last_id', '');
  db.setMeta('rumination_cooldown_until', '');
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

  // --- S3 DEFAULT contract (D1, 2026-08-14): escalate → OPEN-THREAD queue, never the dead focus door ---
  // Under autonomic demotion setFromText is null by design; the unswept consumer meant every spiral
  // named a theme and self-suppressed. Now the theme joins the driver's worklist via intent-dedup.
  console.log('\nS3 default: escalate queues a thread for the driver:');
  process.env.ZOE_AUTONOMIC = '1';
  reset();
  for (let i = 0; i < 4; i++) addThought('A: circling the same open question');
  const q1 = await rumination.escalate(rumination.recentFreeThoughts(4), 'Lucas', { nameFn: async () => 'answer the open question about Google tools' });
  ok('S3: escalate returns queued + threadId (no focus)', !!q1 && q1.queued === true && Number.isFinite(q1.threadId) && !q1.focus);
  ok('S3: no focus was activated', focus.isActive() === false);
  const thr = db.getDb().prepare('SELECT * FROM open_threads WHERE id=?').get(q1.threadId);
  ok('S3: the open thread holds the named theme', !!thr && thr.content === 'answer the open question about Google tools');
  ok('S3: cooldown armed (no per-thought re-naming burn)', parseInt(db.getMeta('rumination_cooldown_until') || '0', 10) > Date.now());

  const q2 = await rumination.escalate(rumination.recentFreeThoughts(4), 'Lucas', { nameFn: async () => 'answer the open question about Google tools' });
  const nThreads = db.getDb().prepare('SELECT COUNT(*) AS n FROM open_threads').get().n;
  ok('S3: an intent-duplicate theme does NOT re-mint (dedup NOOP → null)', q2 === null && nThreads === 1);
  process.env.ZOE_AUTONOMIC = '0';   // leave the suite's legacy pin as it found it

  // ── THE GRADIENT (IIT differentiation-trend, W5 standalone 2026-08-20) ────────────────────────
  // The decision runs on the TRAJECTORY, not one hot reading — the observed 0.899→0.928 climb is
  // the canonical fire; a spike amid recovery no longer false-trips.
  console.log('gradient:');
  const gd = (avgs, opts) => rumination.gradientDecide(avgs.map((avg) => ({ avg })), opts);
  ok('the LIVE pathology (0.899→0.912→0.928, climbing) → CIRCLING', gd([0.899, 0.912, 0.928]).ruminating === true);
  ok('flat-high (0.82, 0.82, 0.82) → CIRCLING (pinned similarity is collapse held in place)', gd([0.82, 0.82, 0.82]).ruminating === true);
  ok('RECOVERING through the old cliff (0.9→0.84→0.81) → NOT circling (the smoothing: no false trip amid recovery)', gd([0.9, 0.84, 0.81]).ruminating === false);
  ok('extreme lock-in fires regardless of trend; sub-extreme recovery does not (0.7→0.95→0.85 no, 0.7→0.85→0.95 yes)', gd([0.7, 0.95, 0.85]).ruminating === false && gd([0.7, 0.85, 0.95]).ruminating === true);
  ok('rising but still low (0.5→0.6→0.7) → NOT circling (below the floor)', gd([0.5, 0.6, 0.7]).ruminating === false);
  ok('a tiny dip within ε still counts as non-decreasing (0.80→0.795→0.82) → CIRCLING', gd([0.80, 0.795, 0.82]).ruminating === true);
  ok('fewer than 3 readings → the OLD instantaneous rule (0.85 fires)', gd([0.85]).ruminating === true && gd([0.7]).ruminating === false);
  ok('empty series → not circling, no throw', gd([]).ruminating === false);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}

run();
