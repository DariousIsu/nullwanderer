/**
 * LIVE-FIRE the doc-extract worker in a REAL Electron utilityProcess — the exact environment where
 * pdfjs mis-detected a browser and died on "DOMMatrix is not defined" (need #101, 152 failures).
 * A minimal Electron main forks lib/doc_extract_worker.js exactly as lib/doc_extract_host does and
 * posts both ops on a real PDF. Before the env-shape cure this fails; after, both ops are green.
 *
 * Run: ./node_modules/.bin/electron scripts/livefire_doc_extract_worker.js [pdf]
 * (Plain electron, NOT ELECTRON_RUN_AS_NODE — the whole point is the real utilityProcess.)
 */
'use strict';
const path = require('path');
const { app, utilityProcess } = require('electron');

const PDF = process.argv[2] || path.join(__dirname, '..', 'data', 'certs', 'CFC-2026-07-20-01.pdf');

function job(child, id, op, filePath, opts) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${op} timed out (60s)`)), 60000);
    const onMsg = (m) => {
      if (!m || m.id !== id) return;
      clearTimeout(timer); child.removeListener('message', onMsg);
      m.ok ? resolve(m.result) : reject(new Error(m.error || `${op} failed`));
    };
    child.on('message', onMsg);
    child.postMessage({ id, op, filePath, opts });
  });
}

app.whenReady().then(async () => {
  let fail = 0;
  const child = utilityProcess.fork(path.join(__dirname, '..', 'lib', 'doc_extract_worker.js'), [], { serviceName: 'doc-extract-livefire' });
  try {
    const md = await job(child, 1, 'extractToMarkdown', PDF);
    console.log(`PASS extractToMarkdown in a REAL utilityProcess — ${String(md.markdown || '').length} chars, format ${md.format}`);
  } catch (e) { fail++; console.error(`FAIL extractToMarkdown: ${e.message}`); }
  try {
    const r = await job(child, 2, 'rasterizePdf', PDF, { maxPages: 1 });
    console.log(`PASS rasterizePdf in a REAL utilityProcess — ${(r.pages || []).length} page(s) rendered`);
  } catch (e) { fail++; console.error(`FAIL rasterizePdf: ${e.message}`); }
  try { child.kill(); } catch {}
  console.log(fail === 0 ? '\nLIVE-FIRE GREEN — the #101 environment is cured where it actually runs' : `\nLIVE-FIRE RED — ${fail} op(s) failed`);
  app.exit(fail === 0 ? 0 : 1);
});
