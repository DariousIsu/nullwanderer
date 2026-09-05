/**
 * lib/self_source.js — READ-ONLY access to her OWN SOURCE + the offline verification gate
 * (slice 3a, 2026-07-22 — the last driver's-seat organs: "how am I coded" and "am I healthy").
 *
 * The audit's goal-3 finding: she had a changelog (self_dev) but NO access to her own source — "how
 * am I coded" was unanswerable, and goal-4's self-repair ladder has to START with grounded reading.
 * These surfaces close the read half (M2.5.1 "un-jail the reader" — donor specs O2 cursors +
 * O3 repo-map, ORGAN_DONOR_REGISTRY_2026-08-03.md):
 *   sourceMap()     — the RANKED file map (inbound-require rank, fit to a char budget — never an
 *                     alphabetical truncation showing 46 of 1,100 files); async, scans off-thread;
 *   readSource()    — one file, CURSOR-PAGED: a cap is a page size only because offset exists, and
 *                     the truncation note names the exact next call with values;
 *   searchSource()  — grep across ALL her source (root-first, no silent file cap); async, the scan
 *                     runs in a worker thread — the old 500-file cap was a main-thread guard;
 *   sourceOutline() — one file's symbols + line/char addresses ("navigate main.js before reading it");
 *   selfTest()      — run the offline smoke gate: one suite in seconds, or the full curated gate.
 *                     THE honest answer to "am I healthy?" — the same oracle the build lane trusts.
 *
 * ⭐THE JAIL IS THE CONTRACT. Read-only by construction (no write surface exists here), and pathing
 * is allowlist-first: only source/docs extensions, only source directories, resolved paths must stay
 * under the app root, and data/ (databases), .env* (SECRETS — the one file that must never be
 * readable from any model-reachable surface), logs, node_modules, and .git are denied by NAME at any
 * depth. An escape attempt returns a plain refusal string, never a throw. Pure-testable jail
 * (scripts/smoke_self_source.js drives every escape shape).
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const ALLOW_DIRS = ['lib', 'studio', 'scripts', 'renderer', 'docs'];
const ALLOW_EXT = new Set(['.js', '.md', '.json', '.html', '.css', '.txt']);
const DENY_NAMES = new Set(['node_modules', 'data', '.git', 'logs_archive', 'notes', '.claude']);
const DENY_FILE_RE = /^\.env|\.log$|^package-lock\.json$|^sq\.db|\.db$|\.sqlite/i;

// Resolve a caller-supplied relative path into a SAFE absolute path, or null with a reason.
function resolveSafe(rel) {
  const s = String(rel || '').trim().replace(/\\/g, '/');
  if (!s) return { abs: null, reason: 'empty path' };
  if (path.isAbsolute(s) || /^[a-zA-Z]:/.test(s)) return { abs: null, reason: 'absolute paths are not allowed — use a repo-relative path like lib/board.js' };
  const abs = path.resolve(ROOT, s);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return { abs: null, reason: 'path escapes the app root' };
  const relParts = path.relative(ROOT, abs).split(path.sep);
  for (const part of relParts) {
    if (DENY_NAMES.has(part.toLowerCase())) return { abs: null, reason: `"${part}" is off-limits (data/secrets/dependencies are not source)` };
    if (DENY_FILE_RE.test(part)) return { abs: null, reason: `"${part}" is off-limits (secrets, logs, and databases are never readable here)` };
  }
  const topOk = relParts.length === 1 || ALLOW_DIRS.includes(relParts[0]);
  if (!topOk) return { abs: null, reason: `only ${ALLOW_DIRS.join('/')} and root files are source` };
  if (!ALLOW_EXT.has(path.extname(abs).toLowerCase())) return { abs: null, reason: `only ${[...ALLOW_EXT].join(' ')} files are source` };
  return { abs, reason: null };
}

function _walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (DENY_NAMES.has(e.name.toLowerCase()) || DENY_FILE_RE.test(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) _walk(abs, out);
    else if (ALLOW_EXT.has(path.extname(e.name).toLowerCase())) out.push(abs);
  }
}

function _allSourceFiles() {
  const out = [];
  for (const d of ALLOW_DIRS) _walk(path.join(ROOT, d), out);
  try {
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (e.isFile() && ALLOW_EXT.has(path.extname(e.name).toLowerCase()) && !DENY_FILE_RE.test(e.name)) out.push(path.join(ROOT, e.name));
    }
  } catch {}
  return out;
}

// Root-first file order (O2/O3): root entry files, then lib, then the rest — a bounded scan or a
// budget-fit map spends itself on the code the program actually runs on, never docs first.
function _orderedSourceFiles() {
  const out = [];
  try {
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (e.isFile() && ALLOW_EXT.has(path.extname(e.name).toLowerCase()) && !DENY_FILE_RE.test(e.name)) out.push(path.join(ROOT, e.name));
    }
  } catch {}
  for (const d of ALLOW_DIRS) _walk(path.join(ROOT, d), out);
  return out;
}

// Per-file meta, cached against mtime (the aider trick — rebuilds are cheap because unchanged
// files never get re-read): header line, require targets, top-level symbols with line AND char
// addresses (the char address is what makes outline → source_read offset a working loop).
const _metaCache = new Map();   // abs → { mtime, kb, chars, lineCount, header, requires, symbols }
const _SYM_RE = /^(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(|^class\s+[A-Za-z_$][\w$]*|^const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)|^module\.exports\b/;
function _fileMeta(abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  const hit = _metaCache.get(abs);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  const head = text.slice(0, 600);
  const hm = head.match(/\/\*\*?\s*\n?\s*\*?\s*([^\n*][^\n]*)/) || head.match(/^\/\/\s*(.+)$/m) || head.match(/^#\s*(.+)$/m);
  const dir = path.dirname(abs);
  const requires = [];
  const reqRe = /require\('(\.\.?\/[^']+)'\)/g;
  for (let m; (m = reqRe.exec(text)); ) {
    let t = path.resolve(dir, m[1]);
    if (!path.extname(t)) t += '.js';
    requires.push(t);
  }
  const symbols = [];
  const lines = text.split('\n');
  for (let i = 0, off = 0; i < lines.length; off += lines[i].length + 1, i++) {
    if (_SYM_RE.test(lines[i])) symbols.push({ line: i + 1, off, sig: lines[i].trim().slice(0, 110) });
    else if (/^\/\/ [═─]{3,}/.test(lines[i])) symbols.push({ line: i + 1, off, sig: lines[i].slice(0, 90) });
  }
  const meta = {
    mtime: st.mtimeMs, kb: Math.max(1, Math.round(st.size / 1024)), chars: text.length,
    lineCount: lines.length, header: hm ? hm[1].replace(/\s+/g, ' ').trim().slice(0, 120) : '',
    requires, symbols,
  };
  _metaCache.set(abs, meta);
  return meta;
}

// "How am I coded" — the map, RANKED-AND-FIT (O3). Rank = how much the rest of the program leans
// on the module (inbound requires), entry files first; fit = include ranked lines until the budget,
// then say exactly how many fell below the cut and how to reach them. Docs sink (nothing requires
// a doc); an optional focus pulls topically-matching files up.
function _mapCore({ maxChars = 9000, focus = '' } = {}) {
  const files = _orderedSourceFiles();
  const metas = new Map();
  for (const abs of files) { const meta = _fileMeta(abs); if (meta) metas.set(abs, meta); }
  const inbound = new Map();   // distinct requiring MODULES ("used by N"), not raw require() occurrences
  for (const meta of metas.values()) for (const t of new Set(meta.requires)) inbound.set(t, (inbound.get(t) || 0) + 1);
  const focusToks = String(focus || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  // THE ORGAN ATLAS (cut 11): the organ a focus names leads the map, whatever its inbound rank.
  const organBoost = (() => { try { return focus ? require('./organ_atlas').rankBoost(focus) : null; } catch { return null; } })();
  const rows = [];
  for (const [abs, meta] of metas) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '(root)';
    let score = (inbound.get(abs) || 0) * 10;
    if (top === '(root)' && rel.endsWith('.js')) score += 50;   // root scripts lead their band
    if (rel === 'main.js') score += 1000;                       // THE entry point: nothing requires it, everything runs through it — it always ranks
    if (top === 'lib') score += 5;                              // the organ shelf beats docs at equal rank
    if (focusToks.length) {
      const hay = (rel + ' ' + meta.header).toLowerCase();
      for (const t of focusToks) if (hay.includes(t)) score += 25;
    }
    if (organBoost && rel === organBoost.rel) score += organBoost.boost;
    rows.push({ rel, meta, score, used: inbound.get(abs) || 0 });
  }
  rows.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  const parts = [`YOUR SOURCE — ${rows.length} files, ranked by how much the rest of the program leans on each${focusToks.length ? `, pulled toward "${String(focus).slice(0, 60)}"` : ''} (read one: source_read {"path"[, "offset"]} · search all: source_search · one file's symbols: source_outline):`];
  let used = parts[0].length, omitted = 0;
  for (const r of rows) {
    const line = `  ${r.rel} (${r.meta.kb}KB${r.used ? `, used by ${r.used}` : ''})${r.meta.header ? ` — ${r.meta.header}` : ''}`;
    if (used + line.length + 130 > maxChars) { omitted++; continue; }
    parts.push(line); used += line.length + 1;
  }
  if (omitted) parts.push(`…(${omitted} lower-ranked files below the ${maxChars}-char fit — source_search finds anything by content)`);
  return parts.join('\n');
}

// One file, CURSOR-PAGED (O2): the cap is a page size because offset exists, page 2 really is
// page 2, and the truncation note names the exact continuation call with values.
function readSource(rel, { offset = 0, maxChars = 24000 } = {}) {
  const { abs, reason } = resolveSafe(rel);
  if (!abs) return `not readable: ${reason}`;
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return `not readable: ${e.code === 'ENOENT' ? 'no such file' : e.message}`; }
  const relN = String(rel).trim().replace(/\\/g, '/');
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  if (text.length && off >= text.length) return `offset ${off} is past the end — ${relN} is ${text.length} chars; the last page starts at ${Math.max(0, text.length - maxChars)}`;
  const slice = text.slice(off, off + maxChars);
  const end = off + slice.length;
  const head = off > 0 ? `…(${relN} continuing from char ${off} of ${text.length})\n` : '';
  if (end >= text.length) return head + slice;
  return head + slice + `\n…(chars ${off}-${end} of ${text.length} — call source_read {"path":"${relN}","offset":${end}} for the next section, or source_outline {"path":"${relN}"} to jump by symbol)`;
}

// Grep across ALL her source (O2: bound the RESULTS, never the corpus — the old 500-file cap
// silently hid half the repo). Sync core; the public surface runs it in a worker thread.
function _searchCore(pattern, { maxMatches = 40 } = {}) {
  const p = String(pattern || '').trim();
  if (p.length < 2) return 'give a search pattern of at least 2 characters';
  let re;
  try { re = new RegExp(p, 'i'); } catch { re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const files = _orderedSourceFiles();
  const hits = [];
  for (const abs of files) {
    if (hits.length >= maxMatches) break;
    let text = ''; try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (!re.test(text)) continue;
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < maxMatches; i++) {
      if (re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
    }
  }
  return hits.length
    ? hits.join('\n') + (hits.length >= maxMatches ? `\n…(stopped at ${maxMatches} matches — narrow the pattern to see the rest)` : '')
    : `no matches for "${p}" in her source (all ${files.length} files scanned)`;
}

// The heavy readers run OFF the main thread (O2: the old file cap was a main-thread guard — move
// the work, don't shrink it). A worker re-runs this module with workerData set (see entry at the
// bottom); on any worker failure the sync core answers from the main thread — correct, just slower.
function _inWorker(op, payload, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const { Worker } = require('worker_threads');
      const w = new Worker(__filename, { workerData: { __selfSource: op, payload } });
      const t = setTimeout(() => { try { w.terminate(); } catch {} done(fallback()); }, 30000);
      t.unref?.();
      w.once('message', (v) => { clearTimeout(t); try { w.terminate(); } catch {} done(v); });
      w.once('error', () => { clearTimeout(t); done(fallback()); });
    } catch { done(fallback()); }
  });
}
async function searchSource(pattern, opts = {}) {
  return _inWorker('search', { pattern: String(pattern || ''), opts: { maxMatches: opts.maxMatches } }, () => _searchCore(pattern, opts));
}
async function sourceMap(opts = {}) {
  return _inWorker('map', { opts: { maxChars: opts.maxChars, focus: opts.focus } }, () => _mapCore(opts));
}

// One file's symbol map (O3): top-level definitions + section banners, line- AND char-addressed —
// navigate a 1MB file before paging through it. "@N" is the char offset: source_read with that
// offset starts exactly there.
function sourceOutline(rel, { maxChars = 20000 } = {}) {
  const { abs, reason } = resolveSafe(rel);
  if (!abs) return `not readable: ${reason}`;
  const meta = _fileMeta(abs);
  if (!meta) return 'not readable: no such file';
  const relN = path.relative(ROOT, abs).replace(/\\/g, '/');
  const header = `OUTLINE ${relN} — ${meta.lineCount} lines, ${meta.chars} chars${meta.header ? ` — ${meta.header}` : ''}\n(each entry is "L<line> @<char>: signature" — source_read {"path":"${relN}","offset":<char>} starts reading exactly there)`;
  if (!meta.symbols.length) return `${header}\n(no top-level symbols found — likely data or prose; source_read it directly)`;
  const render = (rs) => rs.map((s) => `  L${s.line} @${s.off}: ${s.sig}`).join('\n');
  let rows = meta.symbols, note = '';
  let body = render(rows);
  if (header.length + body.length > maxChars) {           // fit: definitions outrank banners
    rows = rows.filter((s) => !s.sig.startsWith('//'));
    body = render(rows);
  }
  if (header.length + body.length > maxChars) {           // still over: keep the head, name the cut
    const keep = Math.max(1, Math.floor(rows.length * (maxChars - header.length) / body.length));
    note = `\n…(${rows.length - keep} more symbols past line ${rows[keep - 1].line} — continue with source_read {"path":"${relN}","offset":${rows[keep - 1].off}} or narrow with source_search)`;
    rows = rows.slice(0, keep);
    body = render(rows);
  }
  return `${header}\n${body}${note}`;
}

// "Am I healthy?" — the offline gate. One suite (seconds) or the full curated gate (minutes).
// Runs through her own binary with ELECTRON_RUN_AS_NODE (the same rail the build lane uses).
function selfTest({ suite = null, timeoutMs = null } = {}) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    let script, ms;
    if (suite) {
      const name = String(suite).trim();
      if (!/^smoke_[a-z0-9_]+\.js$/.test(name)) return resolve(`not a valid suite name (smoke_*.js): ${name}`);
      const abs = path.join(ROOT, 'scripts', name);
      if (!fs.existsSync(abs)) return resolve(`no such suite: scripts/${name}`);
      script = abs; ms = timeoutMs || 90000;
    } else {
      script = path.join(ROOT, 'scripts', 'run_smokes.js'); ms = timeoutMs || 300000;
    }
    execFile(process.execPath, [script], {
      cwd: ROOT, timeout: ms, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr ? '\n' + stderr : ''}`.trim();
      const tail = out.length > 4000 ? '…' + out.slice(-4000) : out;
      if (err && err.killed) return resolve(`the gate run timed out after ${Math.round(ms / 1000)}s — partial output:\n${tail}`);
      // A failing gate EXITS non-zero — that is a result, not an error; the tail carries the verdict.
      resolve(tail || (err ? `gate run failed: ${err.message}` : '(no output)'));
    });
  });
}

// ── SELF-CODE-REVIEW INTENT ────────────────────────────────────────────────────────────────────
// Detect a request to REVIEW / EVALUATE her OWN code — the trigger that must route the turn to the
// OPERATOR, the only lane that carries these source tools. Without it, "access your code base and run
// a full review" lands on a conversational route with NO source tools, and she CONFABULATES a review
// she never runs ("I'm pulling up the files and running a diagnostic — report shortly", nothing ever
// comes). Behavior-level, not a phrase list: a review/audit/read verb applied to her own code/source.
const _SELF_CODE = /\b(?:your|my|her|its|zoe'?s|own)\s+(?:own\s+)?(?:code[\s-]?base|codebase|source[\s-]?code|source|code|implementation|program|modules?|repo(?:sitory)?)\b/i;
const _BARE_CODE = /\b(?:code[\s-]?base|codebase|source[\s-]?code)\b/i;
const _REVIEW_VERB = /\b(?:re-?view\w*|evaluat\w*|audit\w*|analy[sz]\w*|assess\w*|inspect\w*|critiqu\w*|examin\w*|debug\w*|diagnos\w*|read|reading|check|checking|look(?:ing)?\s+(?:at|over|through)|go(?:ing)?\s+(?:over|through)|walk(?:ing)?\s+through)\b/i;
function isSelfCodeReview(msg) {
  const s = String(msg || '');
  if (s.length < 6) return false;
  if (_REVIEW_VERB.test(s) && (_SELF_CODE.test(s) || _BARE_CODE.test(s))) return true;
  // THE ORGAN ATLAS (cut 11): "which organ owns my mood" is a self-question too — answered from the atlas through the same door.
  try { return require('./organ_atlas').detectOrganQuestion(s); } catch { return false; }
}

module.exports = { ROOT, ALLOW_DIRS, resolveSafe, sourceMap, readSource, searchSource, sourceOutline, selfTest, allSourceFiles: _allSourceFiles, isSelfCodeReview };

// Worker entry — _inWorker() re-runs THIS module in a worker_thread with workerData set; the heavy
// read cores execute here, off the main thread, and post one message back.
try {
  const wt = require('worker_threads');
  if (!wt.isMainThread && wt.workerData && wt.workerData.__selfSource) {
    const { __selfSource: op, payload } = wt.workerData;
    const out = op === 'search' ? _searchCore((payload || {}).pattern, (payload || {}).opts || {})
      : op === 'map' ? _mapCore((payload || {}).opts || {})
      : `unknown worker op: ${op}`;
    wt.parentPort.postMessage(out);
  }
} catch { /* not a worker context */ }
