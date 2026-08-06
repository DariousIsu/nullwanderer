/* One-shot operator action (Lucas, 2026-08-05): write the quota re-mark from his dashboard reading
 * and flip the fan-out. Dashboard: session 1.7% (resets ~4h), WEEKLY 46.4% used, resets in 3 days —
 * the weekly pool is the binding constraint, so it is the mark. research.workers 1→2 is the M4.5
 * spend-expanding flip, agreed to proceed once the mark landed; live-revertible (set back to '1').
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/apply_quota_mark_20260805.js
 */
'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'sq.db'));
db.pragma('busy_timeout = 5000');
const now = Date.now();
const set = (k, v) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

set('quota.mark_pct', '0.486');                          // TRUE-UP (dashboard ~00:15 later): weekly 48.6% — internal estimate ran ~2.4pts hot
set('quota.mark_at', now);
set('quota.reset_at', now + 3 * 24 * 3600 * 1000);       // "resets in 3 days"
// quota.limit_compute unchanged (10,354,421 — the pool size)
set('research.workers', '2');                            // unchanged (kept by decision after the true-up)

for (const k of ['quota.limit_compute', 'quota.mark_pct', 'quota.mark_at', 'quota.reset_at', 'research.workers', 'research.alloc', 'mapping.paused']) {
  const r = db.prepare('SELECT value FROM meta WHERE key=?').get(k);
  let v = r ? r.value : '(unset)';
  if (k.endsWith('_at') && /^\d{10,}$/.test(v)) v += ` (${new Date(parseInt(v, 10)).toISOString()})`;
  console.log(k.padEnd(22), '=', v);
}
db.close();
