/** Prove Piece 2: (a) isSocialTurn flags personal/check-in turns and NOT work turns, and
 *  (b) curateThreads now decays neglected active threads (active→stalled→abandoned) so the
 *  store stops being a junk drawer. Temp DB, no model. */
const os = require('os'), path = require('path'), fs = require('fs');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_reg_${Date.now()}.db`);
const db = require('../lib/db'); db.init();
const { isSocialTurn } = require('../lib/intent');
const curator = require('../lib/curator');
let pass = 0, fail = 0;
const ok = (n, c) => { (c ? pass++ : fail++); console.log(`  ${c ? '✓' : '✗'} ${n}`); };

console.log('isSocialTurn — personal/check-in turns are social:');
for (const m of ['Hey Zo, how are you doing?', 'How are you doing kiddo?', 'Zo you there?', 'hey', 'good morning', "what's up", 'just checking in', 'how was your day?'])
  ok(`social: "${m}"`, isSocialTurn(m) === true);

console.log('\nisSocialTurn — work/task turns are NOT social:');
for (const m of ['open the spreadsheet', 'what do you think about permitting reform?', 'research female journalists', 'how are you doing on the op-ed?', 'read this https://x.com/y', 'review the LA_Policy_Lab.xlsm file', 'draft the email to the senator'])
  ok(`not social: "${m}"`, isSocialTurn(m) === false);

(async () => {
  console.log('\ncurateThreads — neglected active threads decay; fresh ones survive:');
  const sid = db.startSession();
  const mk = (content, ageDays, status = null) => {
    const r = db.insertOpenThread({ content, sourceTurnId: null });
    const ts = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    db.getDb().prepare('UPDATE open_threads SET last_touched_ts = ?, created_ts = ?, status = ? WHERE id = ?')
      .run(ts, ts, status || 'active', r.id);
    return r.id;
  };
  const freshId = mk('actively worked thread', 1);                 // touched yesterday → survives
  const neglectedId = mk('neglected active goal', 12);             // 12d untouched → should stall
  const longStalledId = mk('old stalled goal', 20, 'stalled');     // stalled 20d → should abandon

  curator.curateThreads();
  const st = (id) => db.getOpenThread(id).status;
  ok('fresh active thread stays active', st(freshId) === 'active');
  ok('neglected active thread → stalled', st(neglectedId) === 'stalled');
  ok('long-stalled thread → abandoned', st(longStalledId) === 'abandoned');
  ok('decayed threads drop from active rotation', !db.getActiveOpenThreads(50).some(t => t.id === longStalledId));

  db.getDb().close();
  try { for (const e of ['', '-wal', '-shm']) fs.existsSync(process.env.SQ_DB_PATH + e) && fs.unlinkSync(process.env.SQ_DB_PATH + e); } catch {}
  console.log(`\n${fail === 0 ? 'REGISTER-GATE OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
