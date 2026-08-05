'use strict';
/**
 * lib/embed_worker.js — the bge-small feature-extraction pipeline running in a WORKER THREAD.
 *
 * WHY (2026-08-04): transformers.js is WASM and runs SYNCHRONOUSLY in-process; on the MAIN thread each
 * embed blocked the event loop for its whole compute (40-60ms for a long utterance). Hot lanes embed in
 * bursts (heartbeat self-repeat, doc decomposition entity-resolution, reflection), so those bursts froze
 * typing / IPC / the Echo heartbeat for seconds — the recurring main-thread stall. Moving the pipeline to a
 * worker means embedding compute never touches the main event loop again; the main side only posts a string
 * and awaits a small vector over the message channel. The LRU cache stays on the MAIN side so a hit doesn't
 * even round-trip here.
 *
 * Protocol: main posts { id, text }; we reply { id, vector } on success or { id, error } on failure. The
 * main side (lib/memory.embed) falls back to an in-process embed if the worker ever errors, so embeddings
 * can never break — this only moves WHERE the compute happens.
 */
const { parentPort, workerData } = require('worker_threads');

let _extractor = null;
let _loading = null;

async function getExtractor() {
  if (_extractor) return _extractor;
  if (_loading) return _loading;
  _loading = (async () => {
    const { pipeline, env } = await import('@xenova/transformers');
    try { if (workerData && workerData.cacheDir) env.cacheDir = workerData.cacheDir; } catch {}
    _extractor = await pipeline('feature-extraction', (workerData && workerData.model) || 'Xenova/bge-small-en-v1.5');
    return _extractor;
  })();
  return _loading;
}

parentPort.on('message', async (msg) => {
  const id = msg && msg.id;
  try {
    const ex = await getExtractor();
    const out = await ex(String((msg && msg.text) == null ? '' : msg.text), { pooling: 'mean', normalize: true });
    parentPort.postMessage({ id, vector: Array.from(out.data) });
  } catch (e) {
    parentPort.postMessage({ id, error: (e && e.message) || String(e) });
  }
});
