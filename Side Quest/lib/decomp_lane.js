/**
 * lib/decomp_lane.js — the PER-STREAM inline decomposition lane (curation substrate Slice 2, Split 2;
 * see docs/CURATION_SUBSTRATE_DESIGN.md).
 *
 * Split 1 built the shared machine (lib/doc_decompose). Split 2 folds the raw-data streams in ONE AT A
 * TIME, each with its own inline hook + stream-specific extraction guidelines, appended AFTER that
 * stream's existing targeted-usage hooks. Fall-throughs (ambiguous / unresolved) land as `held`
 * observations — the queue the hourly "standard upgrade pass" (the lake) re-attempts.
 *
 * This module is the reusable seam: a cloud-extractor factory every stream shares, and per-stream
 * adapters that shape a stream's item into the machine's { title, url, text } contract. Stream 1 =
 * doc_store landings (canvas drops, deliverables, meeting notes, research dossiers). PURE /
 * deps-injected → offline-smoke-testable; the app supplies the live model + echo + store in main.js.
 */
'use strict';
const doc_decompose = require('./doc_decompose');

// Build a cloud-model TYPED extractor (mirrors monologue's cloud()). `completeFn` = ollama.completeDetailed
// (injected). `buildPrompt` is the per-stream guidelines seam — default is the generic typed prompt; a
// stream that wants tailored rules passes its own. Returns extract(text,{title}) → { entities, relations }.
function makeCloudExtractor({ completeFn, model, base = undefined, token = null, buildPrompt = doc_decompose.buildTypedPrompt, parse = doc_decompose.parseTypedExtraction, numPredict = 400, timeoutMs = 120000 } = {}) {
  return async (text, { title } = {}) => {
    if (typeof completeFn !== 'function' || !model) return { entities: [], relations: [] };
    const out = await completeFn({
      model, messages: buildPrompt(text, { title }), base,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      options: { temperature: 0.2, top_p: 0.9, num_ctx: 8192, num_predict: numPredict },
      think: false, timeoutMs,
    });
    const raw = typeof out === 'string' ? out : ((out && out.text) || (out && out.thinking) || '');
    return parse(raw);
  };
}

// STREAM 1 adapter — a doc_store landing → the machine. `doc` = a documents-table row / land() input
// ({ id, title, body, ref, source }). The document IS the citation (grade B): url = its ref, else a
// stable `docstore:<id>` pointer. Thin/uncited landings are skipped (nothing to decompose). Returns the
// decomposeDoc tallies, or { skipped, reason }.
async function decomposeLanding(doc = {}, { extract, resolve, dispatch, observe, cap = null, log } = {}) {
  const id = doc.id;
  const text = String(doc.body == null ? '' : doc.body);
  const title = doc.title || null;
  const url = doc.ref || (id != null ? `docstore:${id}` : null);   // the landed document is the source
  if (!text.trim()) return { skipped: true, reason: 'thin' };
  if (!url) return { skipped: true, reason: 'uncited' };
  return doc_decompose.decomposeDoc({ title, url, text }, { extract, resolve, dispatch, observe, cap: cap || { entities: 12, relations: 12 }, log });
}

module.exports = { makeCloudExtractor, decomposeLanding };
