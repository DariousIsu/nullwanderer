/* Smoke: the unbounded-goal guard. (1) isUnboundedGoal flags open-ended goals, passes bounded
 * ones. (2) curateThreads retires over-pursued threads (action_count > cap) regardless of age,
 * while leaving healthy recent ones alone. Deterministic, isolated temp DB.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_goal_guard.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_goalguard_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const openThreads = require('C:/Users/azrae/Desktop/Side Quest/lib/open_threads');
const curator = require('C:/Users/azrae/Desktop/Side Quest/lib/curator');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

try {
  db.init();
  const U = openThreads.isUnboundedGoal;
  console.log('isUnboundedGoal — rejects open-ended goals:');
  ok(U('learn everything about federal permitting reform'), 'flags "learn everything about…"');
  ok(U('keep researching local news on suppression'), 'flags "keep researching…"');
  ok(U('stay updated on AI regulation'), 'flags "stay updated on…"');
  ok(U('deepen my understanding of the permitting bill'), 'flags "deepen my understanding…"');
  ok(U('become an expert on Salesforce APIs'), 'flags "become an expert…"');
  console.log('isUnboundedGoal — passes bounded goals:');
  ok(!U('draft a one-page brief on the permitting bill'), 'passes "draft a brief…"');
  ok(!U('summarize the Salesforce meeting from yesterday'), 'passes "summarize…"');
  ok(!U('remind Lucas to call his father'), 'passes a concrete task');

  console.log('\ncurateThreads — retires over-pursued threads, keeps healthy ones:');
  const set = (id, status, actions) => db.getDb().prepare('UPDATE open_threads SET status=?, action_count=?, last_touched_ts=? WHERE id=?').run(status, actions, Date.now(), id);
  const runawayId = db.insertOpenThread({ content: 'a goal pursued forever', sourceTurnId: null }).id; set(runawayId, 'active', 100);
  const healthyId = db.insertOpenThread({ content: 'a converging goal', sourceTurnId: null }).id; set(healthyId, 'active', 5);
  const freshId = db.insertOpenThread({ content: 'a brand new goal', sourceTurnId: null }).id; set(freshId, 'active', 0);

  curator.curateThreads();
  const status = (id) => db.getDb().prepare('SELECT status FROM open_threads WHERE id=?').get(id).status;
  ok(status(runawayId) === 'abandoned', 'over-pursued thread (100 actions) → abandoned');
  ok(status(healthyId) === 'active', 'healthy thread (5 actions, recent) stays active');
  ok(status(freshId) === 'active', 'fresh thread (0 actions, recent) stays active');
} catch (e) {
  fail++; console.error('  ✗ threw:', e.stack || e.message);
} finally {
  try { db.getDb().close(); } catch {}
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
