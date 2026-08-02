/**
 * lib/self_source.js — READ-ONLY access to her OWN SOURCE + the offline verification gate
 * (slice 3a, 2026-07-22 — the last driver's-seat organs: "how am I coded" and "am I healthy").
 *
 * The audit's goal-3 finding: she had a changelog (self_dev) but NO access to her own source — "how
 * am I coded" was unanswerable, and goal-4's self-repair ladder has to START with grounded reading.
 * These four surfaces close the read half:
 *   sourceMap()    — the file map with each module's own header line (the repo's rich headers become
 *                    her self-description for free);
 *   readSource()   — one file, capped with an honest deferral note (a cap may defer, never disappear);
 *   searchSource() — bounded grep across the source ("where is X implemented / who calls Y");
 *   selfTest()     — run the offline smoke gate: one suite in seconds, or the full curated gate.
 *                    THE honest answer to "am I healthy?" — the same oracle the build lane trusts.
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

// The first substantive line of a file's header comment — the repo's headers ARE the self-description.
function _headerLine(abs) {
  try {
    const head = fs.readFileSync(abs, 'utf8').slice(0, 600);
    const m = head.match(/\/\*\*?\s*\n?\s*\*?\s*([^\n*][^\n]*)/) || head.match(/^\/\/\s*(.+)$/m) || head.match(/^#\s*(.+)$/m);
    return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  } catch { return ''; }
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

// "How am I coded" — the map. Grouped by directory, each file with size + its own header line.
function sourceMap({ maxChars = 9000 } = {}) {
  const files = _allSourceFiles();
  const byDir = new Map();
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    const dir = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '(root)';
    if (!byDir.has(dir)) byDir.set(dir, []);
    let kb = 0; try { kb = Math.max(1, Math.round(fs.statSync(abs).size / 1024)); } catch {}
    byDir.get(dir).push(`  ${rel} (${kb}KB)${path.extname(abs) === '.js' ? ` — ${_headerLine(abs)}` : ''}`);
  }
  const parts = [`YOUR SOURCE (${files.length} files under ${ROOT}; read one with source_read, search with source_search):`];
  for (const [dir, list] of [...byDir.entries()].sort()) parts.push(`${dir}/ (${list.length}):\n${list.sort().join('\n')}`);
  const text = parts.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) + `\n…(map truncated at ${maxChars} chars — search for what you need with source_search)` : text;
}

// One file, capped with an honest deferral note.
function readSource(rel, { maxChars = 24000 } = {}) {
  const { abs, reason } = resolveSafe(rel);
  if (!abs) return `not readable: ${reason}`;
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return `not readable: ${e.code === 'ENOENT' ? 'no such file' : e.message}`; }
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n…(first ${maxChars} of ${text.length} chars — ask again for a later section, or source_search for the specific symbol)`;
}

// Bounded grep across the source. Pattern tries as a case-insensitive regex, falls back to literal.
function searchSource(pattern, { maxMatches = 40, maxFiles = 500 } = {}) {
  const p = String(pattern || '').trim();
  if (p.length < 2) return 'give a search pattern of at least 2 characters';
  let re;
  try { re = new RegExp(p, 'i'); } catch { re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const files = _allSourceFiles().slice(0, maxFiles);
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
  return hits.length ? hits.join('\n') + (hits.length >= maxMatches ? `\n…(stopped at ${maxMatches} matches — narrow the pattern)` : '') : `no matches for "${p}" in her source`;
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
  return _REVIEW_VERB.test(s) && (_SELF_CODE.test(s) || _BARE_CODE.test(s));
}

module.exports = { ROOT, ALLOW_DIRS, resolveSafe, sourceMap, readSource, searchSource, selfTest, allSourceFiles: _allSourceFiles, isSelfCodeReview };
