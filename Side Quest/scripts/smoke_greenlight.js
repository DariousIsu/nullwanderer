/* Smoke: the PENDING-THREAD GREENLIGHT steering fix. A bare "Begin." / "yes do it" / "yes please I
 * need that list" that greenlights a task Lucas already red-tagged (a pending open_thread from one of
 * HIS turns) must resolve to that thread so the standing-focus block spins up a directed run — instead
 * of the request sitting while the heartbeat "answers" it as an unprompted musing. Covers the detectors
 * (brainstorm.isStartCommand + the composite greenlight) and db.pendingUserAssignedThread. Isolated temp
 * DB via SQ_DB_PATH. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_greenlight.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_greenlight_${process.pid}.db`);
process.env.SQ_DB_PATH = tmp;   // MUST precede requiring db (DB_PATH is read at require time)
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const brain = require('C:/Users/azrae/Desktop/Side Quest/lib/brainstorm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// mirrors the composite greenlight in main.js
const greenlight = (m) => brain.isAffirmation(m) || brain.isStartCommand(m)
  || (/^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please|absolutely|definitely|go|do)\b/i.test(m)
      && /\b(list|roster|everyone|every ?one|all (?:of )?(?:them|the)|contacts?|directory|names?)\b/i.test(m));

try {
  console.log('start-command + greenlight detectors:');
  for (const s of ['Begin.', 'begin', 'go ahead', 'do it', 'proceed', 'kick it off', "let's go", 'get started', 'spin it up', 'go for it']) {
    ok(brain.isStartCommand(s), `isStartCommand: "${s}"`);
  }
  for (const s of ['starting tomorrow we ship the whole thing', 'I do not want to start a fight', 'the beginning of the war']) {
    ok(!brain.isStartCommand(s), `isStartCommand rejects: "${s}"`);
  }
  ok(greenlight('Begin.'), 'greenlight: "Begin."');
  ok(greenlight('Yes please I need a list of everyone from all 38 Parishes'), 'greenlight: yes-please-need-a-list');
  ok(greenlight('yes go ahead'), 'greenlight: yes go ahead');
  ok(!greenlight('what about the arms race in the pacific'), 'greenlight rejects a fresh topic question');
  ok(!greenlight('yes the arms race is wild'), 'greenlight rejects "yes" + a NEW topic (no task cue)');

  console.log('pendingUserAssignedThread (the anchor):');
  db.init();
  const s = db.startSession();
  // a thread Lucas assigned (source_turn_id = a USER turn) — pending, just touched
  const uTurn = db.insertTurn({ sessionId: s, speaker: 'user', content: 'red tag researching parish contacts in Louisiana' });
  const th = db.insertOpenThread({ content: 'research parish level government contacts in Louisiana for Lucas', sourceTurnId: uTurn.id });
  // a self-generated pending thread (NO user source) — must NOT be picked (stays HERS)
  db.insertOpenThread({ content: 'her own curiosity thread about tide tables', sourceTurnId: null });

  const got = db.pendingUserAssignedThread(45 * 60 * 1000);
  ok(got && got.id === th.id, 'returns the freshest pending Lucas-assigned thread');
  ok(got && /parish/i.test(got.content), 'the returned thread is the parish research (not the self-generated one)');

  // once resolved (status flips off pending), it is no longer offered
  db.markOpenThreadStatus(th.id, 'active');
  ok(db.pendingUserAssignedThread(45 * 60 * 1000) === null, 'a non-pending thread is not re-offered');

  // stale threads fall out of the window — age this one to 2h ago, assert a 45-min window excludes it
  db.markOpenThreadStatus(th.id, 'pending');
  db.getDb().prepare('UPDATE open_threads SET last_touched_ts = ? WHERE id = ?').run(Date.now() - 2 * 60 * 60 * 1000, th.id);
  ok(db.pendingUserAssignedThread(45 * 60 * 1000) === null, 'a thread older than the window is not offered');
  ok(db.pendingUserAssignedThread(3 * 60 * 60 * 1000) !== null, 'a wider window still finds it (window arithmetic works)');
} catch (e) {
  fail++; console.error('  ✗ threw:', e.message);
} finally {
  try { db.getDb().close(); } catch {}
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
