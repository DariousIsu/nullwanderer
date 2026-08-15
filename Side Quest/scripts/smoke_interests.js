/* Smoke: lib/interests — the self-directed agenda. Deterministic (injected rng/embed/rank/focus).
 * Proves: idempotent seeding; ε-explore picks least-visited; exploit samples by weight w/ share cap;
 * reweight raises lp_ema/weight for the interest its banked facts match and the cloud ranker boosts;
 * unmatched-but-clustered learning spawns an emergent interest; maybeSpawnFocus sets a focus + visit.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_interests.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_interests_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const interests = require('C:/Users/azrae/Desktop/Side Quest/lib/interests');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const v = (a) => JSON.stringify(a);
const mkRng = (seq) => { let i = 0; return () => seq[(i++) % seq.length]; };
const get = (slug) => db.getDb().prepare('SELECT * FROM interests WHERE slug=?').get(slug);

(async () => {
  try {
    db.init();
    const embedFn = async () => [0, 0, 0, 1];   // seeds get a throwaway vector here

    // 1. idempotent seeding
    const s1 = await interests.seed({ embedFn });
    ok(s1.added === interests.SEED_INTERESTS.length, `seeded ${s1.added} domains`);
    const s2 = await interests.seed({ embedFn });
    ok(s2.added === 0, 'second seed adds nothing (idempotent)');

    // wipe to a controlled 2-interest set for the sampling/reweight tests
    db.getDb().prepare('DELETE FROM interests').run();
    const mId = db.getDb().prepare("INSERT INTO interests (topic,slug,weight,source,embedding,visits,created_ts) VALUES ('markets','markets',?,?,?,?,?)").run(0.1, 'seed', v([1, 0, 0, 0]), 5, Date.now()).lastInsertRowid;
    const pId = db.getDb().prepare("INSERT INTO interests (topic,slug,weight,source,embedding,visits,created_ts) VALUES ('physics','physics',?,?,?,?,?)").run(5.0, 'seed', v([0, 1, 0, 0]), 0, Date.now()).lastInsertRowid;

    // 2. ε-explore → least-visited (physics has 0 visits, markets 5)
    const ex = interests.sampleTopic({ rng: mkRng([0.0]) });  // 0.0 < epsilon → explore
    ok(ex && ex.id === pId, 'ε-explore returns the least-visited interest');

    // 3. exploit → high-weight wins the mass; low position returns the low-weight one
    const hi = interests.sampleTopic({ rng: mkRng([0.9, 0.6]) });  // 0.9≥ε → exploit; r mid → physics (most mass)
    ok(hi && hi.id === pId, 'exploit samples the high-weight interest from the mass');
    const lo = interests.sampleTopic({ rng: mkRng([0.9, 0.00001]) });  // r≈0 → first item (markets)
    ok(lo && lo.id === mId, 'exploit can still pick the low-weight one at the bottom of the mass');

    // 4. reweight — banked facts matching markets raise its lp_ema/weight; cloud ranker gates
    for (let i = 0; i < 5; i++) db.insertKnowledge({ kind: 'note', content: 'market fact ' + i, source: 'learning', importance: 0.6, embedding: v([1, 0, 0, 0]), provenance: { subject: 'markets', subject_key: 'markets' } });
    // unmatched cluster → emergent: 4 facts on a new subject, orthogonal vector
    for (let i = 0; i < 4; i++) db.insertKnowledge({ kind: 'note', content: 'quantum fact ' + i, source: 'learning', importance: 0.6, embedding: v([0, 0, 1, 0]), provenance: { subject: 'Quantum Computing', subject_key: 'quantum-computing' } });
    // R3/R5: a TRIVIA interest with huge learning-progress (12 facts → lp_ema would be 4.8) but a LOW
    // cloud score (2) — must be lp-capped at 4 AND hard-capped in weight below the seed band.
    const trivId = db.getDb().prepare("INSERT INTO interests (topic,slug,weight,source,embedding,visits,created_ts) VALUES ('trivia','trivia',?,?,?,?,?)").run(0.5, 'emergent', v([0, 0, 0, 1]), 3, Date.now()).lastInsertRowid;
    for (let i = 0; i < 12; i++) db.insertKnowledge({ kind: 'note', content: 'trivia fact ' + i, source: 'learning', importance: 0.6, embedding: v([0, 0, 0, 1]), provenance: { subject: 'Trivia', subject_key: 'triv-' + i } });
    const rankFn = async (cands) => cands.map(c => ({ id: c.id, score: c.topic === 'markets' ? 9 : c.topic === 'trivia' ? 2 : 3 }));
    const rw = await interests.reweight({ apply: true, embedFn: async () => [0, 0, 1, 0], rankFn, now: Date.now() });
    ok(rw.reweighted === 3, 'reweighted all interests');
    const mkt = get('markets'), phy = get('physics');
    ok(mkt.lp_ema > 1.5, `markets lp_ema rose from banked facts (${mkt.lp_ema.toFixed(2)})`);
    ok(phy.lp_ema === 0, 'physics lp_ema stays 0 (no matching facts)');
    ok(mkt.weight > phy.weight, 'markets now outweighs physics (learning-progress + cloud score)');
    const triv = get('trivia');
    ok(triv.lp_ema === 4, `R3: lp_ema CAPPED at 4 despite 12 facts (was ${(0.4 * 12).toFixed(1)})`);
    ok(triv.weight <= 1.0, `R5: low cloud score HARD-CAPS trivia weight ≤1.0 (${triv.weight.toFixed(2)}) — can't climb on lp alone`);
    void trivId;
    ok(rw.emergent.includes('Quantum Computing'), 'unmatched clustered learning spawned an emergent interest');
    ok(!!get('quantum-computing'), 'emergent interest row created');

    // 5. maybeSpawnFocus — sets a focus from a sampled interest + records the visit
    const fakeFocus = { isActive: () => false, setCurrent: (tid) => ({ id: tid, content: 'set' }) };
    const beforeVisits = get('physics').visits + get('markets').visits;
    const spawned = await interests.maybeSpawnFocus({ focusLib: fakeFocus, prob: 0.8, rng: mkRng([0.1, 0.0]) });  // gate pass + explore
    ok(spawned && spawned.focus && spawned.interest, 'maybeSpawnFocus set a focus from an interest');
    const afterVisits = get('physics').visits + get('markets').visits;
    ok(afterVisits === beforeVisits + 1, 'a visit was recorded for the pursued interest');
    const gated = await interests.maybeSpawnFocus({ focusLib: fakeFocus, prob: 0.8, rng: mkRng([0.95]) });  // 0.95 > 0.8 → skip
    ok(gated === null, 'prob gate can skip (leaves room for free-association)');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  // ── B1 (2026-08-15 deep-dive): the wondering organ has a LIVE CALLER ─────────────────────────
  // maybeSpawnFocus had zero callers outside this smoke — the one spawner of an undirected focus,
  // and therefore the whole free-thought lane, was unreachable in production. Source-pinned so the
  // wire cannot silently drop again.
  {
    const mono = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'monologue.js'), 'utf8');
    ok(/require\('\.\/interests'\)\.maybeSpawnFocus\(\)/.test(mono),
      'B1: the monologue idle branch CALLS maybeSpawnFocus — the wondering pulse is live');
    ok(/interests\.last_spawn_attempt_at/.test(mono),
      'B1: the spawn attempt is cadence-gated (the 07-01 noise-audit ruling stands)');
    ok(/focus wonder self-dialogue error/.test(mono),
      'B1: a <wonder> on a focus tick fires self-dialogue instead of being silently discarded');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
