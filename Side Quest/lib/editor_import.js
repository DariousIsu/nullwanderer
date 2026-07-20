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

// Strip leading/trailing markdown emphasis from a title-ish line. docx→markdown conversion emits
// a document's title as an emphasized paragraph ("**Title**"), and without this the asterisks ride
// into the registry, View A, the findings report, and the certificate.
function stripEmphasis(text) {
  let t = String(text || '').trim();
  for (let i = 0; i < 3; i++) {
    const m = t.match(/^(\*\*\*|\*\*|__|\*|_)([\s\S]+?)\1$/);
    if (!m) break;
    t = m[2].trim();
  }
  return t;
}

// Trim a title-ish line down to the TITLE. A cover page has no blank line between the title, the
// byline and the date, so a PDF's first block arrives as "…Spying on Your Family By R. Russell Walker
// June 2026" — which then got hard-sliced at 80 chars to "…By R. Russell Walk" and printed on a
// certification seal. Cut at the byline, then at a sentence end, then on a WORD boundary.
function trimTitle(text, max) {
  let t = String(text || '').trim();
  // A BYLINE, not any "by": the next token must look like a person's name — an initial ("R.") or a
  // capitalized word that is not a determiner. Otherwise a real title gets beheaded ("Standby Power
  // By The Numbers" → "Standby Power"). The second name token is what separates "By Russ Walker"
  // from "By Region".
  const by = t.match(/\s+[Bb]y\s+(?:[A-Z]\.\s*[A-Z]|(?!The\b|A\b|An\b|These\b|Those\b|This\b|That\b|All\b|Any\b|Our\b|Their\b|Its\b|Design\b|Default\b|Contrast\b|Region\b|Category\b|Popular\b|Number)[A-Z][a-z]+\s+[A-Z])/);
  if (by && by.index > 0) t = t.slice(0, by.index).trim();
  const stop = t.match(/[.?!](?:\s|$)/);                            // a title rarely runs past a full stop
  if (stop && stop.index > 0) t = t.slice(0, stop.index + 1).trim();
  t = t.replace(/[\s—–-]+$/, '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:—–-]+$/, '') + '…';
}

// Guess a title: first heading, else first non-empty paragraph (capped), else 'Untitled'.
function guessTitle(blocks) {
  const h = blocks.find(b => b.type === 'heading');
  if (h && h.text) return trimTitle(stripEmphasis(h.text), 200);
  const p = blocks.find(b => b.text && b.text.trim());
  return p ? trimTitle(stripEmphasis(p.text), 120) : 'Untitled';
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

// Render the BLOCK MODEL to document HTML (for PDF export). The blocks are richer and more reliable
// than re-parsing markdown — headings, list runs and tables are already resolved here — so an export
// mirrors exactly what the studio verified. Pure + string-only: no DOM, no Electron.
function blocksToHtml(blocks) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  // Inline markdown the importer deliberately leaves inside block text.
  const inline = (s) => esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:)!?]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[^*\w])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
    // Bare urls -> real links. Endnote lists cite sources as plain "(https://…)", which would
    // otherwise export as dead text. The leading-delimiter capture keeps this off urls already
    // inside an href="…" emitted just above.
    .replace(/(^|[\s(])(https?:\/\/[^\s<>()]+)/g, '$1<a href="$2">$2</a>');

  const out = [];
  let list = null;                                    // batch contiguous list_items into one <ul>/<ol>
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const b of (blocks || [])) {
    if (!b) continue;
    if (b.type === 'list_item') {
      const want = /^\d/.test(String(b.marker || '')) ? 'ol' : 'ul';
      if (list !== want) { closeList(); list = want; out.push(`<${want}>`); }
      out.push(`<li>${inline(b.text)}</li>`);
      continue;
    }
    closeList();
    if (b.type === 'heading') {
      const lv = Math.min(6, Math.max(1, b.level || 1));
      out.push(`<h${lv}${lv === 1 ? ' class="ex-title"' : ''}>${inline(b.text)}</h${lv}>`);
    } else if (b.type === 'code') {
      out.push(`<pre><code>${esc(b.text)}</code></pre>`);
    } else if (b.type === 'table') {
      const rows = String(b.text || '').split('\n').map(r => r.trim()).filter(Boolean)
        .filter(r => !/^[|\s:-]+$/.test(r))
        .map(r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
      if (rows.length) {
        const [head, ...body] = rows;
        out.push('<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
        for (const r of body) out.push('<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>');
        out.push('</tbody></table>');
      }
    } else {
      out.push(`<p>${inline(b.text)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}

// Plain text of the working copy (for re-check / diff / display fallbacks).
function workingCopyText(wc) {
  return (wc && wc.blocks || []).map(b => b.type === 'heading' ? `${'#'.repeat(b.level || 1)} ${b.text}` : b.text).join('\n\n');
}

module.exports = {
  normalizeMarkdown, importText, importFile, parseBlocks, workingCopyText,
  guessTitle, stripEmphasis, trimTitle, blocksToHtml, blockHash, anchorFor,
  TEXT_FORMATS, ECHO_FORMATS,
};
