/**
 * Filesystem access for Zoe — UNSANDBOXED (Lucas's explicit choice 2026-06-18:
 * "no boundaries full access"). She can read/write/append/list/move/copy/search
 * anywhere the OS user can reach. Relative paths resolve against a default
 * workspace for convenience; absolute paths go anywhere.
 *
 * Tags (parsed from her <think>/<say> after a turn, like the browser tags):
 *   <file-write path="...">content</file-write>   — create or overwrite
 *   <file-append path="...">content</file-append> — append (creates if absent)
 *   <file-read path="..."/>                        — read into next-turn context
 *   <file-list path="..."/>                        — list a directory
 *   <file-move from="..." to="..."/>               — move (also renames)
 *   <file-copy from="..." to="..."/>               — copy a file
 *   <file-search dir="..." query="..."/>           — search file contents in a tree
 *
 * NOT wired: delete (irreversible — only on explicit go-ahead). Note move's
 * cross-device fallback removes the source it just copied — that completes the
 * move, it is not a general delete.
 *
 * This is the persistence surface Zoe asked for: notes, references, and drafts
 * for the byline goal that survive across sessions beyond conversation threads.
 */

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.join(APP_ROOT, 'data', 'zoe_workspace');

const MAX_READ_CHARS = 8000;   // cap file content injected into context
const MAX_WRITE_BYTES = 5 * 1024 * 1024;  // sanity cap so a runaway gen can't write GBs

function ensureWorkspace() {
  try { if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true }); } catch {}
}

// Relative → workspace; absolute → as-is. No confinement (full access by design).
function resolvePath(p) {
  if (!p || typeof p !== 'string') return null;
  let trimmed = p.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  // GUARD: the model sometimes over-specifies the workspace ROOT as a relative dir ("data/zoe_workspace/notes"),
  // which then joins onto WORKSPACE (…/data/zoe_workspace) and DOUBLES to …/data/zoe_workspace/data/zoe_workspace
  // — a path that doesn't exist, so file-search/file-list silently find nothing (the doubled-path Lucas saw in
  // the activity rail). Collapse a redundant leading "data/zoe_workspace" (either slash style) → workspace root.
  trimmed = trimmed.replace(/^[\\/]*data[\\/]+zoe_workspace(?:[\\/]+|$)/i, '');
  return path.normalize(path.join(WORKSPACE, trimmed));
}

// ── ONE-CANONICAL-ARTIFACT (Block 3, 2026-08-14) ─────────────────────────────────────────────────
// Measured in notes/: ~10 sibling files for ONE subject (applied_digital_overview,
// applied-digital-overview, applied_digital_current_state, applied_digital_research_overview, …) —
// every pass invented a fresh filename, so the topic's material scattered and no file was ever the
// document. Cure at this door: a write to a NEW .md whose filename reduces to the SAME subject-token
// set as an existing sibling in the same directory lands as a dated revision APPENDED to that
// canonical file (append, never overwrite — the prior material must stay recoverable). Equality of
// token sets, not overlap, so allen_county_INDIANA never folds into allen_county_KS and the
// wrong-entity "…_solutions_…" stays its own file. Exempt: date-stamped names (per-day artifacts),
// directed-* (thread-keyed), *_FINAL (the conductor owns those).
const GENERIC_STEM_WORDS = new Set([
  'overview', 'notes', 'note', 'research', 'context', 'state', 'current', 'brief', 'briefing',
  'report', 'paper', 'profile', 'summary', 'info', 'information', 'general', 'misc', 'doc',
  'document', 'file', 'new', 'updated', 'update', 'latest', 'draft', 'drafts', 'working',
  'inc', 'llc', 'ltd', 'corp', 'company', 'co', 'the', 'and', 'of', 'on', 'for', 'a', 'an',
]);
function _stemTokens(fileName) {
  const stem = String(fileName || '').replace(/\.md$/i, '');
  const out = new Set();
  for (const w of stem.toLowerCase().split(/[-_ .]+/)) {
    if (w.length >= 2 && !/^\d+$/.test(w) && !GENERIC_STEM_WORDS.has(w)) out.add(w);
  }
  return out;
}
function _canonExempt(fileName) {
  const f = String(fileName || '');
  return /\d{4}-\d{2}-\d{2}|\d{8}/.test(f) || /^directed-/i.test(f) || /_final\.md$/i.test(f);
}
function findCanonicalSibling(abs) {
  try {
    if (!/\.md$/i.test(abs) || fs.existsSync(abs)) return null;
    const base = path.basename(abs);
    if (_canonExempt(base)) return null;
    const toks = _stemTokens(base);
    if (toks.size === 0) return null;
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) return null;
    const cands = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/\.md$/i.test(f) || _canonExempt(f)) continue;
      const ft = _stemTokens(f);
      if (ft.size !== toks.size) continue;
      let same = true; for (const w of toks) if (!ft.has(w)) { same = false; break; }
      if (!same) continue;
      let size = 0; try { size = fs.statSync(path.join(dir, f)).size; } catch {}
      cands.push({ f, size });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.size - a.size);   // among existing siblings, the largest = most material
    return path.join(dir, cands[0].f);
  } catch { return null; }
}
function _appendRevision(canonAbs, requestedAbs, data) {
  const stamp = new Date().toISOString().slice(0, 10);
  const block = `\n\n---\n*revision ${stamp} (arrived as "${path.basename(requestedAbs)}" — folded into this canonical note)*\n\n${data}`;
  fs.appendFileSync(canonAbs, block, 'utf8');
  let total = 0; try { total = fs.statSync(canonAbs).size; } catch {}
  return total;
}

