/* Smoke: lib/meta — the meta pass (depth ratchet + learning-to-learn). Deterministic (injected
 * cloud `ask` + embeddings). Proves: summarize folds facts into a 'topic' note + sets mastery;
 * refillGaps creates open agenda questions up to the target (and dedups); closeAnsweredGaps closes a
 * question a banked fact now covers (leaving uncovered ones open); runMetaPass ties it together.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_meta.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_meta_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const meta = require('C:/Users/azrae/Desktop/Side Quest/lib/meta');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const v = (a) => JSON.stringify(a);
const getInterest = () => db.getDb().prepare("SELECT * FROM interests WHERE slug='markets'").get();

// keyword→basis-vector embedder so we control which questions a fact "answers"
const embedFn = async (t) => {
  const lc = String(t).toLowerCase();
  if (lc.includes('rate')) return [1, 0, 0, 0];
  if (lc.includes('inflation') || lc.includes('cpi')) return [0, 1, 0, 0];
  if (lc.includes('liquid')) return [0, 0, 1, 0];
  return [0, 0, 0, 1];
};
// injected broker: returns the VALIDATED value per task (mimics cloud_logic.ask's contract)
const ask = async (a) => {
  if (a.task === 'gap_questions') return ['Why does the central-bank rate move markets?', 'How is inflation measured?', 'What drives liquidity?'];
  if (a.task === 'summarize_interest') return 'Markets move on interest rates, inflation expectations, and liquidity.';
  return null;
};

(async () => {
  try {
    db.init();
    // interest 'markets' embedding matches rate + inflation facts (cosine 0.707 ≥ 0.45)
    db.getDb().prepare("INSERT INTO interests (topic,slug,weight,source,embedding,created_ts) VALUES ('markets — why prices move','markets',2.0,'seed',?,?)").run(v([1, 1, 0, 0]), Date.now());
    const it = getInterest();
    for (let i = 0; i < 3; i++) db.insertKnowledge({ kind: 'note', content: 'a rate fact ' + i, source: 'learning', importance: 0.6, embedding: v([1, 0, 0, 0]), provenance: { subject: 'rates', subject_key: 'rates' } });
    for (let i = 0; i < 2; i++) db.insertKnowledge({ kind: 'note', content: 'an inflation fact ' + i, source: 'learning', importance: 0.6, embedding: v([0, 1, 0, 0]), provenance: { subject: 'inflation', subject_key: 'inflation' } });

    // A. summarizeInterest → topic note + mastery
    const facts = meta._factsForInterest([1, 1, 0, 0]);
    ok(facts.length === 5, `interest matched its 5 banked facts (${facts.length})`);
    const sum = await meta.summarizeInterest(it, facts, { apply: true, deps: { ask } });
    ok(sum.summarized && sum.mastery > 0, `summarized + mastery set (${sum.mastery})`);
    const topic = db.getDb().prepare("SELECT * FROM knowledge WHERE source='interest_summary' AND level='topic'").get();
    ok(!!topic && /Markets move/.test(topic.content), 'interest summary stored as a level=topic note');
    ok(getInterest().mastery === sum.mastery, 'interest.mastery updated');

    // B. refillGaps → open agenda up to target, then no-op when full
    const created = await meta.refillGaps(it, facts.slice(0, 6), { apply: true, deps: { ask } });
    ok(created.length === meta.GAP_TARGET, `created ${meta.GAP_TARGET} gap-questions`);
    ok(db.countOpenAgenda(it.id) === meta.GAP_TARGET, 'open agenda filled to target');
    const again = await meta.refillGaps(it, [], { apply: true, deps: { ask } });
    ok(again.length === 0, 'no refill when already at target');

    // C. closeAnsweredGaps → close the questions a banked fact covers; leave the uncovered one
    const closed = await meta.closeAnsweredGaps(it, facts, { apply: true, embedFn });
    ok(closed === 2, 'closed the 2 questions covered by banked facts (rate, inflation)');
    ok(db.countOpenAgenda(it.id) === 1, 'the uncovered question (liquidity) stays open');

    // D. runMetaPass end-to-end
    const r = await meta.runMetaPass({ apply: true, deps: { ask, embedFn } });
    ok(r.interests === 1 && r.perInterest[0] && !r.perInterest[0].error, 'runMetaPass processed the top interest without error');
    ok(r.perInterest[0].facts === 5 && r.perInterest[0].mastery > 0, 'per-interest report carries facts + mastery');

    // freeze cut 17: getMeta/setMeta compile their statement ONCE per connection (the reply path reads
    // meta hundreds of times a turn; every call used to compile `SELECT value FROM meta WHERE key = ?`)
    db.setMeta('smoke.p', '1'); db.getMeta('smoke.p');
    const n1 = db._preparedCount();
    for (let i = 0; i < 50; i++) { db.getMeta('smoke.p'); db.setMeta('smoke.p', String(i)); }
    ok(n1 >= 2 && db._preparedCount() === n1 && db.getMeta('smoke.p') === '49', `getMeta/setMeta prepared once — the memo holds ${n1} statement(s) and 100 more calls add none`);
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
