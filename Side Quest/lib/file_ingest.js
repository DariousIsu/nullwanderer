/**
 * lib/file_ingest.js — read the CONTENT of a document Lucas drops on the canvas as a FILE (a
 * `document_file` block whose `data.src` is a file:// path), so graphical / binary docs stop passing
 * through invisibly. The canvas ingest only ever read canvas text BLOCKS; a dropped PDF/image has none,
 * so the whole doc (its people/orgs/events) was lost. This reads the actual file, two layers:
 *
 *   1. TEXT LAYER  — .pdf/.docx/.txt/.md via lib/doc_extract (a real text-layer PDF like an exported
 *                    flyer yields clean text; no vision cost).
 *   2. VISION      — an image file (.png/.jpg/…), or later a rasterized graphic PDF, via lib/vision
 *                    (gemma4:31b): transcribe the text + name the entities shown.
 *
 * Whatever it recovers flows into the SAME land → understand → decompose pipeline as a typed drop. Pure
 * orchestration with every I/O dep injected → offline-smoke-testable. Fail-soft: any miss → {text:''}.
 */
'use strict';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
// spreadsheets (xlsx/csv) read via doc_extract → a markdown table, so a dropped roster flows through the
// same text pipeline as any doc (doc_store.land → surfaceDocCards → cards).
const TEXT_DOC_EXT = new Set(['pdf', 'docx', 'txt', 'text', 'md', 'markdown', 'xlsx', 'xlsm', 'csv', 'tsv', 'xls']);
const MIN_TEXT = 40;   // below this a "document" is too thin to be worth landing (mirrors the canvas guard)

// A transcription-first prompt so the returned text is decomposition-ready (raw content, not a summary).
const VISION_PROMPT = 'This image is a document, flyer, invitation, or screenshot. Transcribe ALL text visible in it, exactly and completely. Then, on new lines, list every person, organization, event, date, and location shown. Be literal — never invent anything that is not actually visible.';

// Turn a file:// src (or a bare path) into an OS path.
function srcToPath(src) {
  let p = String(src == null ? '' : src).trim().replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '');
  try { p = decodeURIComponent(p); } catch {}
  return p;
}

// The INVERSE: an OS path → a real file:// URL, safe to hand a renderer. Lives here so the two halves stay
// together and are tested as a pair. Concatenating 'file:///' + path (what the canvas drop used to do) is
// wrong for any filename holding a URL-significant character: "July Poll #3.pdf" made everything after '#'
// a fragment, so the PDF iframe fetched a path that doesn't exist and rendered blank while the file sat
// happily on disk. pathToFileURL percent-encodes # ? % and spaces; srcToPath decodes them straight back.
function pathToSrc(p) {
  try { return require('url').pathToFileURL(String(p)).href; }
  catch { return 'file:///' + String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\/+/, ''); }
}
function extOf(filePath, pathMod) {
  return (pathMod.extname(filePath).replace(/^\./, '') || '').toLowerCase();
}

