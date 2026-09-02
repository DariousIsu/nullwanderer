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
 *   extractPdf      — async: pdfjs text content → markdown, running headers/folios dropped (lossy)
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

// Inline HTML → markdown inline. Bold/italic kept. HYPERLINK TARGETS ARE PRESERVED — a citation
// verifier lives or dies on the source URLs in footnotes/links, so an http(s) <a href> becomes
// "text (url)" (or bare url when the text already is the url); anchor/fragment links (footnote refs
// and ↑ backlinks) collapse to their text. Remaining tags stripped.
function inlineMd(html) {
  return decodeEntities(String(html || '')
    .replace(/<\s*(strong|b)\s*>/gi, '**').replace(/<\/\s*(strong|b)\s*>/gi, '**')
    .replace(/<\s*(em|i)\s*>/gi, '_').replace(/<\/\s*(em|i)\s*>/gi, '_')
    .replace(/<br\s*\/?>/gi, ' ')
    // SUPERSCRIPT ENDNOTE REFS → an explicit "[n]" marker. Without this the generic tag-strip below
    // flattens <sup>3</sup> to a bare digit welded onto the sentence ("…zero binding commitments.3"),
    // which no citation-marker detector recognizes — so the claim loses the source the document
    // itself named and falls through to a blind web search. Both real shapes land here: Word
    // footnotes (mammoth emits an <ol> + fnref backlinks) and hand-typed superscripts (no anchor at
    // all). Adjacent refs stay separable ("[4][5]") instead of fusing into "45".
    // Digits only, ≤3 — this deliberately does not touch <sup>st</sup>/<sup>nd</sup> ordinals.
    .replace(/<sup>\s*(\d{1,3})\s*<\/sup>/gi, '[$1]')
    .replace(/<a\b[^>]*\bhref\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, url, txt) => {
      const t = String(txt).replace(/<[^>]+>/g, '').trim();
      return (t && t !== url && !t.includes(url)) ? `${t} (${url})` : (t || url);
    })
    .replace(/<a\b[^>]*>/gi, '').replace(/<\/a>/gi, '')   // fragment/anchor links → text only
    .replace(/<[^>]+>/g, '')
  ).replace(/[ \t]+/g, ' ').replace(/\s*[↑↩^]\s*$/, '').trim();   // drop trailing footnote-return glyph (↩ = mammoth's)
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
    .replace(/<(iframe|object|embed|link|meta|base|form|svg|math|webview)\b[\s\S]*?>/gi, '')
    // QUOTED and UNQUOTED event handlers (audit S2: the quoted-only regex let <img onerror=x> through)
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, (m, attr) => (/javascript:/i.test(m) ? `${attr}="#"` : m));
}
async function extractDocxHtml(filePath) {
  const mammoth = require('mammoth');
  const r = await mammoth.convertToHtml({ path: filePath });
  return { html: sanitizeHtml(r.value), messages: (r.messages || []).map(x => x.message || String(x)) };
}

// Running headers/footers repeat on nearly every page of a designed PDF ("The Joseph Rainey Center
// for Public Policy"). Pasted into every block they bury the argument, and in a design-set PDF they
// are ALSO the only corrupted text — the layout tool bakes letter-spacing into the text layer, so
// the header extracts as "The J oseph Rainey Center f or P ublic P olicy" while body copy stays
// clean. Dropping them removes the boilerplate and the corruption in one move, with no risky
// de-kerning heuristic over real prose.
// A line counts as furniture when the same text appears near the top/bottom of enough text pages
// (see the threshold below; min 3 — under that, "repeated" is not evidence of anything).
// The folio is usually glued to the header in the same text run ("3 The J oseph Rainey Center…"),
// so the raw string differs on every page and would never look repeated. Compare on a key with the
// leading/trailing page number stripped.
function furnitureKey(line) {
  return String(line || '').replace(/^\s*\d{1,4}\s+/, '').replace(/\s+\d{1,4}\s*$/, '').trim();
}

