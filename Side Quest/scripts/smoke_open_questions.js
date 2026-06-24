/** Prove the open-question stack: her trailing question is detected + recorded pending,
 *  surfaced once on the next user turn (then auto-resolved so it doesn't nag), and a reply
 *  that asks nothing records nothing. Temp DB, no model. */
const os = require('os'), path = require('path'), fs = require('fs');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_openq_${Date.now()}.db`);
const db = require('../lib/db'); db.init();
const oq = require('../lib/open_questions');
let pass = 0, fail = 0;
const ok = (n, c) => { (c ? pass++ : fail++); console.log(`  ${c ? '✓' : '✗'} ${n}`); };

(async () => {
  const sid = db.startSession();

  console.log('extractQuestion isolates the trailing question:');
  ok('plain question', oq.extractQuestion('Do you have siblings?') === 'Do you have siblings?');
  ok('trailing Q after a statement', oq.extractQuestion("That makes sense. So — are you an only child?") === 'So — are you an only child?');
  ok('no question → null', oq.extractQuestion('I think permitting reform matters.') === null);
  ok('rhetorical-but-not-final ignored', oq.extractQuestion('Isn\'t that wild? Anyway, I read three papers today.') === null);
  ok('empty → null', oq.extractQuestion('') === null);

  console.log('\nrecord → surface → resolve lifecycle:');
  const saidRow = db.insertTurn({ sessionId: sid, speaker: 'ai_said', content: 'I keep wondering — do you have siblings?' });
  const rec = oq.recordFromSay(sid, 'I keep wondering — do you have siblings?', saidRow.id);
  ok('a question reply records a pending row', !!(rec && rec.id));
  ok('one pending question for the session', db.getPendingOpenQuestions(sid).length === 1);

  // next user turn arrives
  const userRow = db.insertTurn({ sessionId: sid, speaker: 'user', content: 'yeah, two younger brothers' });
  const pend = oq.takePending(sid, userRow.id);
  ok('takePending surfaces the question', pend.length === 1 && /siblings/.test(pend[0].question));
  const block = oq.buildBlock(pend, 'Lucas');
  ok('buildBlock names the question + binds the reply', /siblings/.test(block) && /likely his answer/i.test(block));

  console.log('\nresolution closes it (no nagging next turn):');
  ok('no pending left after takePending', db.getPendingOpenQuestions(sid).length === 0);
  ok('second takePending is empty', oq.takePending(sid, userRow.id).length === 0);
  ok('buildBlock(null) → null', oq.buildBlock([], 'Lucas') === null);

  console.log('\na non-question reply records nothing:');
  oq.recordFromSay(sid, 'Got it — two brothers. That tracks with what you said about chaos at home.', db.insertTurn({ sessionId: sid, speaker: 'ai_said', content: 'x' }).id);
  ok('still zero pending', db.getPendingOpenQuestions(sid).length === 0);

  console.log('\nage gate suppresses a stale question:');
  db.insertOpenQuestion({ sessionId: sid, question: 'old one?', askedTurnId: null });
  ok('fresh maxAge sees it', db.getPendingOpenQuestions(sid, { maxAgeMs: 60000 }).length === 1);
  // negative window → recency floor is in the FUTURE, so nothing qualifies (deterministic
  // proof the age gate filters by created_ts; maxAgeMs:0 is a degenerate same-ms boundary).
  ok('past-its-moment window suppresses it', db.getPendingOpenQuestions(sid, { maxAgeMs: -1000 }).length === 0);

  db.getDb().close();
  try { for (const e of ['', '-wal', '-shm']) fs.existsSync(process.env.SQ_DB_PATH + e) && fs.unlinkSync(process.env.SQ_DB_PATH + e); } catch {}
  console.log(`\n${fail === 0 ? 'OPEN-QUESTIONS OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
