/* LIVE-FIRE mergeNearDupKnowledge against a COPY of sq.db (no writes). Hydrates the cloud key,
 * runs the real cloud relate/merge over the first few near-dup KNOWLEDGE clusters.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/curate_livefire_neardup.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const ECHO_PYTHON = process.env.ECHO_PYTHON || path.join(ECHO_CWD, '.venv', 'Scripts', 'python.exe');
require('C:/Users/azrae/Desktop/Side Quest/lib/keystore').hydrateFromEcho(['OLLAMA_API_KEY'], { python: ECHO_PYTHON, cwd: ECHO_CWD });
if (!process.env.OLLAMA_API_KEY) { console.error('no cloud key — aborting'); process.exit(1); }

const LIVE = 'C:/Users/azrae/Desktop/Side Quest/data/sq.db';
const copy = path.join(os.tmpdir(), `sq_lf_neardup_${process.pid}.db`);
fs.copyFileSync(LIVE, copy);
for (const ext of ['-wal', '-shm']) { try { if (fs.existsSync(LIVE + ext)) fs.copyFileSync(LIVE + ext, copy + ext); } catch {} }
process.env.SQ_DB_PATH = copy;

const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db'); db.init();
const curator = require('C:/Users/azrae/Desktop/Side Quest/lib/cloud_curator');

(async () => {
  try {
    console.log('curator model:', db.getMeta('model.curator'), '\n');
    const t0 = Date.now();
    const r = await curator.mergeNearDupKnowledge({ apply: false, maxClusters: 6 });
    console.log(`candidate notes: ${r.candidateRows} | near-dup clusters total: ${r.totalClusters} | judged first ${r.clusters} | elapsed ${Math.round((Date.now() - t0) / 1000)}s\n`);
    for (const x of r.results) {
      console.log(`• ${x.action}${x.dropped != null ? ` (would drop ${x.dropped})` : ` (size ${x.size})`}`);
      if (x.sample) console.log(`   cloud-merged → "${x.sample}"`);
    }
  } catch (e) {
    console.error('threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [copy, copy + '-wal', copy + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
})();
