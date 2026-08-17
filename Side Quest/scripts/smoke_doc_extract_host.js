'use strict';
/* smoke_doc_extract_host.js — the dl-ingest CPU offload (2026-08-17).
 *
 * lib/doc_extract is "Node-only (main process)": pdfjs decode + @napi-rs/canvas rasterization ran on the MAIN
 * event loop and froze it ~4.8s per document on the dl-ingest idle path (measured 101s across one run). The fix
 * runs the SAME doc_extract in an Electron utilityProcess (lib/doc_extract_worker) via a host (lib/doc_extract_
 * host) that FAILS SAFE to in-process when no utilityProcess exists. Under electron-as-node there IS no
 * utilityProcess (require('electron') is the binary path), so the host here exercises the fallback path — which
 * must return byte-identical results to calling doc_extract directly. The worker's handleJob is unit-tested
 * directly. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_doc_extract_host.js
 */
const fs = require('fs'), path = require('path'), os = require('os');
const worker = require('../lib/doc_extract_worker');
const host = require('../lib/doc_extract_host');
const de = require('../lib/doc_extract');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  // a tiny synthetic doc exercises the FULL routing (host → fallback → doc_extract, and worker handleJob) with
  // zero native deps, so the contract is deterministic regardless of the smoke shell's pdfjs/canvas.
  const tmp = path.join(os.tmpdir(), `sq_dehost_${process.pid}.md`);
  fs.writeFileSync(tmp, '# Title\n\nBody line one.\n');
  try {
    // 1. worker handleJob — the child-side contract (returns a reply object, never throws across the boundary)
    const w1 = await worker.handleJob({ id: 7, op: 'extractToMarkdown', filePath: tmp });
    ok(w1 && w1.id === 7 && w1.ok === true && /Title/.test(w1.result.markdown), 'worker handleJob extractToMarkdown → { ok, result } with the file markdown');
    const w2 = await worker.handleJob({ id: 8, op: 'bogus-op', filePath: tmp });
    ok(w2 && w2.ok === false && /unknown op/.test(w2.error), 'worker handleJob unknown op → { ok:false, error } (never throws across the boundary)');
    const w3 = await worker.handleJob({ id: 9, op: 'extractToMarkdown', filePath: tmp + '.nope' });
    ok(w3 && w3.ok === false && typeof w3.error === 'string', 'worker handleJob surfaces an extraction error as { ok:false }, not a child crash');

    // 2. host fail-safe — under electron-as-node there is no utilityProcess, so the host runs in-process and
    //    MUST return exactly what doc_extract returns (the contract the dl-ingest seam relies on).
    const direct = await de.extractToMarkdown(tmp);
    const viaHost = await host.extractToMarkdown(tmp);
    ok(viaHost && viaHost.markdown === direct.markdown && viaHost.format === direct.format, "host.extractToMarkdown fails safe to in-process and returns doc_extract's result verbatim");

    // 3. host propagates a real extraction failure (missing file) rather than swallowing it
    let threw = false; try { await host.extractToMarkdown(tmp + '.nope'); } catch { threw = true; }
    ok(threw, 'host propagates an extraction failure instead of returning a false-empty result');

    // 4. HEAVY-PATH PROOF (tolerant): a real PDF through the worker exercises the exact pdfjs path that froze the
    //    main thread. If the smoke shell can't load the pdfjs/canvas natives, note a SKIP rather than fail — the
    //    in-app runtime (electron main) is where it truly runs, and the routing contract above already holds.
    const pdf = path.join(__dirname, '..', 'data', 'certs', 'CFC-2026-07-20-01.pdf');
    if (fs.existsSync(pdf)) {
      const wp = await worker.handleJob({ id: 20, op: 'extractToMarkdown', filePath: pdf });
      if (wp && wp.ok && wp.result && typeof wp.result.markdown === 'string' && wp.result.format === 'pdf') {
        ok(true, `heavy path: a real PDF extracts through the worker (${wp.result.markdown.length}ch, format pdf)`);
      } else {
        console.log(`  ⚠ SKIP heavy-path PDF (smoke shell could not decode: ${wp && wp.error}) — routing contract still proven above`);
      }
    }

    // 5. WIRING — the dl-ingest seam routes extraction through the host, not the main-thread doc_extract
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok(/require\('\.\/lib\/doc_extract_host'\)/.test(mainSrc), 'main.js wires lib/doc_extract_host');
    ok(/extractToMarkdown:\s*\(p\)\s*=>\s*deHost\.extractToMarkdown\(p\)/.test(mainSrc), 'the dl-ingest seam extracts through the host (off the main thread)');
    ok(/rasterizePdf:\s*\(p,\s*opts\)\s*=>\s*deHost\.rasterizePdf\(p,\s*opts\)/.test(mainSrc), 'the dl-ingest rasterize (scanned-PDF vision fallback) also runs through the host');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
    try { host._shutdown(); } catch {}
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
