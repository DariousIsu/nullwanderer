/**
 * lib/rehearsal.js — R1 of the rehearsal ladder (docs/REHEARSAL_SANDBOX_DESIGN.md): she can TRY a
 * change to her own code — in a COPY, judged by her own gate — and NOTHING here can adopt it.
 *
 * A sandbox = the source allowlist (self_source's jail, exactly) copied under data/rehearsal/<slug>/
 * with node_modules JUNCTIONED in, so the offline smoke gate runs inside the changed copy for real.
 * `edit` is her first Edit primitive and carries the same mechanical grounding contract my harness
 * enforces on me: the find-text must match EXACTLY ONCE in the target file — absent → "read the file
 * first"; ambiguous → "include more context". `test` runs the gate with cwd = the sandbox. `diff`
 * renders the honest change report. `discard` deletes. There is NO adopt() — a finished rehearsal
 * exits as a PROPOSAL (R2, not built) and code crosses into the live tree only through Lucas.
 *
 * Invariants (design §Invariants): live source stays read-only to every surface here; sandbox paths
 * never resolve outside their sandbox; ≤2 live sandboxes; stale (>48h) auto-discard on tidy; test
 * runs register on the workstream board (lane 'rehearsal'). ZOE_REHEARSAL_DIR overrides the root so
 * smokes never touch live data/. Fail-soft: refusals are plain strings, never throws.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const APP_ROOT = path.resolve(__dirname, '..');
const REHEARSAL_ROOT = process.env.ZOE_REHEARSAL_DIR || path.join(APP_ROOT, 'data', 'rehearsal');
const MAX_SANDBOXES = 2;
const STALE_MS = 48 * 3600e3;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function _dirOf(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!SLUG_RE.test(s)) return { dir: null, slug: s, reason: 'slug must be 1-40 chars of a-z 0-9 dash' };
  const dir = path.resolve(REHEARSAL_ROOT, s);
  if (!dir.startsWith(path.resolve(REHEARSAL_ROOT) + path.sep)) return { dir: null, slug: s, reason: 'slug escapes the rehearsal root' };
  return { dir, slug: s, reason: null };
}
function _marker(dir) { return path.join(dir, '.rehearsal.json'); }
function _readMarker(dir) { try { return JSON.parse(fs.readFileSync(_marker(dir), 'utf8')); } catch { return null; } }
function _touch(dir) { const m = _readMarker(dir) || {}; m.touchedTs = Date.now(); try { fs.writeFileSync(_marker(dir), JSON.stringify(m)); } catch {} }

// R2 — the Echo venv interpreter, resolved EXACTLY as main.js does for the gcal bridge (env override
// wins, else the venv under ECHO_CWD). A python tool in the sandbox is judged by a JS harness smoke
// that SHELLS this interpreter; test() hands the harness this path as ZOE_PY so the harness never
// has to guess where python lives. Pure — safe to call from a smoke without a live engine.
function pyInterp() {
  const cwd = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
  return process.env.ECHO_PYTHON || path.join(cwd, '.venv', 'Scripts', 'python.exe');
}

function list() {
  let out = [];
  try {
    for (const e of fs.readdirSync(REHEARSAL_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(REHEARSAL_ROOT, e.name);
      const m = _readMarker(dir);
      if (m) out.push({ slug: e.name, dir, createdTs: m.createdTs || 0, touchedTs: m.touchedTs || m.createdTs || 0 });
    }
  } catch {}
  return out;
}

// Copy the live source allowlist into a fresh sandbox + junction node_modules. Refuses over the cap.
function create({ slug } = {}) {
  const d = _dirOf(slug);
  if (!d.dir) return `cannot create: ${d.reason}`;
  tidy();
  const live = list();
  if (live.some((s) => s.slug === d.slug)) return `sandbox "${d.slug}" already exists — edit/test it, or discard first`;
  if (live.length >= MAX_SANDBOXES) return `already ${live.length} live sandboxes (max ${MAX_SANDBOXES}) — discard one first`;
  try {
    const ss = require('./self_source');
    const files = ss.allSourceFiles();
    fs.mkdirSync(d.dir, { recursive: true });
    let copied = 0;
    for (const abs of files) {
      const rel = path.relative(ss.ROOT, abs);
      const dst = path.join(d.dir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(abs, dst);
      copied++;
    }
    // node_modules rides as a JUNCTION (never a copy): the gate needs the deps, the sandbox never owns them.
    try { fs.symlinkSync(path.join(APP_ROOT, 'node_modules'), path.join(d.dir, 'node_modules'), 'junction'); } catch (e) { return `sandbox created but node_modules junction failed (${e.message}) — tests will not run; discard and retry`; }
    fs.writeFileSync(_marker(d.dir), JSON.stringify({ slug: d.slug, createdTs: Date.now(), touchedTs: Date.now() }));
    return `sandbox "${d.slug}" created — ${copied} source files copied to a working COPY (the live program is untouched). Edit with rehearsal_edit, judge with rehearsal_test.`;
  } catch (e) { return `create failed: ${e.message}`; }
}

// Resolve a repo-relative path INSIDE a sandbox (the sandbox's own jail).
function _sandboxFile(slug, rel) {
  const d = _dirOf(slug);
  if (!d.dir) return { abs: null, reason: d.reason };
  if (!fs.existsSync(_marker(d.dir))) return { abs: null, reason: `no sandbox "${d.slug}" — create it first` };
  const r = String(rel || '').trim().replace(/\\/g, '/');
  if (!r || path.isAbsolute(r) || /^[a-zA-Z]:/.test(r)) return { abs: null, reason: 'use a repo-relative path like lib/board.js' };
  const abs = path.resolve(d.dir, r);
  if (!abs.startsWith(d.dir + path.sep)) return { abs: null, reason: 'path escapes the sandbox' };
  if (/node_modules/i.test(r)) return { abs: null, reason: 'dependencies are a junction, not yours to edit' };
  return { abs, dir: d.dir, slug: d.slug, reason: null };
}

// Her Edit primitive — sandbox-only, exact-match-once (the mechanical grounding contract).
function edit({ slug, path: rel, find, replace } = {}) {
  const f = _sandboxFile(slug, rel);
  if (!f.abs) return `cannot edit: ${f.reason}`;
  if (!fs.existsSync(f.abs)) return `cannot edit: ${rel} is not in the sandbox (only source files were copied)`;
  const findS = String(find == null ? '' : find);
  if (findS.length < 4) return 'cannot edit: give the exact text to replace (at least a few characters — read the file first)';
  let text = '';
  try { text = fs.readFileSync(f.abs, 'utf8'); } catch (e) { return `cannot edit: ${e.message}`; }
  const n = text.split(findS).length - 1;
  if (n === 0) return `cannot edit: the find-text does not appear in ${rel} — read the file (source_read of the live one, or your sandbox copy) and match it EXACTLY`;
  if (n > 1) return `cannot edit: the find-text appears ${n} times in ${rel} — include more surrounding context so it matches exactly once`;
  try {
    fs.writeFileSync(f.abs, text.replace(findS, String(replace == null ? '' : replace)));
    _touch(f.dir);
    return `edited ${rel} in sandbox "${f.slug}" (one exact match replaced). Judge it with rehearsal_test.`;
  } catch (e) { return `edit failed: ${e.message}`; }
}

// R2 — CREATE a NEW file in the sandbox (her first authoring primitive beyond editing existing copies).
// DELIBERATELY NARROW: only a python tool (tools/<name>.py) or its harness (scripts/smoke_<name>.js).
// Everything else stays edit-only — writeFile can never plant a .js the live loader would run, only the
// new tool tree the sandbox owns. Create-only: changing a file that exists is rehearsal_edit's exact-
// match-once contract, never a blind overwrite. Same jail as edit (_sandboxFile blocks escapes + the
// node_modules junction); the pattern whitelist is the extra R2 fence.
const _NEW_FILE_OK = [/^tools\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\.py$/i, /^scripts\/smoke_[a-z0-9_]+\.js$/i];
function writeFile({ slug, path: rel, content } = {}) {
  const f = _sandboxFile(slug, rel);
  if (!f.abs) return `cannot write: ${f.reason}`;
  const r = String(rel || '').trim().replace(/\\/g, '/');
  if (!_NEW_FILE_OK.some((re) => re.test(r))) return 'cannot write: a NEW file may only be a python tool (tools/<name>.py) or its harness (scripts/smoke_<name>.js) — change existing source with rehearsal_edit';
  if (fs.existsSync(f.abs)) return `cannot write: ${r} already exists in sandbox "${f.slug}" — change it with rehearsal_edit (exact-match-once), not a blind overwrite`;
  const body = String(content == null ? '' : content);
  if (body.length < 1) return 'cannot write: give the file content';
  if (body.length > 200000) return 'cannot write: file too large (>200KB) — a tool this big is not a bounded rehearsal';
  try {
    fs.mkdirSync(path.dirname(f.abs), { recursive: true });
    fs.writeFileSync(f.abs, body);
    _touch(f.dir);
    const isPy = /\.py$/i.test(r);
    return `wrote ${r} (${body.length} chars) in sandbox "${f.slug}". ${isPy ? 'Write a harness (scripts/smoke_<name>.js) that shells it via process.env.ZOE_PY, then judge with rehearsal_test.' : 'This harness shells your python tool through process.env.ZOE_PY when rehearsal_test runs it.'}`;
  } catch (e) { return `write failed: ${e.message}`; }
}

// Judge the changed copy with HER OWN gate, cwd = the sandbox. Registers on the board.
function test({ slug, suite = null, timeoutMs = null } = {}) {
  return new Promise((resolve) => {
    const d = _dirOf(slug);
    if (!d.dir || !fs.existsSync(_marker(d.dir))) return resolve(`no sandbox "${String(slug)}" — create it first`);
    let script, ms;
    if (suite) {
      const name = String(suite).trim();
      if (!/^smoke_[a-z0-9_]+\.js$/.test(name)) return resolve(`not a valid suite name (smoke_*.js): ${name}`);
      script = path.join(d.dir, 'scripts', name);
      if (!fs.existsSync(script)) return resolve(`no such suite in the sandbox: scripts/${name}`);
      ms = timeoutMs || 90000;
    } else { script = path.join(d.dir, 'scripts', 'run_smokes.js'); ms = timeoutMs || 300000; }
    let boardId = null;
    try { boardId = require('./board').start({ lane: 'rehearsal', kind: suite ? 'test-suite' : 'test-gate', target: d.slug }).id; } catch {}
    const { execFile } = require('child_process');
    execFile(process.execPath, [script], {
      cwd: d.dir, timeout: ms, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      // ZOE_PY = the Echo venv interpreter, so a JS harness can SHELL a sandbox python tool (R2).
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZOE_PY: pyInterp() },
    }, (err, stdout, stderr) => {
      _touch(d.dir);
      const out = `${stdout || ''}${stderr ? '\n' + stderr : ''}`.trim();
      const tail = out.length > 4000 ? '…' + out.slice(-4000) : out;
      const verdict = err && err.killed ? `timed out after ${Math.round(ms / 1000)}s` : (err ? 'FAILED (non-zero exit)' : 'passed');
      try { require('./board').finish(boardId, { status: err ? 'failed' : 'done', note: verdict }); } catch {}
      resolve(`[sandbox "${d.slug}" gate ${verdict}]\n${tail || '(no output)'}`);
    });
  });
}

// The honest change report: which files differ from live, with compact -/+ lines.
function diff({ slug, maxChars = 8000 } = {}) {
  const d = _dirOf(slug);
  if (!d.dir || !fs.existsSync(_marker(d.dir))) return `no sandbox "${String(slug)}"`;
  const ss = require('./self_source');
  const parts = [];
  let changed = 0;
  for (const liveAbs of ss.allSourceFiles()) {
    const rel = path.relative(ss.ROOT, liveAbs);
    const sbAbs = path.join(d.dir, rel);
    let a = '', b = '';
    try { a = fs.readFileSync(liveAbs, 'utf8'); } catch { continue; }
    try { b = fs.readFileSync(sbAbs, 'utf8'); } catch { continue; }
    if (a === b) continue;
    changed++;
    const al = a.split('\n'), bl = b.split('\n');
    const lines = [`=== ${rel.replace(/\\/g, '/')}`];
    // Compact walk: emit the differing line runs (rehearsal edits are localized; this is a report, not a patch).
    let i = 0, j = 0;
    while ((i < al.length || j < bl.length) && lines.length < 60) {
      if (al[i] === bl[j]) { i++; j++; continue; }
      const ni = bl.indexOf(al[i], j), nj = al.indexOf(bl[j], i);
      if (al[i] !== undefined && (ni === -1 || (nj !== -1 && nj - i <= ni - j))) { lines.push(`- ${String(al[i]).slice(0, 160)}`); i++; }
      else { lines.push(`+ ${String(bl[j]).slice(0, 160)}`); j++; }
    }
    parts.push(lines.join('\n'));
  }
  if (!changed) return `sandbox "${d.slug}" has no changes vs the live source`;
  const text = `sandbox "${d.slug}" — ${changed} file(s) changed vs live:\n` + parts.join('\n\n');
  return text.length > maxChars ? text.slice(0, maxChars) + '\n…(diff truncated)' : text;
}

// Remove a sandbox dir. ⚠️THE 2026-07-22 INCIDENT LIVES HERE: rmSync recursed THROUGH the
// node_modules junction into the REAL dependency tree (.bin + early @-scopes were deleted before
// the running app's file locks stopped it; npm install restored). The junction now comes off FIRST
// (rmdirSync removes a Windows dir-junction as the LINK), and if anything named node_modules still
// remains that is not provably a link, we REFUSE to recurse — a stuck sandbox is recoverable, a
// deleted dependency tree is an outage.
function _rmSandbox(dir) {
  const nm = path.join(dir, 'node_modules');
  try { fs.rmdirSync(nm); } catch {}
  if (fs.existsSync(nm)) {
    let st = null; try { st = fs.lstatSync(nm); } catch {}
    if (!st || !st.isSymbolicLink()) throw new Error('refusing to remove: sandbox node_modules is not a link — manual cleanup required');
    try { fs.unlinkSync(nm); } catch {}
    if (fs.existsSync(nm)) throw new Error('refusing to remove: sandbox node_modules link could not be detached');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

function discard({ slug } = {}) {
  const d = _dirOf(slug);
  if (!d.dir) return `cannot discard: ${d.reason}`;
  if (!fs.existsSync(_marker(d.dir))) return `no sandbox "${d.slug}"`;
  try {
    _rmSandbox(d.dir);
    return `sandbox "${d.slug}" discarded`;
  } catch (e) { return `discard failed: ${e.message}`; }
}

// Retire stale sandboxes (>48h untouched). Returns how many.
function tidy({ nowMs = Date.now() } = {}) {
  let n = 0;
  for (const s of list()) {
    if (nowMs - (s.touchedTs || 0) > STALE_MS) { try { _rmSandbox(s.dir); n++; } catch {} }
  }
  return n;
}

module.exports = { REHEARSAL_ROOT, MAX_SANDBOXES, STALE_MS, create, edit, writeFile, test, diff, discard, tidy, list, pyInterp };
