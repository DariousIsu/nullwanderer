/* Smoke: lib/file_ingest (dropped-file content extraction: text layer → vision) + canvas_ingest.fileSrcOf.
 * Fully offline — every I/O dep (doc_extract, vision, fs) is mocked.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_file_ingest.js
 */
'use strict';
const FI = require('../lib/file_ingest');
const CI = require('../lib/canvas_ingest');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- srcToPath: file:// → OS path, url-decoded ---
ok(FI.srcToPath('file:///C:/Users/x/a.pdf') === 'C:/Users/x/a.pdf', 'srcToPath: strips file:///');
ok(FI.srcToPath('file:///C:/Users/x/a%20b.pdf') === 'C:/Users/x/a b.pdf', 'srcToPath: url-decodes (%20 → space)');
ok(FI.srcToPath('C:/plain/path.png') === 'C:/plain/path.png', 'srcToPath: passes a bare path through');

const path = require('path');
const baseDeps = (over) => Object.assign({ path, fileExists: () => true, log: () => {} }, over);

(async () => {
  // missing file
  ok((await FI.extractDroppedFile('file:///x/gone.pdf', { deps: baseDeps({ fileExists: () => false }) })).via === 'missing', 'extract: nonexistent file → missing');

  // TEXT LAYER: a real-text PDF (mock doc_extract) → doc_extract path, no vision called
  let visionCalled = false;
  const r1 = await FI.extractDroppedFile('file:///d/flyer.pdf', { deps: baseDeps({
    extractToMarkdown: async () => ({ markdown: 'Faith in Elections Prayer Breakfast — Ted Alexander, Brad Overcash, AC Hotel Raleigh NC.' }),
    describe: async () => { visionCalled = true; return { ok: true, text: 'x'.repeat(50) }; },
    readFileBase64: () => 'b64',
  }) });
  ok(r1.via === 'doc_extract:pdf' && /Ted Alexander/.test(r1.text), 'extract: text-layer PDF → doc_extract:pdf (real text)');
  ok(visionCalled === false, 'extract: a good text layer does NOT invoke vision (no cost)');

  // TEXT LAYER thin + PDF (not an image) → no vision fallback → thin
  ok((await FI.extractDroppedFile('file:///d/graphic.pdf', { deps: baseDeps({ extractToMarkdown: async () => ({ markdown: 'tiny' }) }) })).via === 'thin', 'extract: thin-text PDF (no image fallback yet) → thin');

  // VISION: an image drop → vision.describe transcribes it
  const r2 = await FI.extractDroppedFile('file:///d/invite.png', { deps: baseDeps({
    readFileBase64: () => 'IMGB64',
    describe: async ({ imageBase64, prompt }) => { ok(imageBase64 === 'IMGB64' && /Transcribe ALL text/i.test(prompt), 'extract: vision gets the image bytes + a transcription prompt'); return { ok: true, text: 'RAINEY CENTER — Prayer Breakfast. Ted Alexander (Senator, NC). Raleigh.' }; },
  }) });
  ok(r2.via === 'vision:png' && /Ted Alexander/.test(r2.text), 'extract: image drop → vision:png (transcribed content)');

  // VISION thin (model returns little) → thin
  ok((await FI.extractDroppedFile('file:///d/blank.jpg', { deps: baseDeps({ readFileBase64: () => 'b', describe: async () => ({ ok: true, text: 'a' }) }) })).via === 'thin', 'extract: vision returns too little → thin');
  // vision fails (ok:false) → thin, fail-soft
  ok((await FI.extractDroppedFile('file:///d/x.jpg', { deps: baseDeps({ readFileBase64: () => 'b', describe: async () => ({ ok: false, reason: 'model 404' }) }) })).via === 'thin', 'extract: vision ok:false → thin (fail-soft)');

  // doc_extract throws → fail-soft (pdf, no image fallback → thin)
  ok((await FI.extractDroppedFile('file:///d/bad.pdf', { deps: baseDeps({ extractToMarkdown: async () => { throw new Error('corrupt'); } }) })).via === 'thin', 'extract: doc_extract throw → fail-soft → thin');

  // spreadsheets are now SUPPORTED (routed to the text layer via doc_extract), not 'unsupported'
  ok((await FI.extractDroppedFile('file:///d/roster.xlsx', { deps: baseDeps({ extractToMarkdown: async () => ({ markdown: '| Name | Email |\n| --- | --- |\n| Brad | brad@x.gov |' }) }) })).via === 'doc_extract:xlsx', 'extract: .xlsx → doc_extract:xlsx (spreadsheet supported)');
  // a genuinely unsupported binary type still returns 'unsupported'
  ok((await FI.extractDroppedFile('file:///d/archive.zip', { deps: baseDeps({}) })).via === 'unsupported', 'extract: unsupported ext (.zip) → unsupported');

  // --- canvas_ingest.fileSrcOf: find the document_file src among blocks ---
  const fileBlocks = [{ type: 'document_file', data: { src: 'file:///C:/Users/x/flyer.pdf', alt: 'flyer' } }];
  ok(CI.fileSrcOf(fileBlocks) === 'file:///C:/Users/x/flyer.pdf', 'fileSrcOf: returns the document_file src');
  ok(CI.fileSrcOf([{ type: 'text', data: { markdown: 'hello' } }]) === '', 'fileSrcOf: a text block → "" (no file)');
  ok(CI.fileSrcOf([{ data: { url: 'https://x/img.png' } }]) === 'https://x/img.png', 'fileSrcOf: honors a url to an image/pdf');
  ok(CI.fileSrcOf([]) === '' && CI.fileSrcOf(null) === '', 'fileSrcOf: empty/null → ""');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
