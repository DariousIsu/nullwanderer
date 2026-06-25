/**
 * lib/doc_extract.js — LOCAL binary-document extractors for the writing suite (Phase 1 of the
 * native document model). Turns external .docx / .pdf files into markdown that flows straight into
 * editor_import.normalizeMarkdown → the structured block model the whole suite rides. This fills
 * the extension point editor_import's header reserved ("a local standalone extractor drops in
 * behind importFile without changing the working-copy model"): the app now owns binary extraction
 * instead of round-tripping through Echo's ingest.
 *
 * Hybrid fidelity (per ZOE_HOST_ARCHITECTURE): the ORIGINAL file stays canonical on disk; this
 * produces the parsed structured OVERLAY (lossy by design for .docx/.pdf — never edited back into
 * the original). License-cleared: mammoth (BSD-2, .docx) · pdfjs-dist (Apache-2.0, .pdf).
 *
 *   htmlToMarkdown  — pure: mammoth's flat HTML (h1-6/p/li/strong/em, tables flattened) → markdown
 *   extractDocx     — async: mammoth.convertToHtml → htmlToMarkdown
 *   extractPdf      — async: pdfjs text content, paginated → markdown (PDF structure is lossy)
 *   extractToMarkdown — async dispatch by extension (.docx/.pdf/.md/.txt)
 *
 * Node-only (main process) — mammoth is CommonJS; pdfjs-dist v6 is ESM (loaded via dynamic import).
 */
'use strict';
const fs = require('fs');
const path = require('path');

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// Inline HTML → markdown inline (bold/italic kept, links flattened to text, other tags stripped).
function inlineMd(html) {
  return decodeEntities(String(html || '')
    .replace(/<\s*(strong|b)\s*>/gi, '**').replace(/<\/\s*(strong|b)\s*>/gi, '**')
    .replace(/<\s*(em|i)\s*>/gi, '_').replace(/<\/\s*(em|i)\s*>/gi, '_')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<a\b[^>]*>/gi, '').replace(/<\/a>/gi, '')
    .replace(/<[^>]+>/g, '')
  ).replace(/[ \t]+/g, ' ').trim();
}

// mammoth's flat block HTML → markdown. Tables are flattened (their structural tags dropped, inner
// blocks kept) — authored .docx tables are usually layout, and data-table grids are a polish-pass
// concern. Block order is preserved (left-to-right scan).
function htmlToMarkdown(html) {
  const stripped = String(html || '').replace(/<\/?(table|tbody|thead|tr|td|th|ul|ol)[^>]*>/gi, '');
  const out = [];
  const re = /<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const tag = m[1].toLowerCase();
    const inner = inlineMd(m[2]);
    if (!inner) continue;
    if (tag[0] === 'h') out.push('#'.repeat(Number(tag[1])) + ' ' + inner);
    else if (tag === 'li') out.push('- ' + inner);
    else out.push(inner);
  }
  return out.join('\n\n');
}

// .docx → markdown via mammoth (HTML path keeps headings/lists/emphasis).
async function extractDocx(filePath) {
  const mammoth = require('mammoth');
  const r = await mammoth.convertToHtml({ path: filePath });
  return { markdown: htmlToMarkdown(r.value), messages: (r.messages || []).map(x => x.message || String(x)) };
}

// .docx → RICH HTML for faithful display (the Reader's hybrid-fidelity path: render the canonical
// original, not the lossy extracted markdown). mammoth emits a safe fixed vocabulary (h1-6, p,
// ul/ol/li, table, strong/em, a, img) and inlines embedded images as base64 data URIs. We still
// run a light sanitize (strip <script>, on*= handlers, javascript: URLs) as belt-and-suspenders.
function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '').replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');
}
async function extractDocxHtml(filePath) {
  const mammoth = require('mammoth');
  const r = await mammoth.convertToHtml({ path: filePath });
  return { html: sanitizeHtml(r.value), messages: (r.messages || []).map(x => x.message || String(x)) };
}

// .pdf → markdown via pdfjs-dist (ESM, dynamic import). One "## Page N" section per page; the page
// text is a single run-on block (PDF positioned-text has no paragraph semantics — lossy by nature).
async function extractPdf(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const parts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const txt = tc.items.map(i => (i && i.str) || '').join(' ').replace(/\s+/g, ' ').trim();
    if (txt) parts.push(`## Page ${p}\n\n${txt}`);
  }
  try { await doc.destroy(); } catch (e) {}
  return { markdown: parts.join('\n\n'), pages: doc.numPages };
}

const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'text']);

// Dispatch a file path to the right extractor → { markdown, format, ... }. Text formats read directly.
async function extractToMarkdown(filePath) {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  if (TEXT_EXT.has(ext)) return { markdown: fs.readFileSync(filePath, 'utf8'), format: ext === 'markdown' ? 'md' : (ext === 'text' ? 'txt' : ext) };
  if (ext === 'docx') return { ...(await extractDocx(filePath)), format: 'docx' };
  if (ext === 'pdf') return { ...(await extractPdf(filePath)), format: 'pdf' };
  throw new Error(`extractToMarkdown: unsupported extension .${ext}`);
}

module.exports = { decodeEntities, inlineMd, htmlToMarkdown, sanitizeHtml, extractDocx, extractDocxHtml, extractPdf, extractToMarkdown, TEXT_EXT };
