/**
 * lib/sidecar.js — the JS ⇄ Python SIDECAR bridge. The main process calls the forecasting model POOL here:
 * spawns `sidecar/orchestrator.py` with a job (piped to stdin), parses the ModelResults JSON (from stdout).
 *
 * This is the ONE seam between the fast JS layer and the heavy Python model layer (docs/FORECAST_SIDECAR_DESIGN.md).
 * Fail-soft by design: if Python or the sidecar is absent / errors / times out, it returns {ok:false,error} and
 * the JS machine degrades gracefully (keeps its own fast forecast) — the sidecar is never a hard dependency.
 * `execFile` is injected so the whole thing is offline-testable with a fake child (no Python needed for the smoke).
 */
'use strict';

const path = require('path');
const SIDECAR_DIR = path.join(__dirname, '..', 'sidecar');

// python launcher preference: SIDECAR_PYTHON env → the venv → common launchers. First that works wins at spawn.
function pythonCandidates() {
  const out = [];
  if (process.env.SIDECAR_PYTHON) out.push(process.env.SIDECAR_PYTHON);
  out.push(path.join(SIDECAR_DIR, '.venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python'));
  out.push('python', 'python3', 'py');
  return out;
}

// one spawn attempt against a specific python. Resolves to the result object or {ok:false,error} (error carries
// the raw message so the caller can tell "python not found" from a real orchestrator failure).
function _tryRun(execFile, py, job, opts) {
  const cwd = opts.cwd || SIDECAR_DIR;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = execFile(py, ['orchestrator.py'], { cwd, timeout: opts.timeoutMs || 120000, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return finish({ ok: false, error: String(stderr || err.message || 'spawn failed').slice(0, 500) });
          try { finish(JSON.parse(stdout)); }
          catch (e) { finish({ ok: false, error: 'parse: ' + e.message, raw: String(stdout).slice(0, 200) }); }
        });
    } catch (e) {
      return finish({ ok: false, error: 'exec: ' + e.message });
    }
    try { child.stdin.write(JSON.stringify(job)); child.stdin.end(); }
    catch (e) { finish({ ok: false, error: 'stdin: ' + e.message }); }
  });
}

const _MISSING_PY = /ENOENT|not found|cannot find|no such file|spawn.*fail/i;   // "python isn't here" → try the next candidate

/**
 * Run the model pool once. job = { inputs, models?, config? }.
 * opts: { python?, execFile?, timeoutMs?, cwd? }. Tries the python candidates in order (venv → launchers),
 * skipping any that aren't installed; a REAL orchestrator error stops the search. → result object | {ok:false,error}.
 */
async function runModels(job, opts = {}) {
  const execFile = opts.execFile || require('child_process').execFile;
  const candidates = opts.python ? [opts.python] : pythonCandidates();
  let lastErr = 'no python found';
  for (const py of candidates) {
    const r = await _tryRun(execFile, py, job, opts);
    if (!r || r.ok !== false) return r;                 // success (orchestrator ran)
    lastErr = r.error;
    if (!_MISSING_PY.test(r.error || '')) return r;      // a real failure (python ran but errored) → stop, don't mask it
  }
  return { ok: false, error: lastErr };
}

// list the models the sidecar has registered (fail-soft → []).
function listModels(opts = {}) {
  const execFile = opts.execFile || require('child_process').execFile;
  const py = opts.python || pythonCandidates().find(Boolean);
  return new Promise((resolve) => {
    try {
      execFile(py, ['orchestrator.py', '--list'], { cwd: opts.cwd || SIDECAR_DIR, timeout: opts.timeoutMs || 15000 },
        (err, stdout) => { if (err) return resolve([]); try { resolve(JSON.parse(stdout).models || []); } catch { resolve([]); } });
    } catch { resolve([]); }
  });
}

module.exports = { SIDECAR_DIR, pythonCandidates, runModels, listModels };
