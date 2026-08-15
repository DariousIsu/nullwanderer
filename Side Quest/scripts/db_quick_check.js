/* scripts/db_quick_check.js — PRAGMA quick_check in a CHILD process (lib/db_health.maybeQuickCheck).
 * Runs OUTSIDE the app's main thread on purpose: quick_check on a 2.6GB store takes long enough to
 * BE a main-thread stall. Opens read-only (WAL mode makes the concurrent read safe), prints ONE
 * JSON line: {ok, msg, ms}. Exit 0 always — the verdict is the JSON, not the exit code.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/db_quick_check.js <db-path>
 */
'use strict';
const t0 = Date.now();
try {
  const p = process.argv[2];
  if (!p) throw new Error('no db path given');
  const Database = require(require('path').join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const d = new Database(p, { readonly: true, fileMustExist: true });
  let rows;
  try { rows = d.pragma('quick_check'); } finally { try { d.close(); } catch {} }
  const msgs = (rows || []).map((r) => (r && (r.quick_check || r.integrity_check)) || JSON.stringify(r));
  const ok = msgs.length === 1 && /^ok$/i.test(String(msgs[0] || '').trim());
  console.log(JSON.stringify({ ok, msg: ok ? 'ok' : msgs.join('; ').slice(0, 500), ms: Date.now() - t0 }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, msg: e.message, ms: Date.now() - t0 }));
}
