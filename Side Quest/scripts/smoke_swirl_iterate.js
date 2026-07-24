/* Smoke: R7 swirl→iterate. (1) assessSearchNovelty flags a dense same-vein cluster (the STDP swirl)
 * and passes a sparse/novel query; (2) nextNovelGap returns an agenda gap NOT in the query's vein,
 * skipping same-vein ones — so a braked swirl advances to a real frontier instead of re-asking.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_swirl_iterate.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_swirl_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const mono = require('C:/Users/azrae/Desktop/Side Quest/lib/monologue');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  try {
    db.init();

    // (1) swirl detection — 5 near-identical "STDP energy" probes are a dense vein → suppress
    const swirl = mono.assessSearchNovelty([1, 0, 0, 0], [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]]);
    ok(swirl.suppress && swirl.fixated, 'dense same-vein cluster (the STDP swirl) → braked');
    const novel = mono.assessSearchNovelty([1, 0, 0, 0], [[0, 1, 0, 0], [0, 0, 1, 0]]);
    ok(!novel.suppress, 'sparse/novel query (different veins) → passes');

    // (2) nextNovelGap — skips a same-vein agenda question, returns a genuinely different frontier
    db.insertAgenda({ interestId: 1, question: 'What are the ethical limits of utilitarian healthcare policy?' });   // id 1 (older)
    db.insertAgenda({ interestId: 2, question: 'What are the energy mechanisms of STDP neuromorphic hardware?' });   // id 2 (fresher, same vein)
    const gap = mono.nextNovelGap('STDP neuromorphic energy consumption mechanisms');
    ok(/ethical limits/.test(gap || ''), 'returns the NOVEL gap (ethics), skipping the same-vein STDP question');
    // when everything open is in-vein, no false frontier
    db.getDb().prepare("UPDATE agenda SET status='answered' WHERE question LIKE '%ethical%'").run();
    const none = mono.nextNovelGap('STDP neuromorphic energy');
    ok(none === null, 'no out-of-vein open gap → null (does not hand back a same-vein reword)');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