// C1 (2026-08-19): the delivery kept-checks (promise booking, order backstop) were blind to FILE
// writes — a report landing at notes/*.md still read as "nothing delivered this turn" and booked a
// spurious promise (run-2b, recheck#1681). Stamp every successful workspace write; lastWriteTs()
// is the probe, same shape as canvas_docs.lastWriteTs.
let _lastWriteTs = 0;
let _lastWritePath = '';   // the RESOLVED path (the canonical when one-canonical redirected) — the
                           // registry's in-turn delivery registration needs WHICH file, not just when
function lastWriteTs() { return _lastWriteTs; }
function lastWrite() { return { ts: _lastWriteTs, path: _lastWritePath }; }

function fileWrite(p, content) {
  const abs = resolvePath(p);
  if (!abs) return { ok: false, reason: 'no path given' };
  const data = String(content == null ? '' : content);
  if (Buffer.byteLength(data, 'utf8') > MAX_WRITE_BYTES) {
    return { ok: false, reason: `content exceeds ${MAX_WRITE_BYTES} byte cap` };
  }
  try {
    const canon = findCanonicalSibling(abs);
    if (canon) {
      const total = _appendRevision(canon, abs, data);
      _lastWriteTs = Date.now(); _lastWritePath = canon;
      console.log(`[files] one-canonical: "${path.basename(abs)}" folded into existing "${path.basename(canon)}"`);
      return { ok: true, path: canon, redirected: true, requested: abs, total, note: `a note on this subject already exists — your content was added to ${path.basename(canon)} as a dated revision instead of creating a sibling file` };
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data, 'utf8');
    _lastWriteTs = Date.now(); _lastWritePath = abs;
    return { ok: true, path: abs, bytes: Buffer.byteLength(data, 'utf8') };
  } catch (err) {
    return { ok: false, reason: err.message, path: abs };
  }
}

function fileAppend(p, content) {
  const abs = resolvePath(p);
  if (!abs) return { ok: false, reason: 'no path given' };
  const data = String(content == null ? '' : content);
  try {
    const canon = findCanonicalSibling(abs);   // only fires when abs itself doesn't exist
    if (canon) {
      const total = _appendRevision(canon, abs, data);
      _lastWriteTs = Date.now(); _lastWritePath = canon;
      console.log(`[files] one-canonical: append "${path.basename(abs)}" folded into existing "${path.basename(canon)}"`);
      return { ok: true, path: canon, redirected: true, requested: abs, appended: Buffer.byteLength(data, 'utf8'), total };
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, data, 'utf8');
    _lastWriteTs = Date.now(); _lastWritePath = abs;
    let total = 0;
    try { total = fs.statSync(abs).size; } catch {}
    return { ok: true, path: abs, appended: Buffer.byteLength(data, 'utf8'), total };
  } catch (err) {
    return { ok: false, reason: err.message, path: abs };
  }
}

