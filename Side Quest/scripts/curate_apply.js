/* APPLY Slice 1a quarantine prune to the LIVE db. Backs up first, then deletes only the
 * stale-tombstone + speculation rows (Job A). Job B (self_evolution) stays report-only.
 * Reversible: restore the printed backup files. Run with the app STOPPED.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/curate_apply.js
 */
const fs = require('fs');
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const curator = require('C:/Users/azrae/Desktop/Side Quest/lib/cloud_curator');

const DB = db.DB_PATH;
if (!DB || !fs.existsSync(DB)) { console.error('DB path not found:', DB); process.exit(1); }

// 1) Timestamped backup BEFORE opening the db (snapshot db + wal + shm together).
const d = new Date(); const p = n => String(n).padStart(2, '0');
const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
const backup = `${DB}.backup_${ts}`;
fs.copyFileSync(DB, backup);
for (const ext of ['-wal', '-shm']) { try { if (fs.existsSync(DB + ext)) fs.copyFileSync(DB + ext, backup + ext); } catch {} }
console.log('✓ backup →', backup, `(${(fs.statSync(backup).size / 1e6).toFixed(1)} MB)`);

// 2) Apply Job A.
db.init();
const before = curator.preClean({ apply: false });
console.log(`\nbefore: ${before.knowledge_before} knowledge rows`);
console.log(`plan:   prune ${before.quarantine.pruneIds.length} (` +
  `${before.quarantine.detail.stale_tombstones} stale tombstones + ${before.quarantine.detail.speculation} speculation), ` +
  `keep ${before.quarantine.detail.kept_recent_tombstones} recent tombstones`);

const applied = curator.preClean({ apply: true });
console.log(`\n✓ APPLIED — removed ${applied.removed} rows`);
console.log(`after:  ${applied.knowledge_after} knowledge rows`);

// 3) Verify: nothing stale left, recent tombstones preserved, FTS in lockstep.
const v = curator.preClean({ apply: false });
const kCount = db.getDb().prepare('SELECT COUNT(*) n FROM knowledge').get().n;
const ftsCount = db.getDb().prepare('SELECT COUNT(*) n FROM knowledge_fts').get().n;
console.log('\nverify:');
console.log(`  stale tombstones remaining: ${v.quarantine.detail.stale_tombstones} (expect 0)`);
console.log(`  speculation remaining:      ${v.quarantine.detail.speculation} (expect 0)`);
console.log(`  recent tombstones kept:     ${v.quarantine.detail.kept_recent_tombstones}`);
console.log(`  knowledge vs FTS rows:      ${kCount} / ${ftsCount} (expect equal — no orphans)`);
console.log(`  self_evolution untouched:   ${v.self_evolution.rows} rows (Job B deferred to cloud stage)`);
db.getDb().close();
console.log('\ndone.');
