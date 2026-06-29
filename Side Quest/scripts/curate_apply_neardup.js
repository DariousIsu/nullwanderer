/* APPLY mergeNearDupKnowledge to the LIVE db (run with the app STOPPED). Backs up first, hydrates
 * the cloud key, runs the full cloud near-dup merge, verifies. Reversible: restore the backup.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/curate_apply_neardup.js
 */
const path = require('path'), fs = require('fs');

// 1) Hydrate cloud key from Echo's keychain.
const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const ECHO_PYTHON = process.env.ECHO_PYTHON || path.join(ECHO_CWD, '.venv', 'Scripts', 'python.exe');
require('C:/Users/azrae/Desktop/Side Quest/lib/keystore').hydrateFromEcho(['OLLAMA_API_KEY'], { python: ECHO_PYTHON, cwd: ECHO_CWD });
if (!process.env.OLLAMA_API_KEY) { console.error('no cloud key — aborting'); process.exit(1); }

const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const curator = require('C:/Users/azrae/Desktop/Side Quest/lib/cloud_curator');
const DB = db.DB_PATH;
if (!DB || !fs.existsSync(DB)) { console.error('DB not found:', DB); process.exit(1); }

// 2) Timestamped backup BEFORE opening (db + wal + shm).
const d = new Date(); const p = n => String(n).padStart(2, '0');
const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
const backup = `${DB}.backup_neardup_${ts}`;
fs.copyFileSync(DB, backup);
for (const ext of ['-wal', '-shm']) { try { if (fs.existsSync(DB + ext)) fs.copyFileSync(DB + ext, backup + ext); } catch {} }
console.log('✓ backup →', backup, `(${(fs.statSync(backup).size / 1e6).toFixed(1)} MB)`);

(async () => {
  db.init();
  console.log('curator model:', db.getMeta('model.curator'));
  const before = db.getDb().prepare('SELECT COUNT(*) n FROM knowledge').get().n;
  console.log(`\nbefore: ${before} knowledge rows — running full cloud near-dup merge…\n`);
  const t0 = Date.now();
  const r = await curator.mergeNearDupKnowledge({ apply: true });
  const after = db.getDb().prepare('SELECT COUNT(*) n FROM knowledge').get().n;
  const merged = r.results.filter(x => x.action === 'merged').length;
  const skipped = r.results.filter(x => x.action === 'skip-distinct').length;
  console.log(`✓ APPLIED in ${Math.round((Date.now() - t0) / 1000)}s — ${r.totalClusters} clusters: ${merged} merged, ${skipped} kept distinct`);
  console.log(`  rows collapsed: ${r.collapsed}   (${before} → ${after})`);
  const k = db.getDb().prepare('SELECT COUNT(*) n FROM knowledge').get().n;
  const ftc = db.getDb().prepare('SELECT COUNT(*) n FROM knowledge_fts').get().n;
  console.log(`  knowledge vs FTS: ${k} / ${ftc} (expect equal — no orphans)`);
  console.log('\nsample merges:');
  for (const x of r.results.filter(x => x.action === 'merged').slice(0, 6)) console.log(`  · −${x.dropped} → "${x.sample}"`);
  db.getDb().close();
  console.log('\ndone.');
})();