function fileRead(p) {
  const abs = resolvePath(p);
  if (!abs) return { ok: false, reason: 'no path given' };
  try {
    if (!fs.existsSync(abs)) return { ok: false, reason: 'file does not exist', path: abs };
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return { ok: false, reason: 'that is a directory — use <file-list/>', path: abs };
    // Image file → return base64 (not garbled utf8) so the caller can run it through vision (she SEES it).
    if (/\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(abs)) {
      if (stat.size > 12 * 1024 * 1024) return { ok: false, reason: 'image too large to view (>12MB)', path: abs };
      return { ok: true, path: abs, image: true, base64: fs.readFileSync(abs).toString('base64'), size: stat.size };
    }
    let text = fs.readFileSync(abs, 'utf8');
    const truncated = text.length > MAX_READ_CHARS;
    if (truncated) text = text.slice(0, MAX_READ_CHARS) + '\n…(truncated)';
    return { ok: true, path: abs, text, truncated, size: stat.size };
  } catch (err) {
    return { ok: false, reason: err.message, path: abs };
  }
}

// Untruncated read for PROGRAM-INTERNAL use (assembly, counting, parsing) — never for direct model
// injection. fileRead's MAX_READ_CHARS cap exists to bound what goes into the prompt; the deliverable
// assembly + the count/list query must see the WHOLE file (a 33KB, 13-org run was being cut to ~5 orgs).
function fileReadFull(p) {
  const abs = resolvePath(p);
  if (!abs) return { ok: false, reason: 'no path given' };
  try {
    if (!fs.existsSync(abs)) return { ok: false, reason: 'file does not exist', path: abs };
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return { ok: false, reason: 'that is a directory', path: abs };
    return { ok: true, path: abs, text: fs.readFileSync(abs, 'utf8'), truncated: false, size: stat.size };
  } catch (err) {
    return { ok: false, reason: err.message, path: abs };
  }
}

function fileList(p) {
  // Default to workspace when no path given
  const abs = p && p.trim() ? resolvePath(p) : WORKSPACE;
  try {
    if (!fs.existsSync(abs)) return { ok: false, reason: 'directory does not exist', path: abs };
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) return { ok: false, reason: 'that is a file — use <file-read/>', path: abs };
    const entries = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 200).map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file'
    }));
    return { ok: true, path: abs, entries };
  } catch (err) {
    return { ok: false, reason: err.message, path: abs };
  }
}

