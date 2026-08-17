'use strict';
/**
 * lib/doc_extract_host.js — offloads doc_extract's CPU-heavy work to an Electron utilityProcess so PDF/docx/
 * xlsx extraction stops blocking the MAIN event loop.
 *
 * WHY (2026-08-17): measured — the dl-ingest idle path called lib/doc_extract (pdfjs decode + @napi-rs/canvas
 * rasterization) ON the main process, freezing the event loop ~4.8s per document (101s across one run, 21
 * docs). This runs the SAME doc_extract in a child process (lib/doc_extract_worker). Same signatures as
 * doc_extract, so a call site swaps `de.extractToMarkdown` → `host.extractToMarkdown`. A long-lived child is
 * reused across jobs and respawned if it dies; a wedged job recycles the child so the next document is clean.
 *
 * FAIL-SAFE (mirrors lib/memory's embed worker): if the utilityProcess can't be created — not an Electron main
 * process (e.g. a smoke, where require('electron') is just the binary path), or a spawn error — or a job
 * errors/times out, we fall back to in-process doc_extract, so behaviour never regresses; this only changes
 * WHERE the compute happens.
 */
const path = require('path');

const JOB_TIMEOUT_MS = parseInt(process.env.ZOE_DOC_EXTRACT_TIMEOUT_MS, 10) || 120000;
let _child = null, _seq = 0, _dead = false;
const _pending = new Map();

function _inProcess(op, filePath, opts) {
  const de = require('./doc_extract');
  return op === 'extractToMarkdown' ? de.extractToMarkdown(filePath) : de.rasterizePdf(filePath, opts || {});
}

function _rejectAll(err) {
  for (const [id, p] of _pending) { try { clearTimeout(p.timer); } catch {} try { p.reject(err); } catch {} _pending.delete(id); }
}

function _getChild() {
  if (_dead) return null;
  if (_child) return _child;
  let utilityProcess = null;
  try { ({ utilityProcess } = require('electron')); } catch {}
  if (!utilityProcess || typeof utilityProcess.fork !== 'function') { _dead = true; return null; }   // not an Electron main process → in-process
  try {
    const c = utilityProcess.fork(path.join(__dirname, 'doc_extract_worker.js'), [], { serviceName: 'doc-extract' });
    c.on('message', (m) => {
      const p = m && _pending.get(m.id);
      if (!p) return;
      _pending.delete(m.id); try { clearTimeout(p.timer); } catch {}
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'doc_extract_worker failed'));
    });
    c.on('exit', () => { _child = null; _rejectAll(new Error('doc_extract worker exited')); });   // respawn on next job
    _child = c;
  } catch (e) { _dead = true; _child = null; console.error('[doc-extract] worker spawn failed → in-process:', e && e.message); return null; }
  return _child;
}

async function _run(op, filePath, opts) {
  const child = _getChild();
  if (!child) return _inProcess(op, filePath, opts);   // FAIL-SAFE: no utilityProcess (smoke / non-electron)
  try {
    return await new Promise((resolve, reject) => {
      const id = ++_seq;
      const timer = setTimeout(() => {
        _pending.delete(id);
        try { child.kill(); } catch {}   // recycle a wedged child so the NEXT document gets a fresh one
        if (_child === child) _child = null;
        reject(new Error('doc_extract worker timeout'));
      }, JOB_TIMEOUT_MS);
      _pending.set(id, { resolve, reject, timer });
      try { child.postMessage({ id, op, filePath, opts }); } catch (e) { _pending.delete(id); clearTimeout(timer); reject(e); }
    });
  } catch (e) {
    console.error('[doc-extract] worker job failed → in-process:', e && e.message);
    return _inProcess(op, filePath, opts);   // a worker hiccup must never break extraction
  }
}

function extractToMarkdown(filePath) { return _run('extractToMarkdown', filePath, null); }
function rasterizePdf(filePath, opts) { return _run('rasterizePdf', filePath, opts); }
function _shutdown() { try { _child && _child.kill(); } catch {} _child = null; }

module.exports = { extractToMarkdown, rasterizePdf, _shutdown };
