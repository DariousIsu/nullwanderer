/**
 * lib/editor_import.js — Editor Studio importers / normalize-on-import (B3).
 *
 * "Whatever format arrives is extracted into ONE internal editable working copy; we never edit
 * the original in place" (EDITOR_TAB_SPEC View B). This module owns the markdown → light
 * working-copy normalization: an ordered list of blocks (heading/paragraph/list_item/table/code)
 * each with a STABLE ANCHOR that findings attach to (and that persists when the rail collapses).
 *
 * Per-format extraction is split by where it's cheapest + already solved:
 *   - .md / .txt  → parsed DIRECTLY here (trivial; no deps).
 *   - .docx / .pdf → extraction is ECHO's job (its ingest pipeline already converts the real
 *     corpus to `documents.markdown_current`). The caller passes that extracted markdown in via
 *     `opts.markdown`; we normalize it. This references Echo's proven extraction instead of
 *     bundling a second mammoth/pdfjs path (absorb-and-reference, not duplicate). If a local
 *     standalone extractor is wanted later, it drops in behind importFile without changing the
 *     working-copy model.
 *
 * The working-copy model is intentionally LIGHT (read-and-correct, not authoring): paragraphs /
 * headings / list items / tables / code + basic inline kept as raw text. The full structured
 * Tiptap creator is a separate, later Canvas concern.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEXT_FORMATS = new Set(['md', 'markdown', 'txt', 'text']);
const ECHO_FORMATS = new Set(['docx', 'pdf']);  // extraction delegated to Echo's ingest

// 8-hex content fingerprint — ties an anchor's identity to its text so re-normalizing identical
// content yields identical hashes (helps the whole-doc re-check map findings across edits).
function blockHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 8);
}
// Stable per-working-copy anchor: ordinal within the doc. Findings reference these; a re-check
// re-normalizes and re-anchors the whole doc, so ordinal stability within one copy is sufficient.
function anchorFor(i) { return `a${i}`; }

// Parse markdown/plaintext into the light block model. Line-based + fence/table aware so the
// real (table-heavy) vault briefings normalize cleanly instead of collapsing into prose.
function parseBlocks(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];        // accumulating paragraph lines
  let table = [];       // accumulating contiguous table lines
  let code = null;      // { fence, lines } while inside a fenced code block

  const flushPara = () => { if (para.length) { blocks.push({ type: 'paragraph', text: para.join(' ').trim() }); para = []; } };
  const flushTable = () => { if (table.length) { blocks.push({ type: 'table', text: table.join('\n') }); table = []; } };

  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();

    // fenced code: capture verbatim until the closing fence
    const fence = trimmed.match(/^(```+|~~~+)(.*)$/);
    if (code) {
      if (fence && trimmed.startsWith(code.fence)) { blocks.push({ type: 'code', text: code.lines.join('\n'), lang: code.lang || null }); code = null; }
      else code.lines.push(line);
      continue;
    }
    if (fence) { flushPara(); flushTable(); code = { fence: fence[1], lang: (fence[2] || '').trim() || null, lines: [] }; continue; }

    if (trimmed === '') { flushPara(); flushTable(); continue; }

    // table rows (contiguous | … | lines)
    if (/^\|.*\|?\s*$/.test(trimmed) || /^\|/.test(trimmed)) { flushPara(); table.push(line); continue; }
    flushTable();

    // heading
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() }); continue; }

    // list item (-, *, +, or "1." ordered)
    const li = trimmed.match(/^([-*+]|\d+[.)])\s+(.*)$/);
    if (li) { flushPara(); blocks.push({ type: 'list_item', text: li[2].trim(), marker: li[1] }); continue; }

    para.push(trimmed);
  }
  if (code) blocks.push({ type: 'code', text: code.lines.join('\n'), lang: code.lang || null }); // unterminated fence
  flushPara(); flushTable();

  // assign stable anchors + content hashes
  return blocks.map((b, i) => ({ anchor: anchorFor(i), hash: blockHash(b.text), ...b }));
}

// Guess a title: first heading, else first non-empty paragraph (capped), else 'Untitled'.
function guessTitle(blocks) {
  const h = blocks.find(b => b.type === 'heading');
  if (h && h.text) return h.text.slice(0, 200);
  const p = blocks.find(b => b.text && b.text.trim());
  return p ? p.text.slice(0, 80) : 'Untitled';
}

// Normalize a markdown/plaintext string into a working copy.
function normalizeMarkdown(md, { title = null, format = 'md' } = {}) {
  const blocks = parseBlocks(md);
  return {
    title: title || guessTitle(blocks),
    format,
    blocks,
    blockCount: blocks.length,
    normalizedAt: Date.now(),
  };
}

// Normalize an in-memory string by declared format.
function importText(content, { format = 'md', title = null } = {}) {
  const fmt = String(format).toLowerCase();
  if (!TEXT_FORMATS.has(fmt) && !ECHO_FORMATS.has(fmt)) throw new Error(`importText: unsupported format ${format}`);
  return normalizeMarkdown(content, { title, format: fmt });
}

// Normalize a file. .md/.txt are read directly; binary formats (.docx/.pdf/.xlsx/images/…) are extracted
// to markdown UPSTREAM (main.js drop/import runs lib/file_ingest → doc_extract for text layers, vision for
// images — the same machinery the canvas drop-ingest uses) and passed back in via opts.markdown.
function importFile(filePath, opts = {}) {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  const fallbackName = path.basename(filePath, path.extname(filePath));
  const fmtOf = (e) => (e === 'markdown' ? 'md' : (e === 'text' ? 'txt' : (e || 'md')));
  // Let the content's first heading win as the title; the filename is only a last resort.
  const finish = (content, format) => {
    const wc = normalizeMarkdown(content, { title: opts.title || null, format });
    if (!opts.title && (!wc.title || wc.title === 'Untitled')) wc.title = fallbackName;
    return wc;
  };
  // Pre-extracted content normalizes regardless of the source format (any real document the caller
  // already turned into markdown — pdf/docx/xlsx/csv/png/…).
  if (typeof opts.markdown === 'string') return finish(opts.markdown, fmtOf(ext));
  // .md / .txt read directly — no extraction needed.
  if (TEXT_FORMATS.has(ext)) {
    const content = fs.readFileSync(filePath, 'utf8');
    return finish(content, fmtOf(ext));
  }
  // A binary/real document with no extracted markdown supplied — the caller must run extraction first.
  if (ECHO_FORMATS.has(ext)) {
    throw new Error(`importFile: ${ext} needs extracted markdown — pass opts.markdown (doc_extract / Echo ingest), or drop it on the surface which extracts automatically`);
  }
  throw new Error(`importFile: unsupported extension .${ext}`);
}

// Plain text of the working copy (for re-check / diff / display fallbacks).
function workingCopyText(wc) {
  return (wc && wc.blocks || []).map(b => b.type === 'heading' ? `${'#'.repeat(b.level || 1)} ${b.text}` : b.text).join('\n\n');
}

module.exports = {
  normalizeMarkdown, importText, importFile, parseBlocks, workingCopyText,
  guessTitle, blockHash, anchorFor,
  TEXT_FORMATS, ECHO_FORMATS,
};