function findPageFurniture(pageLines, { edge = 3, minPages = 3 } = {}) {
  const pages = pageLines.filter(l => l.length);
  if (pages.length < minPages) return new Set();
  const counts = new Map();
  for (const lines of pages) {
    const edges = new Set([...lines.slice(0, edge), ...lines.slice(-edge)].map(furnitureKey));
    for (const k of edges) {
      if (k.length < 4) continue;                      // bare page numbers handled separately
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  // A THIRD, not a half: print design alternates recto/verso headers (publication name on one side,
  // article title on the other), so each covers only about half the BODY pages — and less once a
  // cover and back page that carry no header are counted. A half-threshold misses both.
  const threshold = Math.max(minPages, Math.ceil(pages.length / 3));
  return new Set([...counts].filter(([, n]) => n >= threshold).map(([k]) => k));
}

// WHERE PDF.JS KEEPS ITS IMAGE DECODERS — blocker #3 from docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md.
//
// pdfjs v6 decodes JPEG 2000 (and JBIG2) in WebAssembly and will not guess where the .wasm files live.
// Without `wasmUrl` it builds the fallback path from an unset base and fails with, literally:
//
//   Cannot find package 'nullopenjpeg_nowasm_fallback.js'
//   Unable to decode image "img_p0_1": "JpxError: OpenJPEG failed to initialize"   (×100 in one boot)
//
// This was NOT cosmetic and not a missing capability. Measured on a real ingested file, Arapahoe
// County's "All Districts Map.pdf", rendering page 1 at the same scale:
//
//   without wasmUrl        94,240 bytes   ← the map never drew
//   with    wasmUrl    11,931,080 bytes   ← the map drew
//
// A scanned roster was therefore indistinguishable from a body with no roster: the text layer is
// empty, the rasterize→vision fallback fires, and vision is handed a page with the content missing.
// That is the "silent class of never-encountered objects" the design flagged — objects absent from the
// graph with no error anywhere to say so.
//
// Resolved from the package itself rather than assumed relative to cwd, and it MUST be a file:// URL
// with a trailing slash — a bare path is rejected ("must include trailing slash") and a path without
// the scheme is not a valid factory url.
let _wasmUrl;
function pdfWasmUrl() {
  if (_wasmUrl !== undefined) return _wasmUrl;
  try {
    const pkg = require.resolve('pdfjs-dist/package.json');
    _wasmUrl = require('url').pathToFileURL(path.join(path.dirname(pkg), 'wasm')).href + '/';
  } catch { _wasmUrl = null; }   // decoders unavailable → pdfjs degrades as before, never throws here
  return _wasmUrl;
}

// The shared getDocument config. Kept in one place so a call site cannot be added that silently loses
// image decoding again — which is exactly how this went unnoticed.
function pdfDocOptions(data) {
  const opts = { data, useSystemFonts: true, isEvalSupported: false };
  const w = pdfWasmUrl();
  if (w) opts.wasmUrl = w;
  return opts;
}

// .pdf → markdown via pdfjs-dist (ESM, dynamic import).
//
// pdfjs yields positioned LINE FRAGMENTS, not paragraphs. Blank items and hasEOL are the only
// paragraph signal available, so they drive the block breaks — without them an entire page collapses
// into one run-on paragraph, which costs the Editor its block structure (and with it any chance of
// spotting a reference section or attaching a finding to a real anchor).
//
// NO "## Page N" headings are injected: they are not in the document, they became the first heading
// so every designed PDF imported with the title "Page 1", and they polluted the block model with one
// junk heading per page. Page boundaries are not document structure.
async function extractPdf(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument(pdfDocOptions(data)).promise;

  // Pass 1 — per-page lines (fragments joined until a blank item / EOL ends the line).
  const pageLines = [];
  const emptyPages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    // pdfjs items are WRAPPED LINE fragments, not paragraphs: "Right now, in nurseries and bedrooms"
    // / "across America, a camera is watching" / "your child sleep." are three items of ONE sentence.
    // They must be joined — emitting each as its own block shatters every sentence and leaves the
    // verifier nothing splittable. A BLANK item is the only paragraph signal the format offers.
    const lines = [];
    let cur = '';
    const flush = () => { if (cur.trim()) lines.push(cur.replace(/\s+/g, ' ').trim()); cur = ''; };
    for (const it of tc.items) {
      const s = (it && it.str) || '';
      if (!s.trim()) { flush(); continue; }
      cur += (cur ? ' ' : '') + s;
    }
    flush();                                            // a page boundary always ends a paragraph
    if (!lines.length) emptyPages.push(p);             // image-only page: no text layer to read
    pageLines.push(lines);
  }

  // Pass 2 — drop furniture, then emit paragraphs. Needs every page first, so it cannot fold into 1.
  // Kept PER PAGE (not one flat list) so a caller that OCRs an image-only page can splice the result
  // back at its real position instead of appending it out of order.
  const furniture = findPageFurniture(pageLines);
  const pageTexts = pageLines.map((lines, i) => {
    const pageNo = String(i + 1);
    return lines
      .map(l => l.trim())
      .filter(t => t && t !== pageNo && !furniture.has(furnitureKey(t)))   // page number / running header
      .join('\n\n');
  });

  try { await doc.destroy(); } catch (e) { /* older builds expose no destroy */ }
  return {
    markdown: pageTexts.filter(Boolean).join('\n\n'),
    pages: doc.numPages,
    pageTexts,                                         // index i = page i+1, '' when image-only
    emptyPages,                                        // caller may offer OCR for these
    textPages: doc.numPages - emptyPages.length,
  };
}

// .pdf → per-page PNG images (base64), for the VISION fallback when a PDF has no text layer (a
// scan / image-only doc). Renders through @napi-rs/canvas (already a dep) — the missing rasterize
// step that lets file_ingest OCR a scanned PDF via lib/vision, exactly as it does an image drop.
// Bounded by maxPages; scale=2 is ~150dpi, enough for the vision model to read small type.
// `only` (1-based page numbers) renders JUST those pages — a mixed document usually needs a handful
// of image-only spreads read, not the whole file re-rendered and re-billed through vision.
async function rasterizePdf(filePath, { maxPages = 10, scale = 2.0, only = null } = {}) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument(pdfDocOptions(data)).promise;
  const pages = [];
  const wanted = Array.isArray(only) && only.length
    ? [...new Set(only.map(Number).filter(n => n >= 1 && n <= doc.numPages))].sort((a, b) => a - b).slice(0, Math.max(1, maxPages))
    : Array.from({ length: Math.min(doc.numPages, Math.max(1, maxPages)) }, (_, i) => i + 1);
  const rendered = [];
  for (const p of wanted) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    pages.push(canvas.toBuffer('image/png').toString('base64'));
    rendered.push(p);
    try { page.cleanup(); } catch (e) {}
  }
  const total = doc.numPages;
  try { await doc.destroy(); } catch (e) {}
  // `pageNumbers[i]` is the source page of `pages[i]` — the caller needs it to splice OCR text back
  // at the right position when only a subset was rendered.
  return { pages, total, rendered: pages.length, pageNumbers: rendered };
}

