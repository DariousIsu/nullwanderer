/**
 * lib/analysis_lane.js — R3: the ONE-OFF ANALYSIS lane ("making + running her own scripts like you
 * do", Lucas). R2 builds permanent TOOLS (proposal cards → adoption); this runs a THROWAWAY python
 * analysis against her live data READ-ONLY and hands back the RESULT. No adoption — the script is
 * ephemeral, the answer is the point.
 *
 * ⭐THE RELAXATION (Lucas's explicit call, 2026-07-23 — "read-only live DBs"): analysis needs the
 * data, so this lane opens the WHITELISTED data databases READ-ONLY. The source read-jail keeps
 * data/ unreachable to her BROWSING surface; this EXECUTE surface deliberately points a script at
 * the data — the same posture as rehearsal.test already running arbitrary sandbox code.
 *
 * ⭐THE LOAD-BEARING SAFETY PROPERTY: the lane can never WRITE or corrupt a live DB. The generated
 * helper opens each DB with SQLite mode=ro (falling back to immutable=1 on a hot WAL), so every
 * write attempt is rejected by SQLite itself; WAL readers are non-blocking, so an analysis never
 * stalls the live writer. The DB paths are BAKED INTO the helper, never handed to the script's env,
 * so a raw read-write open is not one accidental os.environ away. Secrets (.env, keychain) are NEVER
 * whitelisted — only the named data DBs. Ephemeral + jailed: each run gets a throwaway dir under
 * ANALYSIS_ROOT, discarded after; bounded by a hard timeout and a captured-output cap. Fail-soft:
 * refusals are plain strings, never throws.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.ZOE_DATA_DIR || path.join(APP_ROOT, 'data');
const ANALYSIS_ROOT = process.env.ZOE_ANALYSIS_DIR || path.join(DATA_DIR, 'analysis');
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 180000;
const OUTPUT_CAP = 12000;
const CODE_CAP = 40000;
const STALE_MS = 3600e3;   // an analysis dir older than an hour is a straggler

function _pyInterp() { try { return require('./rehearsal').pyInterp(); } catch { return process.env.ECHO_PYTHON || 'python'; } }

// The read-only DATA databases this lane exposes. Only files that EXIST are offered; secrets never.
//  • sq  = her short-term memory (Side Quest's own data DB).
//  • graph = Echo's LIVE civic knowledge graph (R3 v2) — entities/relations/facts, the store her
//    research builds into (v1 reached it only through Echo's MCP read tools). ONLY the graph file is
//    whitelisted — NOT Echo's saga.db (operational/session data) and NEVER the keychain/.env. Verified:
//    61 tables, zero secret-shaped. The helper's mode=ro makes every write SQLite-rejected; a runaway
//    query is bounded by the run timeout + output cap. Override the path with ZOE_ECHO_GRAPH_DB.
function dbWhitelist() {
  const out = {};
  const sq = process.env.SQ_DB_PATH || path.join(DATA_DIR, 'sq.db');
  if (fs.existsSync(sq)) out.sq = sq;
  const echoCwd = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
  const graph = process.env.ZOE_ECHO_GRAPH_DB || path.join(echoCwd, 'data', 'foundations', 'civic_graph.db');
  if (fs.existsSync(graph)) out.graph = graph;
  return out;
}

// The helper the script imports (zoe_data). Paths are BAKED IN (not env) — the only sanctioned data
// access is zoe_data.query(db, sql, params), read-only by construction.
function _helperSource(whitelist) {
  const json = JSON.stringify(whitelist).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return [
    'import json, sqlite3',
    `_DBS = json.loads('${json}')`,
    'def _open(p):',
    "    try: return sqlite3.connect('file:' + p + '?mode=ro', uri=True)",
    "    except sqlite3.OperationalError: return sqlite3.connect('file:' + p + '?immutable=1', uri=True)",
    'def dbs():',
    '    return sorted(_DBS.keys())',
    'def query(db, sql, params=()):',
    '    if db not in _DBS: raise KeyError("no such data db: " + str(db) + " (have: " + ", ".join(sorted(_DBS)) + ")")',
    '    con = _open(_DBS[db])',
    '    try:',
    '        cur = con.execute(sql, tuple(params))',
    '        cols = [d[0] for d in cur.description] if cur.description else []',
    '        return cols, cur.fetchall()',
    '    finally:',
    '        con.close()',
    '',
  ].join('\n');
}

function _newDir() {
  fs.mkdirSync(ANALYSIS_ROOT, { recursive: true });
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(ANALYSIS_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

// Run a one-off python analysis READ-ONLY over the whitelisted data DBs. Returns the captured output
// (her result), or an honest refusal/verdict string. Ephemeral: the dir is discarded after.
function run({ code, timeoutMs = null } = {}) {
  return new Promise((resolve) => {
    const src = String(code == null ? '' : code);
    if (src.trim().length < 1) return resolve('cannot run: give the python analysis code');
    if (src.length > CODE_CAP) return resolve(`cannot run: code too large (>${CODE_CAP} chars) — a one-off analysis should be bounded`);
    const whitelist = dbWhitelist();
    if (!Object.keys(whitelist).length) return resolve('cannot run: no data databases are available to analyze');
    let dir, id;
    try { ({ dir, id } = _newDir()); } catch (e) { return resolve(`cannot run: ${e.message}`); }
    try {
      fs.writeFileSync(path.join(dir, 'zoe_data.py'), _helperSource(whitelist));
      fs.writeFileSync(path.join(dir, 'analysis.py'), src);
    } catch (e) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} return resolve(`cannot run: ${e.message}`); }
    const ms = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    const { execFile } = require('child_process');
    // env carries NO db paths (baked into the helper) — only what python needs to start.
    execFile(_pyInterp(), ['analysis.py'], {
      cwd: dir, timeout: ms, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }, (err, stdout, stderr) => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      const out = `${stdout || ''}${stderr ? '\n' + stderr : ''}`.trim();
      const tail = out.length > OUTPUT_CAP ? out.slice(0, OUTPUT_CAP) + '\n…(output truncated)' : out;
      if (err && err.killed) return resolve(`[analysis timed out after ${Math.round(ms / 1000)}s]\n${tail}`);
      if (err) return resolve(`[analysis exited non-zero — a bug in the script or the query]\n${tail || '(no output)'}`);
      return resolve(tail || '(the analysis produced no output — did it print its result?)');
    });
  });
}

// Sweep stray analysis dirs (a crash mid-run could orphan one). Returns how many removed.
function tidy({ nowMs = Date.now() } = {}) {
  let n = 0;
  let entries = [];
  try { entries = fs.readdirSync(ANALYSIS_ROOT, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(ANALYSIS_ROOT, e.name);
    let mtime = 0; try { mtime = fs.statSync(dir).mtimeMs; } catch {}
    if (nowMs - mtime > STALE_MS) { try { fs.rmSync(dir, { recursive: true, force: true }); n++; } catch {} }
  }
  return n;
}

module.exports = { ANALYSIS_ROOT, DEFAULT_TIMEOUT_MS, run, tidy, dbWhitelist, _helperSource };
