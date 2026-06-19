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
  const trimmed = p.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  return path.normalize(path.join(WORKSPACE, trimmed));
}

function fileWrite(p, content) {
  const abs = resolvePath(p);
  if (!abs) return { ok: false, reason: 'no path given' };
  const data = String(content == null ? '' : content);
  if (Buffer.byteLength(data, 'utf8') > MAX_WRITE_BYTES) {
    return { ok: false, reason: `content exceeds ${MAX_WRITE_BYTES} byte cap` };
  }
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data, 'utf8');
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
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, data, 'utf8');
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
    let text = fs.readFileSync(abs, 'utf8');
    const truncated = text.length > MAX_READ_CHARS;
    if (truncated) text = text.slice(0, MAX_READ_CHARS) + '\n…(truncated)';
    return { ok: true, path: abs, text, truncated, size: stat.size };
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

function fileSearch(dir, query) {
  const root = dir && dir.trim() ? resolvePath(dir) : WORKSPACE;
  const q = (query || '').trim();
  if (!q) return { ok: false, reason: 'search needs a query' };
  const needle = q.toLowerCase();
  const matches = [];
  let scanned = 0;
  try {
    if (!fs.existsSync(root)) return { ok: false, reason: 'directory does not exist', path: root };
    const stack = [root];
    while (stack.length && scanned < SEARCH_MAX_FILES && matches.length < SEARCH_MAX_MATCHES) {
      const cur = stack.pop();
      let ents;
      try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) {
          if (!SEARCH_SKIP_DIRS.has(e.name)) stack.push(full);
          continue;
        }
        if (scanned >= SEARCH_MAX_FILES || matches.length >= SEARCH_MAX_MATCHES) break;
        scanned++;
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.size > SEARCH_MAX_FILE_BYTES) continue;
        let text;
        try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
        if (text.includes(String.fromCharCode(0))) continue;  // crude binary skip
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            matches.push({ path: full, line: i + 1, text: lines[i].trim().slice(0, 200) });
            if (matches.length >= SEARCH_MAX_MATCHES) break;
          }
        }
      }
    }
    return { ok: true, root, query: q, matches, scanned, capped: matches.length >= SEARCH_MAX_MATCHES };
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
    case 'file-search': return fileSearch(attrs.dir || attrs.path, attrs.query || body);
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
A bare name like "notes/idea.md" lands in your workspace (${WORKSPACE}). An absolute path goes wherever you point it. Output of file-read/file-list/file-search arrives in your next-turn context.`;
}

module.exports = {
  WORKSPACE,
  ensureWorkspace, resolvePath,
  fileWrite, fileAppend, fileRead, fileList, fileMove, fileCopy, fileSearch,
  parseTags, stripTags, dispatch,
  buildPromptBlock
};
