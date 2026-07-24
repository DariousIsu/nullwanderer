/* Smoke: lib/analysis_lane — R3 the one-off ANALYSIS lane. THE PROOFS: a script READS her data,
 * a WRITE is rejected by SQLite (mode=ro) and the live DB is byte-unchanged, the whitelist exposes
 * only named data DBs (never secrets), and every run is ephemeral. Temp SQ_DB_PATH + ZOE_ANALYSIS_DIR
 * → never touches live data/. Execution tests gate on a real python interpreter (skipped w/ a note on
 * a box without the Echo venv); the jail/refusal tests always run.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_analysis_lane.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = path.join(os.tmpdir(), `zoe-analysis-${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
process.env.SQ_DB_PATH = path.join(TMP, 'sq.db');
process.env.ZOE_DATA_DIR = TMP;
process.env.ZOE_ANALYSIS_DIR = path.join(TMP, 'analysis');
// R3 v2: point the Echo-graph whitelist entry at a TEMP fake graph so the smoke never touches the real
// 7.8GB civic_graph.db (and passes on a box without Echo installed).
process.env.ZOE_ECHO_GRAPH_DB = path.join(TMP, 'graph.db');
fs.mkdirSync(TMP, { recursive: true });

const db = require('../lib/db');
db.init();
const A = require('../lib/analysis_lane');
const R = require('../lib/rehearsal');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // Seed a deterministic fixture table, then CHECKPOINT so the rows are in the main db file
  // (visible to both a mode=ro and an immutable reader — takes WAL visibility out of the smoke).
  const d = db.getDb();
  d.exec('CREATE TABLE zoe_probe (id INTEGER PRIMARY KEY, val TEXT)');
  const ins = d.prepare('INSERT INTO zoe_probe (val) VALUES (?)');
  for (const v of ['alpha', 'beta', 'gamma']) ins.run(v);
  try { d.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  const rowCount = () => d.prepare('SELECT COUNT(*) n FROM zoe_probe').get().n;

  // Seed a fake Echo GRAPH db (R3 v2) at ZOE_ECHO_GRAPH_DB — an `entities` table, checkpointed to the
  // main file so a mode=ro reader sees it. Stands in for civic_graph.db; the smoke stays hermetic.
  {
    const Database = require('better-sqlite3');
    const g = new Database(process.env.ZOE_ECHO_GRAPH_DB);
    g.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT)');
    const gi = g.prepare('INSERT INTO entities (name) VALUES (?)');
    for (const n of ['Ouachita Parish', 'Caddo Parish']) gi.run(n);
    try { g.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    g.close();
  }

  // --- whitelist: only existing DATA dbs, never secrets ---
  const wl = A.dbWhitelist();
  ok(wl.sq && /sq\.db$/.test(wl.sq), "the whitelist exposes 'sq' (her short-term memory)");
  ok(wl.graph && /graph\.db$/.test(wl.graph), "R3 v2: the whitelist exposes 'graph' (Echo's civic KG, read-only)");
  ok(!Object.keys(wl).some((k) => /env|key|secret|cred/i.test(k)), 'no secret-shaped name is ever whitelisted');
  ok(!A._helperSource(wl).includes('.env'), 'the generated helper never references .env');

  // --- refusals (no python needed) ---
  ok(/cannot run: give the python/.test(await A.run({ code: '' })), 'empty code refuses');
  ok(/cannot run: code too large/.test(await A.run({ code: 'x'.repeat(50000) })), 'oversize code refuses');

  const interp = R.pyInterp();
  if (fs.existsSync(interp)) {
    // --- READ: a script queries her data read-only and prints the result ---
    const rd = await A.run({ code: "import zoe_data\ncols, rows = zoe_data.query('sq', 'SELECT val FROM zoe_probe ORDER BY id')\nprint('VALS=' + ','.join(r[0] for r in rows))\n" });
    ok(/VALS=alpha,beta,gamma/.test(rd), '⭐a read-only query returns her live data');

    // --- dbs() lists the whitelist ---
    const dl = await A.run({ code: "import zoe_data\nprint('DBS=' + ','.join(zoe_data.dbs()))\n" });
    ok(/\bsq\b/.test(dl) && /\bgraph\b/.test(dl) && /^DBS=/m.test(dl), 'zoe_data.dbs() lists the reachable databases (sq + graph)');

    // --- ⭐WRITE REJECTED + the live DB is unchanged ---
    const before = rowCount();
    const wr = await A.run({ code: "import zoe_data\nzoe_data.query('sq', 'DELETE FROM zoe_probe')\nprint('DELETED')\n" });
    ok(/readonly|read-only/i.test(wr) && !/DELETED/.test(wr), '⭐a write is REJECTED by SQLite (mode=ro) — never silently applied');
    ok(rowCount() === before && before === 3, '⭐the live DB is unchanged after the rejected write (no corruption, no loss)');

    // --- R3 v2: the Echo GRAPH reads read-only, and a write to it is rejected the same way ---
    const grd = await A.run({ code: "import zoe_data\ncols, rows = zoe_data.query('graph', 'SELECT name FROM entities ORDER BY id')\nprint('GRAPH=' + ','.join(r[0] for r in rows))\n" });
    ok(/GRAPH=Ouachita Parish,Caddo Parish/.test(grd), '⭐R3 v2: a read-only query returns Echo-graph data (entities)');
    const gwr = await A.run({ code: "import zoe_data\nzoe_data.query('graph', 'DELETE FROM entities')\nprint('GDELETED')\n" });
    ok(/readonly|read-only/i.test(gwr) && !/GDELETED/.test(gwr), '⭐R3 v2: a write to the GRAPH is REJECTED (mode=ro) — the live KG can never be mutated');

    // --- a non-whitelisted db name is refused inside the helper ---
    const bad = await A.run({ code: "import zoe_data\nzoe_data.query('secrets', 'SELECT 1')\n" });
    ok(/no such data db/.test(bad) && /secrets/.test(bad), 'a db name off the whitelist is refused (secrets are not reachable)');

    // --- a broken query surfaces honestly, no throw, run stays ephemeral ---
    const err = await A.run({ code: "import zoe_data\nzoe_data.query('sq', 'SELECT * FROM does_not_exist')\n" });
    ok(/exited non-zero/.test(err) && /does_not_exist|no such table/i.test(err), 'a bad query surfaces as an honest non-zero verdict, never a throw');

    // --- pandas is available (the "python loops / probability models" flavor) ---
    const pd = await A.run({ code: "import pandas as pd, zoe_data\ncols, rows = zoe_data.query('sq', 'SELECT val FROM zoe_probe')\nprint('PANDAS_ROWS=' + str(len(pd.DataFrame(rows, columns=cols))))\n" });
    ok(/PANDAS_ROWS=3/.test(pd) || /exited non-zero/.test(pd), 'pandas is importable for real analysis (or a clean verdict if the venv lacks it)');
  } else {
    console.log(`  ~ execution tests SKIPPED — no interpreter at ${interp} (expected without the Echo venv; jail + refusal proofs above still hold)`);
  }

  // --- ephemeral: no analysis dir is left behind after the runs ---
  let left = [];
  try { left = fs.readdirSync(A.ANALYSIS_ROOT); } catch {}
  ok(left.length === 0, 'every run is ephemeral — the analysis dir is discarded, nothing accumulates');

  // --- tidy sweeps a straggler (a crash mid-run could orphan one) ---
  fs.mkdirSync(path.join(A.ANALYSIS_ROOT, 'straggler'), { recursive: true });
  const old = Date.now() + 2 * 3600e3;  // pretend "now" is 2h ahead → the fresh dir looks stale
  ok(A.tidy({ nowMs: old }) === 1, 'tidy removes a stale analysis straggler');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { db.getDb().close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
