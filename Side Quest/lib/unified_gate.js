'use strict';
/*
 * lib/unified_gate.js — stage 5 (2026-09-04): ONE gate over BOTH suites, gated by exit code PER SIDE.
 *
 * Lucas's stage-5 call (keep two runtimes; unify the gate + the pen): a single op runs the Side Quest
 * smoke gate (scripts/run_smokes.js, exit 0/1) AND the Echo pytest gate (python -m pytest -q, with the
 * live/voice tests deselected by Echo's own conftest, preceded by the ruff F821 undefined-name check that
 * pyproject already declares a gate) and ANDs their exit codes — the run is green only when EVERY side it
 * was asked to check is green. The pen runs the side(s) a change TOUCHES (an SQ-only fix never pays Echo's
 * ~140s pytest); a manual `npm run gate` runs both. This only TESTS — Echo commits stay LOCAL by the
 * topology law, and nothing here commits or pushes. exec is injected so the smoke drives it offline.
 *
 * WHY a JS module and not an Echo run-script: Side Quest's pen/apply pipeline is the caller that must AND
 * the two exit codes, and Echo has no gate wrapper today (raw `pytest`). This is that wrapper, on the side
 * that needs the verdict.
 */
const path = require('path');
const { execFile } = require('child_process');

const SQ_ROOT = path.resolve(__dirname, '..');
const ECHO_ROOT = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const ECHO_PY = () => process.env.ECHO_PYTHON || path.join(ECHO_ROOT, '.venv', 'Scripts', 'python.exe');
const GATE_TIMEOUT_MS = 900000;   // 15 min — the full Echo pytest is ~140s, the SQ gate a few minutes
// The SQ smoke gate needs the ELECTRON binary (better-sqlite3 is built for Electron's ABI). Inside the
// live app process.execPath IS electron; under plain `npm run gate` it is node, so fall back to the dist
// binary. Either way ELECTRON_RUN_AS_NODE=1 makes it run the script as node.
const ELECTRON_BIN = () => (process.versions.electron ? process.execPath : path.join(SQ_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'));

function _run(cmd, args, { cwd, timeoutMs = GATE_TIMEOUT_MS, env = {}, exec = null } = {}) {
  const ex = exec || execFile;
  return new Promise((resolve) => {
    try {
      ex(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 48 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, ...env } },
        (err, stdout, stderr) => resolve({ code: err ? (err.code == null ? 1 : err.code) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    } catch (e) { resolve({ code: 1, stdout: '', stderr: (e && e.message) || String(e) }); }
  });
}

/** The Side Quest smoke gate (scripts/run_smokes.js under electron-as-node). Exit code is the verdict. */
async function runSqGate({ deps = {}, timeoutMs = GATE_TIMEOUT_MS } = {}) {
  const r = await _run(ELECTRON_BIN(), [path.join(SQ_ROOT, 'scripts', 'run_smokes.js')],
    { cwd: SQ_ROOT, timeoutMs, env: { ELECTRON_RUN_AS_NODE: '1', ZOE_EMBED_REF: '1' }, exec: deps.exec });
  const m = r.stdout.match(/(\d+)\s+suites?\s+passed,\s+(\d+)\s+failed/i);
  return { side: 'sq', ok: r.code === 0, code: r.code,
    summary: m ? `${m[1]} suites passed, ${m[2]} failed` : (r.code === 0 ? 'green' : 'red'),
    tail: (r.stdout + r.stderr).slice(-600) };
}

/** The Echo gate: ruff F821 (fast, undefined names) then `python -m pytest -q` (live/voice deselected by
 *  conftest). Runs in ECHO_ROOT. A ruff failure short-circuits — an undefined name would break every test. */
async function runEchoGate({ deps = {}, timeoutMs = GATE_TIMEOUT_MS, ruff = true } = {}) {
  const py = ECHO_PY();
  if (ruff) {
    const rf = await _run(py, ['-m', 'ruff', 'check', 'echo/', '--select', 'F821'], { cwd: ECHO_ROOT, timeoutMs: 120000, exec: deps.exec });
    if (rf.code !== 0) return { side: 'echo', ok: false, code: rf.code, summary: 'ruff F821 failed (undefined name)', tail: (rf.stdout + rf.stderr).slice(-600) };
  }
  const r = await _run(py, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], { cwd: ECHO_ROOT, timeoutMs, exec: deps.exec });
  const m = r.stdout.match(/(\d+)\s+passed(?:,\s+(\d+)\s+deselected)?/);
  const bad = /(\d+)\s+failed|(\d+)\s+error/i.test(r.stdout);
  return { side: 'echo', ok: r.code === 0, code: r.code,
    summary: m ? `${m[1]} passed${m[2] ? `, ${m[2]} deselected` : ''}${bad ? ' — FAILURES' : ''}` : (r.code === 0 ? 'green' : 'red'),
    tail: (r.stdout + r.stderr).slice(-700) };
}

/**
 * Run the gate over the requested sides and AND their verdicts. `sides` ⊆ {'sq','echo'}; default both.
 * Returns { sq, echo, sides, ok } where each side is the per-side result (null if not requested) and ok is
 * true only when every requested side is green. Runs SQ then Echo (SQ is faster, so a red SQ surfaces first).
 */
async function runGate({ sides = ['sq', 'echo'], deps = {}, timeoutMs, ruff = true } = {}) {
  const want = (Array.isArray(sides) ? sides : [sides]).filter((s) => s === 'sq' || s === 'echo');
  const out = { sq: null, echo: null, sides: want, ok: false };
  if (want.includes('sq')) out.sq = await runSqGate({ deps, timeoutMs });
  if (want.includes('echo')) out.echo = await runEchoGate({ deps, timeoutMs, ruff });
  const checked = want.map((s) => out[s]).filter(Boolean);
  out.ok = checked.length > 0 && checked.every((s) => s.ok);
  return out;
}

/** Which side(s) a set of touched paths (absolute, or repo-relative to SQ) belongs to — so the pen gates
 *  only what a change touched. A path under ECHO_ROOT is 'echo'; anything else is 'sq'. */
function sidesForPaths(paths) {
  const echoRoot = path.resolve(ECHO_ROOT).toLowerCase();
  const set = new Set();
  for (const p of (paths || [])) {
    if (!p) continue;
    const abs = path.resolve(SQ_ROOT, p).toLowerCase();   // resolve SQ-relative; absolute stays absolute
    set.add((abs === echoRoot || abs.startsWith(echoRoot + path.sep)) ? 'echo' : 'sq');
  }
  return [...set];
}

/** A one-line human summary of a runGate result, for a log or the operator card. */
function describe(result) {
  const parts = [];
  for (const s of (result.sides || [])) { const r = result[s]; if (r) parts.push(`${s.toUpperCase()} ${r.ok ? '✓' : '✗'} (${r.summary})`); }
  return `${result.ok ? 'GATE GREEN' : 'GATE RED'} — ${parts.join(' · ')}`;
}

module.exports = { runGate, runSqGate, runEchoGate, sidesForPaths, describe, SQ_ROOT, ECHO_ROOT, ECHO_PY, GATE_TIMEOUT_MS };
