'use strict';
/**
 * lib/doc_extract_worker.js — doc_extract's CPU-heavy path, run in an Electron utilityProcess (a full Node
 * child) so it never touches the MAIN event loop.
 *
 * WHY (2026-08-17): lib/doc_extract is "Node-only (main process)" — extractPdf runs pdfjs decode + per-page
 * getTextContent, and rasterizePdf renders each page through @napi-rs/canvas. Both are synchronous CPU on the
 * main thread; the dl-ingest idle path froze the event loop ~4.8s per document (measured 101s across one run,
 * 21 documents — the dominant attributable main-thread stall). A utilityProcess (not a worker_thread) is used
 * deliberately: @napi-rs/canvas is a NATIVE addon and a full Node child is the safe place to load it. Only a
 * file PATH crosses the boundary; the reply is JSON-serializable (markdown string / base64 PNG pages), so
 * there is nothing shared and nothing to transfer specially.
 *
 * Protocol (mirrors lib/embed_worker): the host posts { id, op, filePath, opts }; we reply { id, ok, result }
 * on success or { id, ok:false, error } on failure. The host (lib/doc_extract_host) falls back to in-process
 * doc_extract on ANY failure, so extraction can never break — this only moves WHERE the compute happens.
 */
const de = require('./doc_extract');

async function handleJob(job) {
  const { id, op, filePath, opts } = job || {};
  try {
    let result;
    if (op === 'extractToMarkdown') result = await de.extractToMarkdown(filePath);
    else if (op === 'rasterizePdf') result = await de.rasterizePdf(filePath, opts || {});
    else throw new Error('doc_extract_worker: unknown op ' + op);
    return { id, ok: true, result };
  } catch (e) {
    return { id, ok: false, error: (e && e.message) || String(e) };
  }
}

// utilityProcess delivers messages via process.parentPort ({ data }); a classic child_process fork would use
// process.on('message'). Support both so the worker is drivable either way; export handleJob for offline tests.
if (process.parentPort) {
  process.parentPort.on('message', (e) => { handleJob(e && e.data).then((m) => { try { process.parentPort.postMessage(m); } catch {} }); });
} else if (typeof process.send === 'function') {
  process.on('message', (m) => { handleJob(m).then((r) => { try { process.send(r); } catch {} }); });
}

module.exports = { handleJob };
