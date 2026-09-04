'use strict';
/**
 * lib/fs_worker.js — filesystem probes OFF the main thread (cut 22, 2026-09-04).
 *
 * The paper conductor's fragment gather (lib/paper_finalize.gatherFragments) walks the notes
 * workspace: readdir, then a stat and a 4 KB head read for EVERY .md file, then a full read for
 * the matches. Cut 18 shrank the read to the head; the stat storm stayed — 2,665 files, a 1.5 s
 * profiled block on boot_p279, and the directed driver runs the probe on EVERY tick of a paper
 * focus (main.js runDirectedResearchPass, the gather signature). The probe now runs in a worker
 * thread, same request/response shape as lib/db_worker; the predicate is ONE function used by
 * both the thread and the synchronous fallback, so the two can never drift.
 */
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const HEAD_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 60000;

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }

// The first HEAD_BYTES of a file as UTF-8 (≥ 800 characters at any width — the probe's window), or null
// when the file cannot be opened. A multibyte character cut at the boundary decodes as U+FFFD, which
// norm discards; the probe never sees it.
function readHead(p, headBytes = HEAD_BYTES) {
  let fd = null;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(headBytes);
    const n = fs.readSync(fd, buf, 0, headBytes, 0);
    return buf.toString('utf8', 0, n);
  } catch { return null; }
  finally { if (fd != null) { try { fs.closeSync(fd); } catch {} } }
}

/**
 * probeFragmentsSync({ dir, toks, ex, maxFragments, maxTotalChars }) → [{ file, mtime, text }]
 * `toks` / `ex` are ALREADY normalized (norm). Files whose NAME or 800-char HEAD carries every token
 * and none of the exclude tokens, newest first, capped by count and by total characters.
 */
function probeFragmentsSync({ dir, toks = [], ex = [], maxFragments = 25, maxTotalChars = 400000, headBytes = HEAD_BYTES } = {}) {
  if (!toks.length) return [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return []; }
  const out = [];
  for (const f of names) {
    const p = path.join(dir, f);
    let st; try { st = fs.statSync(p); } catch { continue; }
    const head = readHead(p, headBytes);
    if (head == null) continue;
    const probe = norm(f + ' ' + head.slice(0, 800));
    if (ex.some((t) => probe.includes(t))) continue;
    if (!toks.every((t) => probe.includes(t))) continue;
    let text; try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    out.push({ file: f, mtime: st.mtimeMs, text });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  const capped = out.slice(0, maxFragments);
  let total = 0;
  return capped.filter((x) => { total += x.text.length; return total <= maxTotalChars; });
}

// ── the worker door (main thread side) ─────────────────────────────────────────────────────────
let _entry = null;   // { w, pending: Map<id, {resolve, reject, timer}>, seq }

function _drop(err) {
  const e = _entry; if (!e) return;
  _entry = null;
  for (const [, p] of e.pending) { clearTimeout(p.timer); p.reject(err); }
  e.pending.clear();
  const w = e.w; e.w = null;
  if (w) { try { w.terminate().catch(() => {}); } catch {} }
}

function _get() {
  if (_entry && _entry.w) return _entry;
  const entry = { w: null, pending: new Map(), seq: 0 };
  const w = new Worker(__filename, { workerData: { __fsWorker: true } });
  w.unref();
  w.on('message', (m) => {
    const p = entry.pending.get(m.id);
    if (!p) return;
    entry.pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.rows);
  });
  w.on('error', (e) => { if (_entry === entry) _drop(e instanceof Error ? e : new Error(String(e))); });
  w.on('exit', (code) => { if (_entry === entry) _drop(new Error(`fs worker exited (${code})`)); });
  entry.w = w;
  _entry = entry;
  return entry;
}

/** The probe in the worker thread. Rejects on a worker error or after `timeoutMs`; the caller falls back. */
function probeFragments(opts = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let entry;
    try { entry = _get(); } catch (err) { return reject(err); }
    const id = ++entry.seq;
    const timer = setTimeout(() => {
      if (!entry.pending.has(id)) return;
      entry.pending.delete(id);
      reject(new Error(`fs worker timeout after ${timeoutMs}ms`));
      if (_entry === entry) _drop(new Error('fs worker dropped after a timeout'));
    }, timeoutMs);
    timer.unref?.();
    entry.pending.set(id, { resolve, reject, timer });
    try { entry.w.postMessage({ id, kind: 'fragments', opts: { ...opts, toks: [...(opts.toks || [])], ex: [...(opts.ex || [])] } }); }
    catch (err) { entry.pending.delete(id); clearTimeout(timer); reject(err); }
  });
}

async function close() { const e = _entry; const w = e && e.w; _drop(new Error('fs worker closed')); if (w) { try { await w.terminate(); } catch {} } }
function _live() { return !!(_entry && _entry.w); }

module.exports = { probeFragments, probeFragmentsSync, readHead, norm, close, HEAD_BYTES, DEFAULT_TIMEOUT_MS, _live };

// ── worker entry: this module re-runs in the thread with workerData set ─────────────────────────
try {
  if (!isMainThread && workerData && workerData.__fsWorker) {
    parentPort.on('message', (m) => {
      try {
        if (m.kind !== 'fragments') throw new Error(`unknown fs job: ${m.kind}`);
        parentPort.postMessage({ id: m.id, rows: probeFragmentsSync(m.opts || {}) });
      } catch (e) { parentPort.postMessage({ id: m.id, error: (e && e.message) || String(e) }); }
    });
  }
} catch { /* not a worker context */ }
