/**
 * The duplicate-thread ROOT (2026-08-13): the dedup pool was ORDER BY last_touched_ts ASC — the 50
 * STALEST threads — so with >50 open, a just-minted sibling was never in the window and every
 * rephrase minted a duplicate beside it (#3823/25/27, #3826/28, #3867/68 all post-dedup-deploy).
 * Pins: newestFirst pool ordering + decideForCandidate NOOPing against a fresh sibling that sits
 * OUTSIDE the old stale-first window, with the embedder dead (the deterministic floor alone).
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_thread_pool_window.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_tpw_${Date.now()}.db`);

const db = require('../lib/db');
db.init();
const consolidate = require('../lib/consolidate');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  // 55 distinct stale threads (touched long ago), then ONE fresh sibling.
  const base = Date.now() - 30 * 24 * 3600000;
  const ins = db.getDb().prepare("INSERT INTO open_threads (content, status, created_ts, last_touched_ts) VALUES (?, 'pending', ?, ?)");
  for (let i = 0; i < 55; i++) ins.run(`validate the elected officials of district ${i} in state ${i}`, base + i, base + i);
  const sib = db.getDb().prepare("INSERT INTO open_threads (content, status, created_ts, last_touched_ts) VALUES (?, 'pending', ?, ?)")
    .run('develop a personal identity and individual interests over time', Date.now(), Date.now());

  const stale = db.getActiveOpenThreads(50);
  ok('default (stale-first) pool EXCLUDES the fresh sibling — the measured hole', !stale.some((t) => t.id === sib.lastInsertRowid));
  const fresh = db.getActiveOpenThreads(50, { newestFirst: true });
  ok('newestFirst pool INCLUDES the fresh sibling', fresh.some((t) => t.id === sib.lastInsertRowid));

  // The live duplicate, embedder DEAD → the token floor must catch it via the newest-first pool.
  const d = await consolidate.decideForCandidate(
    'develop a personal identity and set of opinions over time',
    { embedFn: async () => null, classifyFn: async () => ({ action: 'ADD' }) });
  ok(`the 71-second rephrase NOOPs onto the sibling (got ${d.action}${d.targetId ? ' → #' + d.targetId : ''})`,
    d.action === 'NOOP' && d.targetId === sib.lastInsertRowid);

  // A genuinely new subject still ADDs.
  const d2 = await consolidate.decideForCandidate('plan the Monroe hardware budget spreadsheet',
    { embedFn: async () => null, classifyFn: async () => ({ action: 'ADD' }) });
  ok('a genuinely new subject still ADDs', d2.action === 'ADD');

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
