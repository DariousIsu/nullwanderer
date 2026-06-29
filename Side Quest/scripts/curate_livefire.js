/* LIVE-FIRE the cloud curator against a COPY of sq.db (never the live DB). Hydrates the cloud
 * key from Echo's keychain (boot does this in-app), then runs the real cloud relate/merge over
 * the first few self_evolution clusters, apply=false (no writes). Proves the cloud path end-to-end.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/curate_livefire.js
 */
const path = require('path'), fs = require('fs'), os = require('os');

// 1) Hydrate OLLAMA_API_KEY from Echo's keychain (standalone scripts must replicate boot).
const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const ECHO_PYTHON = process.env.ECHO_PYTHON || path.join(ECHO_CWD, '.venv', 'Scripts', 'python.exe');
require('C:/Users/azrae/Desktop/Side Quest/lib/keystore').hydrateFromEcho(['OLLAMA_API_KEY'], { python: ECHO_PYTHON, cwd: ECHO_CWD });
if (!process.env.OLLAMA_API_KEY) { console.error('no cloud key — aborting'); process.exit(1); }

// 2) Work on a COPY of the live db.
const LIVE = 'C:/Users/azrae/Desktop/Side Quest/data/sq.db';
const copy = path.join(os.tmpdir(), `sq_livefire_${process.pid}.db`);
fs.copyFileSync(LIVE, copy);
for (const ext of ['-wal', '-shm']) { try { if (fs.existsSync(LIVE + ext)) fs.copyFileSync(LIVE + ext, copy + ext); } catch {} }
process.env.SQ_DB_PATH = copy;

const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db'); db.init();
const models = require('C:/Users/azrae/Desktop/Side Quest/lib/models');
const curator = require('C:/Users/azrae/Desktop/Side Quest/lib/cloud_curator');

(async () => {
  try {
    // Use a solid general cloud model for the validation (on the COPY only; live db untouched).
    db.setMeta('model.curator', 'gemma3:27b');
    console.log('curator model:', db.getMeta('model.curator'), '| cloud base: https://ollama.com\n');
    console.log('=== cloud relate/merge over first 3 self_evolution clusters (apply=false) ===\n');
    const t0 = Date.now();
    const r = await curator.selfEvolutionMerge({ apply: false, maxClusters: 3 });
    console.log(`clusters considered: ${r.clusters} | elapsed ${Math.round((Date.now() - t0) / 1000)}s\n`);
    for (const x of r.results) {
      console.log(`• ${x.action}${x.dropped != null ? ` (would drop ${x.dropped} dup rows)` : ''}`);
      if (x.sample) console.log(`   cloud-merged → "${x.sample}"`);
      console.log('');
    }
  } catch (e) {
    console.error('live-fire threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [copy, copy + '-wal', copy + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
})();
