/**
 * Backtest — focus spawn-gate after the tombstone-embedding fix.
 * A tombstone stored with embedText=bare-goal must block a REWORDED same-theme
 * focus (the #62 leak), while letting an unrelated goal through. Proves the wrapper
 * no longer dilutes the embedding under threshold. Temp DB, real bge-small.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_spawn_gate.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_gate_${Date.now()}.db`);

const D = require('../lib/db');
D.init();
const memory = require('../lib/memory');
const focusLib = require('../lib/focus');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  await memory.warm().catch(() => {});

  // Tombstone the theme the way _close now does: readable wrapper content, but
  // embedText = the bare goal.
  await memory.store({
    kind: 'note',
    content: `Focus "Stop overanalyzing Lucas's words" → resolved: practice taking things at face value`,
    source: 'focus_tombstone',
    importance: 0.8,
    embedText: "Stop overanalyzing Lucas's words"
  });

  const reworded = await focusLib.recentlyTombstoned("Work on not overanalyzing Lucas's words");
  ok('reworded same-theme focus is BLOCKED', !!reworded);

  const unrelated = await focusLib.recentlyTombstoned('research female journalists for the AI series');
  ok('unrelated goal is NOT blocked', !unrelated);

  // Control: a wrapper-embedded tombstone (old behavior) would have leaked. Confirm
  // the bare-embedded cosine clears threshold.
  const tomb = D.getKnowledgeBySourceSince('focus_tombstone%', Date.now() - 24 * 3600 * 1000)[0];
  const qv = await memory.embed("Work on not overanalyzing Lucas's words");
  const cos = memory.cosine(qv, JSON.parse(tomb.embedding));
  ok(`bare-embedded cosine ≥ 0.82 (got ${cos.toFixed(3)})`, cos >= 0.82);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
