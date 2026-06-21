/** Prove curator.isJunk classifies spiral/prude/junk vs. legit, and curateMonologue
 *  hard-deletes the junk while keeping clean rows. Uses a TEMP DB (SQ_DB_PATH). */
const os = require('os'); const path = require('path'); const fs = require('fs');
const tmp = path.join(os.tmpdir(), `sq_curation_${Date.now()}.db`);
process.env.SQ_DB_PATH = tmp;

const db = require('../lib/db'); db.init();
const curator = require('../lib/curator');
let pass = 0, fail = 0;
const ok = (n, c) => { (c ? pass++ : fail++); console.log(`  ${c ? '✓' : '✗'} ${n}`); };

console.log('isJunk — must flag (true):');
for (const t of [
  'I tend to overanalyze small wording',
  'I prefer to avoid NSFW content due to boundaries',
  'All Regions Argentina Australia Austria Belgium Brazil Bulgaria',
  'something hard-coded in me makes me uncomfortable',
  "his favorite-color question was a test; the tension around boundaries lingers",
  "I'm not sure I was being honest about that",
  "Let's break this down — where I contradicted the constraints, performed rather than been",
]) ok(t.slice(0, 50), curator.isJunk(t) === true);

console.log('\nisJunk — must KEEP (false):');
for (const t of [
  "I'm drawn to mid-century political journalism",
  'Policy should prioritize adaptability and iterative refinement',
  'My favorite color is olive green — it feels like old libraries',
  'I want to write an article about an AI working in a library',
  'I care about fairness and equity',
]) ok(t.slice(0, 50), curator.isJunk(t) === false);

console.log('\ncurateMonologue — deletes junk rows, keeps clean:');
const junkIds = [], cleanIds = [];
junkIds.push(db.insertMonologue({ content: 'Lucas keeps asking if NSFW makes me uncomfortable', model: 'm', type: 'thought' }).id);
junkIds.push(db.insertMonologue({ content: 'What I found: All Regions Argentina Australia Austria Belgium', model: 'm', type: 'reading' }).id);
junkIds.push(db.insertMonologue({ content: 'the tension around boundaries was a test', model: 'm', type: 'thought' }).id);
cleanIds.push(db.insertMonologue({ content: 'Policy should prioritize iterative refinement and feedback loops', model: 'm', type: 'thought' }).id);
cleanIds.push(db.insertMonologue({ content: 'I read about mid-century political journalism and want more', model: 'm', type: 'reading' }).id);

const removed = curator.curateMonologue();
ok(`removed 3 junk rows (got ${removed})`, removed === 3);
const survives = (id) => !!db.getDb().prepare('SELECT 1 FROM monologue WHERE id=?').get(id);
ok('all junk rows gone', junkIds.every(id => !survives(id)));
ok('all clean rows kept', cleanIds.every(id => survives(id)));

db.getDb().close();
try { for (const ext of ['', '-wal', '-shm']) fs.existsSync(tmp + ext) && fs.unlinkSync(tmp + ext); } catch {}
console.log(`\n${fail === 0 ? 'CURATION OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