const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'text']);
const SHEET_EXT = new Set(['xlsx', 'xlsm', 'csv', 'tsv', 'xls']);   // .xls legacy BIFF via SheetJS (added 2026-07-23 — the LA SoS roster is .xls-only)

// --- spreadsheets → markdown table (so a dropped roster/contact sheet flows through the doc pipeline) ---
// A minimal RFC-4180-ish delimited parse (quoted fields, escaped "", CRLF). Returns rows of string cells.
function parseCsv(text, delim = ',') {
  const rows = []; let row = [], field = '', q = false;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
// Rows (array of string-cell arrays) → a GitHub markdown table. First non-empty row is the header. Pure.
function rowsToMarkdownTable(rows) {
  const clean = (Array.isArray(rows) ? rows : []).filter(r => Array.isArray(r) && r.some(c => String(c == null ? '' : c).trim() !== ''));
  if (!clean.length) return '';
  const width = Math.max(...clean.map(r => r.length));
  const esc = (c) => String(c == null ? '' : c).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
  const pad = (r) => { const a = r.map(esc); while (a.length < width) a.push(''); return a; };
  const header = pad(clean[0]);
  const out = ['| ' + header.join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |'];
  for (const r of clean.slice(1)) out.push('| ' + pad(r).join(' | ') + ' |');
  return out.join('\n');
}
// Read an .xlsx (every sheet) or .csv into markdown table text. exceljs (MIT) for xlsx; plain parse for csv.
async function extractSpreadsheet(filePath) {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  if (ext === 'csv' || ext === 'tsv') return { markdown: rowsToMarkdownTable(parseCsv(fs.readFileSync(filePath, 'utf8'), ext === 'tsv' ? '\t' : ',')), format: ext };
  // legacy BIFF .xls → SheetJS (2026-07-23): the LA SoS 6,695-row roster the inquiry downloaded is
  // .xls-only; her own next_step literally asked for "a tool that can read XLS files".
  if (ext === 'xls') {
    const XLSX = require('xlsx');
    const wb = XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });
    const parts = [];
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
      const table = rowsToMarkdownTable(rows);
      if (table) { parts.push(`## ${name}`); parts.push(table); }
    }
    return { markdown: parts.join('\n\n'), format: 'xls' };
  }
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const parts = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(cell && cell.text != null ? String(cell.text) : ''));
      rows.push(cells);
    });
    const table = rowsToMarkdownTable(rows);
    if (table) { parts.push(`## ${ws.name || 'Sheet'}`); parts.push(table); }
  });
  return { markdown: parts.join('\n\n'), format: 'xlsx' };
}

// Dispatch a file path to the right extractor → { markdown, format, ... }. Text formats read directly.
async function extractToMarkdown(filePath) {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  if (TEXT_EXT.has(ext)) return { markdown: fs.readFileSync(filePath, 'utf8'), format: ext === 'markdown' ? 'md' : (ext === 'text' ? 'txt' : ext) };
  if (SHEET_EXT.has(ext)) return { ...(await extractSpreadsheet(filePath)), format: ext };
  if (ext === 'docx') return { ...(await extractDocx(filePath)), format: 'docx' };
  if (ext === 'pdf') return { ...(await extractPdf(filePath)), format: 'pdf' };
  throw new Error(`extractToMarkdown: unsupported extension .${ext}`);
}

module.exports = { pdfDocOptions, pdfWasmUrl, decodeEntities, inlineMd, htmlToMarkdown, sanitizeHtml, extractDocx, extractDocxHtml, extractPdf, findPageFurniture, furnitureKey, rasterizePdf, extractToMarkdown, parseCsv, rowsToMarkdownTable, extractSpreadsheet, TEXT_EXT, SHEET_EXT };
