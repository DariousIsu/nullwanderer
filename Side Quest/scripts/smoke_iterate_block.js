/* Smoke: lib/learning.buildPriorKnowledgeBlock (Iterate). Deterministic — injected retrieveFn.
 * Proves: prior knowledge on a topic renders with a verified fact surfaced distinctly + an
 * "ADD to this, don't restart" instruction; empty recall → null; empty topic → null.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_iterate_block.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_iter_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
process.env.SQ_DB_PATH = tmp;
const learning = require('C:/Users/azrae/Desktop/Side Quest/lib/learning');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const rows = [
  { id: 1, kind: 'note', source: 'verified_fact', content: 'The team ranked #2.', provenance: JSON.stringify({ as_of: '2026', url: 'u' }) },
  { id: 2, kind: 'note', source: 'learning', content: 'The team is based in Tampa Bay.' },
  { id: 3, kind: 'note', source: 'reflection_knowledge', content: 'Some prior finding about the topic.' }
];

(async () => {
  try {
    const block = await learning.buildPriorKnowledgeBlock('cheer team', { retrieveFn: async () => rows });
    ok(/WHAT YOU ALREADY KNOW about "cheer team"/.test(block), 'header names the topic');
    ok(/\[VERIFIED as of 2026\] The team ranked #2\./.test(block), 'verified fact surfaced distinctly with as_of');
    ok(/\[learned\] The team is based in Tampa Bay\./.test(block), 'a banked learning rendered as [learned]');
    ok(/\[note\] Some prior finding/.test(block), 'ordinary note rendered as [note]');
    ok(/do NOT restate it or look it up again/.test(block) && /Extend the frontier; do not circle/.test(block), 'frontier-push (anti-retread) instruction present');

    const empty = await learning.buildPriorKnowledgeBlock('anything', { retrieveFn: async () => [] });
    ok(empty === null, 'no recall → null (nothing injected)');
    const noTopic = await learning.buildPriorKnowledgeBlock('', { retrieveFn: async () => rows });
    ok(noTopic === null, 'empty topic → null');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
