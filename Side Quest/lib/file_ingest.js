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
const TEXT_DOC_EXT = new Set(['pdf', 'docx', 'txt', 'text', 'md', 'markdown']);
const MIN_TEXT = 40;   // below this a "document" is too thin to be worth landing (mirrors the canvas guard)

// A transcription-first prompt so the returned text is decomposition-ready (raw content, not a summary).
const VISION_PROMPT = 'This image is a document, flyer, invitation, or screenshot. Transcribe ALL text visible in it, exactly and completely. Then, on new lines, list every person, organization, event, date, and location shown. Be literal — never invent anything that is not actually visible.';

// Turn a file:// src (or a bare path) into an OS path.
function srcToPath(src) {
  let p = String(src == null ? '' : src).trim().replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '');
  try { p = decodeURIComponent(p); } catch {}
  return p;
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
      if (md.length >= MIN_TEXT) return { text: md, via: 'doc_extract:' + ext, filePath };
      deps.log && deps.log(`[file-ingest] text layer thin (${md.length}ch) for .${ext} — ${IMAGE_EXT.has(ext) ? 'vision fallback' : 'no image fallback for this type'}`);
    } catch (e) { deps.log && deps.log('[file-ingest] doc_extract failed: ' + (e && e.message)); }
  }

  // 2) VISION — an image file (a true graphic drop, or a screenshot). Rasterized-PDF vision is a follow-up.
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

module.exports = { extractDroppedFile, srcToPath, extOf, IMAGE_EXT, TEXT_DOC_EXT, MIN_TEXT, VISION_PROMPT };
