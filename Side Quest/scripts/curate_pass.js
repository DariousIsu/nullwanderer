/* Run the full daily curation pass as a DRY RUN against a COPY of sq.db (no writes), so you can
 * watch what the orchestrator would do before enabling the auto-schedule (ZOE_CURATION_ENABLED).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/curate_pass.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const ECHO_PYTHON = process.env.ECHO_PYTHON || path.join(ECHO_CWD, '.venv', 'Scripts', 'python.exe');
require('C:/Users/azrae/Desktop/Side Quest/lib/keystore').hydrateFromEcho(['OLLAMA_API_KEY'], { python: ECHO_PYTHON, cwd: ECHO_CWD });

const LIVE = 'C:/Users/azrae/Desktop/Side Quest/data/sq.db';
const copy = path.join(os.tmpdir(), `sq_pass_${process.pid}.db`);
fs.copyFileSync(LIVE, copy);
for (const ext of ['-wal', '-shm']) { try { if (fs.existsSync(LIVE + ext)) fs.copyFileSync(LIVE + ext, copy + ext); } catch {} }
process.env.SQ_DB_PATH = copy;

const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db'); db.init();
const curator = require('C:/Users/azrae/Desktop/Side Quest/lib/cloud_curator');

(async () => {
  try {
    console.log('curator model:', db.getMeta('model.curator'), '| cloud:', process.env.OLLAMA_API_KEY ? 'keyed' : 'absent', '\n');
    console.log('=== daily pass DRY RUN (apply=false, no writes) ===\n');
    const t0 = Date.now();
    const r = await curator.runDailyPass({ apply: false, onLog: (m) => console.log('  ·', m) });
    console.log(`\nsummary (${Math.round((Date.now() - t0) / 1000)}s):`);
    console.log(JSON.stringify(r.stages, null, 2));
  } catch (e) {
    console.error('threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [copy, copy + '-wal', copy + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
})();