// Move (also covers rename — give it a new name as the destination).
function fileMove(from, to) {
  const src = resolvePath(from);
  const dst = resolvePath(to);
  if (!src || !dst) return { ok: false, reason: 'move needs both from and to' };
  try {
    if (!fs.existsSync(src)) return { ok: false, reason: 'source does not exist', path: src };
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      fs.renameSync(src, dst);
    } catch (e) {
      // Cross-device or busy: fall back to copy + unlink (still not a "delete" tool —
      // this removes only the source we just copied, completing the move).
      if (e.code === 'EXDEV') {
        fs.copyFileSync(src, dst);
        fs.unlinkSync(src);
      } else { throw e; }
    }
    return { ok: true, from: src, to: dst };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function fileCopy(from, to) {
  const src = resolvePath(from);
  const dst = resolvePath(to);
  if (!src || !dst) return { ok: false, reason: 'copy needs both from and to' };
  try {
    if (!fs.existsSync(src)) return { ok: false, reason: 'source does not exist', path: src };
    const stat = fs.statSync(src);
    if (stat.isDirectory()) return { ok: false, reason: 'copy is for files, not directories' };
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return { ok: true, from: src, to: dst };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Search file CONTENTS across a directory tree for a substring (case-insensitive).
// Bounded: skips big/binary files, caps files scanned and matches returned.
const SEARCH_MAX_FILES = 2000;
const SEARCH_MAX_MATCHES = 60;
const SEARCH_MAX_FILE_BYTES = 512 * 1024;
const SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', 'data', '.cache']);

// ONE search (lib/fs_worker.fileSearchSync) serves the synchronous door, the worker thread and the gate.
// Cut 25 (2026-09-04): the walk read whole files on the MAIN thread inside her reply — a 1.7 s block on
// boot_p284 while she double-checked his Florida list; the chat tag now goes through the worker.
function _searchOpts(dir, query) {
  const root = dir && dir.trim() ? resolvePath(dir) : WORKSPACE;
  const q = (query || '').trim();
  return { root, q, opts: { root, needle: q.toLowerCase(), maxFiles: SEARCH_MAX_FILES, maxMatches: SEARCH_MAX_MATCHES, maxFileBytes: SEARCH_MAX_FILE_BYTES, skipDirs: [...SEARCH_SKIP_DIRS] } };
}
function _searchResult(root, q, r) {
  const matches = (r && r.matches) || [];
  return { ok: true, root, query: q, matches, scanned: (r && r.scanned) || 0, capped: matches.length >= SEARCH_MAX_MATCHES };
}
function fileSearch(dir, query) {
  const { root, q, opts } = _searchOpts(dir, query);
  if (!q) return { ok: false, reason: 'search needs a query' };
  try {
    if (!fs.existsSync(root)) return { ok: false, reason: 'directory does not exist', path: root };
    return _searchResult(root, q, require('./fs_worker').fileSearchSync(opts));
  } catch (err) {
    return { ok: false, reason: err.message, path: root };
  }
}
/** The same search OFF the main thread; a worker failure falls back to the synchronous door. */
async function fileSearchAsync(dir, query) {
  const { root, q, opts } = _searchOpts(dir, query);
  if (!q) return { ok: false, reason: 'search needs a query' };
  try {
    if (!fs.existsSync(root)) return { ok: false, reason: 'directory does not exist', path: root };
    try { return _searchResult(root, q, await require('./fs_worker').probeSearch(opts)); }
    catch (e) {
      try { console.error('[files] search fell back to the main thread:', e && e.message); } catch {}
      return _searchResult(root, q, require('./fs_worker').fileSearchSync(opts));
    }
  } catch (err) {
    return { ok: false, reason: err.message, path: root };
  }
}

// --- Tag parsing (mirrors browser.js style) ---

const FILE_TAG_RE = /<(file-(?:write|append|read|list|move|copy|search))\s*([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

function parseAttrs(s) {
  const out = {};
  if (!s) return out;
  let m; ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s)) !== null) out[m[1]] = m[2];
  return out;
}

function parseTags(text) {
  if (!text) return [];
  const tags = [];
  let m; FILE_TAG_RE.lastIndex = 0;
  while ((m = FILE_TAG_RE.exec(text)) !== null) {
    tags.push({ tag: m[1].toLowerCase(), attrs: parseAttrs(m[2] || ''), body: (m[3] || '') });
  }
  return tags;
}

function stripTags(text) {
  return (text || '').replace(FILE_TAG_RE, '').replace(/[ \t]+/g, ' ').trim();
}

async function dispatch({ tag, attrs, body }) {
  switch (tag.toLowerCase()) {
    case 'file-write':  return fileWrite(attrs.path || attrs.name, body);
    case 'file-append': return fileAppend(attrs.path || attrs.name, body);
    case 'file-read':   return fileRead(attrs.path || attrs.name);
    case 'file-list':   return fileList(attrs.path || attrs.name);
    case 'file-move':   return fileMove(attrs.from, attrs.to);
    case 'file-copy':   return fileCopy(attrs.from, attrs.to);
    case 'file-search': return fileSearchAsync(attrs.dir || attrs.path, attrs.query || body);   // off the main thread (cut 25)
    default:            return { ok: false, reason: `unknown file tag ${tag}` };
  }
}

// Prompt block describing the capability — always available (unlike browser).
function buildPromptBlock() {
  return `FILES — you can create and keep files on Lucas's machine. They persist across sessions; this is your own durable store for notes, references, and drafts (including drafts toward your byline goal), beyond the conversation.
  <file-write path="notes/idea.md">content</file-write>   — create or overwrite a file
  <file-append path="drafts/piece.md">more</file-append>  — add to a file (creates if absent)
  <file-read path="notes/idea.md"/>                        — read a file into your next-turn context
  <file-list path="drafts"/>                               — list a folder (no path = your workspace)
  <file-move from="drafts/old.md" to="archive/old.md"/>    — move or rename a file
  <file-copy from="notes/idea.md" to="drafts/idea.md"/>    — copy a file
  <file-search dir="notes" query="byline"/>                — find which files mention something
A bare name like "notes/idea.md" lands in your workspace (${WORKSPACE}). An absolute path goes wherever you point it. Output of file-read/file-list/file-search arrives in your next-turn context.
ONE SUBJECT = ONE NOTE FILE. Before starting a new note, file-search for the subject and revise the existing file. A write whose filename matches an existing note's subject is folded into that file as a dated revision (the result names the real path) — sibling files like "topic-overview.md" beside "topic_current_state.md" scatter the material and are never the document.`;
}

module.exports = {
  WORKSPACE,
  ensureWorkspace, resolvePath,
  fileWrite, fileAppend, fileRead, fileReadFull, fileList, fileMove, fileCopy, fileSearch, fileSearchAsync,
  findCanonicalSibling, lastWriteTs, lastWrite,
  parseTags, stripTags, dispatch,
  buildPromptBlock
};