// Extract the readable content of a dropped file. deps (all injected):
//   extractToMarkdown(path) → { markdown } | throws   (lib/doc_extract)
//   describe({imageBase64, prompt}) → { ok, text }     (lib/vision)
//   readFileBase64(path) → base64 string
//   fileExists(path) → bool
//   path (node path), log
// Returns { text, via } where via ∈ 'doc_extract:<ext>' | 'vision:<ext>' | 'missing' | 'unsupported' | 'thin'.
async function extractDroppedFile(src, { deps = {} } = {}) {
  const pathMod = deps.path || require('path');
  const filePath = srcToPath(src);
  if (!filePath) return { text: '', via: 'missing' };
  const exists = deps.fileExists ? deps.fileExists(filePath) : false;
  if (!exists) return { text: '', via: 'missing', filePath };
  const ext = extOf(filePath, pathMod);

  // 1) TEXT LAYER — pdf/docx/txt/md
  if (TEXT_DOC_EXT.has(ext) && typeof deps.extractToMarkdown === 'function') {
    try {
      const r = await deps.extractToMarkdown(filePath);
      const md = String((r && r.markdown) || '').trim();
      // A PDF can have a GOOD text layer and still hide pages: a designed document mixes typeset
      // pages with image-only spreads. The whole-document thinness check below never fires for those,
      // so without carrying emptyPages up they are dropped in silence and the operator reviews a
      // document that is quietly missing pages. Surfaced, not auto-OCR'd — vision costs a call each.
      if (md.length >= MIN_TEXT) {
        const out = { text: md, via: 'doc_extract:' + ext, filePath };
        if (r && Array.isArray(r.emptyPages) && r.emptyPages.length) {
          out.emptyPages = r.emptyPages;
          out.pages = r.pages;
          deps.log && deps.log(`[file-ingest] ${ext} has ${r.emptyPages.length} page(s) with no text layer: ${r.emptyPages.join(', ')}`);
        }
        return out;
      }
      deps.log && deps.log(`[file-ingest] text layer thin (${md.length}ch) for .${ext} — ${ext === 'pdf' ? 'rasterize→vision fallback' : IMAGE_EXT.has(ext) ? 'vision fallback' : 'no image fallback for this type'}`);
    } catch (e) { deps.log && deps.log('[file-ingest] doc_extract failed: ' + (e && e.message)); }
  }

  // 1b) VISION FALLBACK FOR A SCANNED / IMAGE-ONLY PDF — the text layer was thin, so rasterize each
  //     page to a PNG (deps.rasterizePdf → lib/doc_extract) and OCR/transcribe it through the SAME
  //     vision path an image drop uses (deps.describe). This is the follow-up the header promised.
  if (ext === 'pdf' && typeof deps.rasterizePdf === 'function' && typeof deps.describe === 'function') {
    try {
      const { pages = [] } = await deps.rasterizePdf(filePath, { maxPages: 10, scale: 2 });
      const chunks = [];
      for (let i = 0; i < pages.length; i++) {
        const v = await deps.describe({ imageBase64: pages[i], prompt: VISION_PROMPT });
        const t = String((v && v.ok && v.text) || '').trim();
        if (t) chunks.push(`## Page ${i + 1}\n\n${t}`);
      }
      const text = chunks.join('\n\n').trim();
      if (text.length >= MIN_TEXT) return { text, via: 'vision:pdf', filePath, pages: pages.length };
      deps.log && deps.log(`[file-ingest] pdf vision returned ${text.length}ch across ${pages.length} page(s)`);
    } catch (e) { deps.log && deps.log('[file-ingest] pdf rasterize/vision failed: ' + (e && e.message)); }
  }

  // 2) VISION — an image file (a true graphic drop, or a screenshot).
  if (IMAGE_EXT.has(ext) && typeof deps.describe === 'function' && typeof deps.readFileBase64 === 'function') {
    try {
      const b64 = deps.readFileBase64(filePath);
      const v = await deps.describe({ imageBase64: b64, prompt: VISION_PROMPT });
      const t = String((v && v.ok && v.text) || '').trim();
      if (t.length >= MIN_TEXT) return { text: t, via: 'vision:' + ext, filePath };
      deps.log && deps.log(`[file-ingest] vision returned ${t.length}ch for .${ext}` + (v && !v.ok ? ` (${v.reason})` : ''));
    } catch (e) { deps.log && deps.log('[file-ingest] vision failed: ' + (e && e.message)); }
  }

  if (!TEXT_DOC_EXT.has(ext) && !IMAGE_EXT.has(ext)) return { text: '', via: 'unsupported', filePath, ext };
  return { text: '', via: 'thin', filePath, ext };
}

// A page with nothing on it makes a vision model ANSWER rather than stay silent — observed replies
// on a decorative PDF spread were "No text found." and "empty". Treating that as transcribed content
// is the dangerous case: spliced into a document under verification it becomes model-authored prose,
// and the author gets findings about a sentence they never wrote. Too short to be a page of prose,
// or shaped like a no-text reply, means blank.
const NO_TEXT_REPLY_RE = /^(no( readable| visible)? text[\s\S]{0,40}|empty|none|n\/a|\(?blank\)?|there is no text[\s\S]{0,40})\.?$/i;
function isBlankOcrReply(text, { minChars = MIN_TEXT } = {}) {
  const t = String(text == null ? '' : text).trim();
  return !t || t.length < minChars || NO_TEXT_REPLY_RE.test(t);
}

module.exports = { extractDroppedFile, srcToPath, pathToSrc, extOf, isBlankOcrReply, IMAGE_EXT, TEXT_DOC_EXT, MIN_TEXT, VISION_PROMPT };
