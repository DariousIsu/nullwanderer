/* smoke_pdf_wasm.js — pdf.js can decode images (blocker #3).
 *
 * pdfjs v6 decodes JPEG 2000 and JBIG2 in WebAssembly and will not guess where the .wasm files live.
 * Without `wasmUrl` it built the fallback path from an unset base and failed with, literally:
 *
 *   Cannot find package 'nullopenjpeg_nowasm_fallback.js'
 *   Unable to decode image "img_p0_1": "JpxError: OpenJPEG failed to initialize"    (×100 in one boot)
 *
 * Measured on Arapahoe County's "All Districts Map.pdf", page 1 at the same scale:
 *   without wasmUrl        94,240 bytes   ← the map never drew
 *   with    wasmUrl    11,931,080 bytes   ← the map drew
 *
 * The failure was SILENT in the only way that matters: the text layer is empty either way, the
 * rasterize→vision fallback fires either way, and vision is handed a page with the content missing.
 * A scanned roster was indistinguishable from a body that has no roster.
 *
 * Offline and deterministic — no file needed, this asserts the CONFIG that decides it.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_pdf_wasm.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const de = require('../lib/doc_extract');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ── the decoders are actually on disk ────────────────────────────────────────────────────────────
const wasmDir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'wasm');
ok(fs.existsSync(path.join(wasmDir, 'openjpeg.wasm')), 'openjpeg.wasm ships with pdfjs-dist');
ok(fs.existsSync(path.join(wasmDir, 'jbig2.wasm')), 'jbig2.wasm ships too — scanned documents use it');

// ── the config that points at them ───────────────────────────────────────────────────────────────
const opts = de.pdfDocOptions(new Uint8Array([1, 2, 3]));
ok(typeof opts.wasmUrl === 'string' && opts.wasmUrl.length > 0,
  'CRITICAL: wasmUrl is set — without it every JPEG-2000 image in every PDF silently fails to decode');
ok(/^file:\/\//.test(opts.wasmUrl),
  'CRITICAL: it is a file:// URL — a bare path is not a valid factory url to pdfjs');
ok(opts.wasmUrl.endsWith('/'),
  'CRITICAL: trailing slash — pdfjs rejects the path outright without it ("must include trailing slash")');
ok(!/(^|\/)null/.test(opts.wasmUrl),
  'CRITICAL: no "null" segment — that literal string is what the broken fallback path contained');
ok(fs.existsSync(new URL(`${opts.wasmUrl}openjpeg.wasm`)),
  'CRITICAL: the URL actually resolves to the decoder on disk, not just to a plausible-looking string');

// ── the rest of the config survived ──────────────────────────────────────────────────────────────
ok(opts.useSystemFonts === true && opts.isEvalSupported === false && opts.data instanceof Uint8Array,
  'the existing options are preserved — this adds a decoder path, it does not restyle the loader');

// ── every call site goes through it ──────────────────────────────────────────────────────────────
// The failure was invisible for months precisely because it lived at a call site nobody re-read. A new
// getDocument that builds its own options would lose image decoding again with no error anywhere.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'doc_extract.js'), 'utf8');
  const calls = (src.match(/getDocument\(/g) || []).length;
  const shared = (src.match(/getDocument\(pdfDocOptions\(/g) || []).length;
  ok(calls > 0 && calls === shared,
    `CRITICAL: all ${calls} getDocument call(s) use pdfDocOptions — a hand-rolled one silently loses image decoding`);
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
