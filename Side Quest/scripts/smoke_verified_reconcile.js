/* Smoke: cloud_curator.reconcileVerifiedFacts (Consolidate/C) — deterministic, stored embeddings.
 * Proves: layer-1 (same subject_key, newer as_of supersedes older); layer-2 (phrasing-drift —
 * different key, same embedding, newer as_of supersedes); same-as_of contradictions are LEFT live;
 * dry-run writes nothing; apply flips source→verified_fact_superseded + records superseded_by.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_verified_reconcile.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_vrec_${process.pid}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const curator = require('C:/Users/azrae/Desktop/Side Quest/lib/cloud_curator');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const v = (a) => JSON.stringify(a);
const mk = (content, key, asOf, emb) => db.insertKnowledge({ kind: 'note', content, source: 'verified_fact', importance: 0.9, embedding: v(emb), provenance: { subject_key: key, as_of: asOf, url: 'https://src/' + key } }).id;
const srcOf = (id) => db.getDb().prepare('SELECT source FROM knowledge WHERE id=?').get(id).source;
const provOf = (id) => { try { return JSON.parse(db.getDb().prepare('SELECT provenance FROM knowledge WHERE id=?').get(id).provenance); } catch { return {}; } };

(async () => {
  try {
    db.init();
    // Layer 1: same slot, older loses.
    const a1 = mk('US president was X', 'us-president', '2025-01', [1, 0, 0, 0]);
    const a2 = mk('US president is Y', 'us-president', '2026-06', [1, 0, 0, 0]);
    // Same slot, SAME as_of → contradiction (orthogonal embeddings so layer 2 won't touch them).
    const b1 = mk('Capital is P', 'capital-france', '2024', [0, 1, 0, 0]);
    const b2 = mk('Capital is Q', 'capital-france', '2024', [0, 0, 1, 0]);
    // Layer 2: phrasing-drift — DIFFERENT key, SAME embedding, newer wins.
    const c1 = mk('Germany GDP 2023', 'gdp-germany', '2023', [0, 0, 0, 1]);
    const c2 = mk('GDP of Germany 2024', 'germany-gdp', '2024', [0, 0, 0, 1]);

    console.log('dry run:');
    const dry = await curator.reconcileVerifiedFacts({ apply: false });
    ok(dry.live === 6, 'sees all 6 live verified facts');
    ok(dry.wouldSupersede === 2, 'plans 2 supersessions (layer-1 a1, layer-2 c1)');
    ok(dry.contradictions === 1, 'flags 1 same-as_of contradiction (B)');
    ok(dry.superseded === 0, 'dry run wrote nothing');
    ok(srcOf(a1) === 'verified_fact', 'dry run left a1 live');

    console.log('apply:');
    const app = await curator.reconcileVerifiedFacts({ apply: true });
    ok(app.superseded === 2, 'applied 2 supersessions');
    ok(srcOf(a1) === 'verified_fact_superseded', 'a1 (older slot) superseded');
    ok(srcOf(a2) === 'verified_fact', 'a2 (newer slot) kept live');
    ok(provOf(a1).superseded_by === a2, 'a1 records superseded_by = a2');
    ok(srcOf(c1) === 'verified_fact_superseded' && srcOf(c2) === 'verified_fact', 'layer-2: c1 superseded, c2 kept');
    ok(provOf(c1).superseded_by === c2, 'c1 records superseded_by = c2 (cross-key phrasing drift)');
    ok(srcOf(b1) === 'verified_fact' && srcOf(b2) === 'verified_fact', 'same-as_of contradiction left BOTH live');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
