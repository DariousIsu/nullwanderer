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
function makeCloudExtractor({ completeFn, model, base = undefined, token = null, buildPrompt = doc_decompose.buildTypedPrompt, parse = doc_decompose.parseTypedExtraction, numPredict = 400, timeoutMs = 120000, adjudicateTypes = undefined } = {}) {
  // Default the adjudicator to the same model/endpoint, so the live lane gets it without a call-site
  // change. Pass `adjudicateTypes: null` to switch it off.
  if (adjudicateTypes === undefined) adjudicateTypes = makeTypeAdjudicator({ completeFn, model, base, token });
  const _ctx = (() => { try { return require('./config').deepNumCtx(); } catch { return 8192; } })();   // ingest BIG doc chunks, not a 1/16th window
  return async (text, { title } = {}) => {
    if (typeof completeFn !== 'function' || !model) return { entities: [], relations: [] };
    const out = await completeFn({
      model, messages: buildPrompt(text, { title }), base,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      options: { temperature: 0.2, top_p: 0.9, num_ctx: _ctx, num_predict: numPredict },
      think: false, timeoutMs,
    });
    const raw = typeof out === 'string' ? out : ((out && out.text) || (out && out.thinking) || '');
    const parsed = parse(raw);

    // A RELATION ENDPOINT IS AN ENTITY. The model is asked to declare every endpoint as an ENTITY line
    // and routinely does not — raineyfreedom.org came back with 26 relations and ZERO entity lines, so
    // every endpoint was unresolvable and the entire page landed nothing. Recovering them is
    // deterministic; only their TYPE needs judgement, which is what the adjudicator is for.
    const withEndpoints = doc_decompose.backfillEndpointEntities(parsed.entities, parsed.relations);
    const untyped = withEndpoints.filter((e) => e.via === 'endpoint' && (!e.type || e.type === 'other')).map((e) => e.name);
    if (!untyped.length || typeof adjudicateTypes !== 'function') return { ...parsed, entities: withEndpoints };

    const types = await adjudicateTypes(untyped, { title, relations: parsed.relations });
    const entities = withEndpoints.map((e) => (types[e.name] ? { ...e, type: types[e.name] } : e));
    return { ...parsed, entities };
  };
}

/**
 * THE TYPE ADJUDICATOR — a second, cheap cloud call for the endpoints the first pass never typed.
 *
 * Lucas: *"can we add a quick cloud call to help adjudicate these?"* This is that call, and it is
 * deliberately narrow. `backfillEndpointEntities` recovers the entities a REL line names but never
 * declares — that part is deterministic and needs no model, because if a document states a relation
 * about a thing then the document names that thing. What a REL line genuinely cannot say is what KIND
 * of thing each endpoint is, and guessing from the relation would be the "role became the type" bug
 * that produced Fulton County.
 *
 * So this asks one question about a short list of names, with the document's own title and the
 * relations they appeared in as context. It PROPOSES: anything it will not commit to comes back
 * `other`, which the pipeline already treats as untyped and refuses to file rather than guessing.
 *
 * Cost: one small call per document, and only when the first pass left endpoints untyped.
 */
function makeTypeAdjudicator({ completeFn, model, base = undefined, token = null, numPredict = 300, timeoutMs = 60000 } = {}) {
  return async (names = [], { title = null, relations = [] } = {}) => {
    const want = [...new Set((Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean))].slice(0, 25);
    if (!want.length || typeof completeFn !== 'function' || !model) return {};
    // The relations an endpoint appeared in are the strongest context available for typing it —
    // "X WORKS_FOR Y" makes X a person or an org and Y an org, without us asserting which.
    const ctx = (Array.isArray(relations) ? relations : []).slice(0, 25)
      .map((r) => `${r.source} | ${r.relation} | ${r.target}`).join('\n');
    const prompt = [{
      role: 'user',
      content:
`For each NAME below, say what KIND of real-world thing it is.
Output ONLY lines of the form:
NAME :: type

type is one of: ${doc_decompose.ENTITY_TYPES.join(', ')}.
Use "other" if you are not confident — a wrong type is worse than no type.
Do not invent names. Do not output anything except the NAME :: type lines.

${title ? `Document: ${title}\n` : ''}${ctx ? `Statements these names appeared in:\n${ctx}\n` : ''}
NAMES:
${want.join('\n')}`,
    }];
    let raw = '';
    try {
      const out = await completeFn({
        model, messages: prompt, base,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        options: { temperature: 0, top_p: 0.9, num_predict: numPredict },
        think: false, timeoutMs,
      });
      raw = typeof out === 'string' ? out : ((out && out.text) || (out && out.thinking) || '');
    } catch { return {}; }   // the adjudicator is advisory — a failed call leaves everything untyped

    const byName = new Map(want.map((n) => [n.toLowerCase(), n]));
    const types = {};
    for (const line of String(raw).split('\n')) {
      const m = /^\s*(.+?)\s*::\s*([a-z_ -]+)\s*$/i.exec(line.trim());
      if (!m) continue;
      const orig = byName.get(String(m[1]).trim().toLowerCase());
      if (!orig) continue;                                  // never accept a name we did not ask about
      const t = doc_decompose.canonType(m[2]);
      if (t && t !== 'other') types[orig] = t;
    }
    return types;
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

module.exports = { makeCloudExtractor, makeTypeAdjudicator, decomposeLanding };
