/**
 * Filesystem access for Zoe — UNSANDBOXED (Lucas's explicit choice 2026-06-18:
 * "no boundaries full access"). She can read/write/append/list anywhere the OS
 * user can reach. Relative paths resolve against a default workspace for
 * convenience; absolute paths go anywhere.
 *
 * Tags (parsed from her <think>/<say> after a turn, like the browser tags):
 *   <file-write path="...">content</file-write>   — create or overwrite
 *   <file-append path="...">content</file-append> — append (creates if absent)
 *   <file-read path="..."/>                        — read into next-turn context
 *   <file-list path="..."/>                        — list a directory
 *
 * NOT wired: delete (irreversible — only on explicit go-ahead).
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

// --- Tag parsing (mirrors browser.js style) ---

const FILE_TAG_RE = /<(file-(?:write|append|read|list))\s*([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
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
A bare name like "notes/idea.md" lands in your workspace (${WORKSPACE}). An absolute path goes wherever you point it. Output of file-read/file-list arrives in your next-turn context.`;
}

module.exports = {
  WORKSPACE,
  ensureWorkspace,
  fileWrite, fileAppend, fileRead, fileList,
  parseTags, stripTags, dispatch,
  buildPromptBlock
};
