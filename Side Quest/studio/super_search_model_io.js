/*
 * Super Search — the THREE caged model leaves (slice 4). The determinism law's teeth: the model
 * appears here and NOWHERE else in the pipeline, and at each leaf its free-form reply is forced
 * back into a bounded shape it cannot escape. All three are pure over an INJECTED
 * `complete({model,messages,...}) -> text` (Ollama local / cloud in production, a mock in the
 * smoke) — no HTTP, no DB, offline-testable.
 *
 *   makePlanner  (local) → shapes the QUERY, never the results. Free-form reply parsed to a
 *     schema-bounded plan: intent + entities + expanded terms + which recipes to fire. Targets are
 *     filtered to the KNOWN recipe ids; anything invented is dropped; a garbage reply → safe
 *     all-lanes-on default. The model can narrow/expand the query but cannot invent a data source.
 *   makeReranker (local) → reorders ONE lane's candidate set. Parses an index permutation; keeps
 *     only valid in-range indices, dedupes, and appends any card the model omitted — so the output
 *     is ALWAYS a permutation of the input (no card added, none lost). Sets each card's `rank`.
 *   makeOverview (cloud) → one cited answer from the top passages. Parses the [n] markers the answer
 *     actually used → citations. cite_floor: zero citations (or zero input) ⇒ rendered:false, the
 *     overview does not show. "Cites >=1 or it doesn't render."
 *
 * Runs in Node (offline smoke) and the browser: CommonJS + window fallback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SuperSearchModelIO = api;
})(this, function () {
  'use strict';

  // The model may only SELECT from these — never invent a source. (db_query is operator-only, not
  // model-selectable: we don't let a local model compose SQL.)
  const PLANNABLE_INTERNAL = ['knowledge', 'entities', 'contacts', 'bills', 'polls'];
  const PLANNABLE_EXTERNAL = ['web', 'academic'];
  const INTENTS = ['lookup', 'research', 'compare'];

  function splitList(s) {
    return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  }
  // Filter a model-named target list to the allowed set. '*' / empty / all-invalid → [] (= default
  // every lane on; never kill retrieval because the model picked something we don't recognize).
  function filterTargets(raw, allowed) {
    if (/\*/.test(raw || '')) return [];
    const picked = splitList(raw).map(x => x.toLowerCase()).filter(x => allowed.includes(x));
    return picked;
  }

  // ---- PLAN (local) ----------------------------------------------------------------------------
  const PLAN_SYS = [
    'You are a search planner. Turn the user QUERY into a retrieval plan. Do not answer the query.',
    'Respond with EXACTLY one line and nothing else:',
    'INTENT=<lookup|research|compare> | ENTITIES=<comma list or -> | TERMS=<comma list of expansion terms or -> | INTERNAL=<comma list of: knowledge,entities,contacts,bills,polls or *> | EXTERNAL=<comma list of: web,academic or *>',
    'Use * when all sources of that kind are appropriate. Pick narrower lists only when the query clearly targets one kind.',
  ].join('\n');

  function makePlanner({ complete, model, base, headers } = {}) {
    return async (query) => {
      let text = '';
      try { text = await complete({ model, base, headers, messages: [{ role: 'system', content: PLAN_SYS }, { role: 'user', content: `QUERY: ${query}` }] }); }
      catch (e) { text = ''; }
      const s = String(text || '');
      // strip the template's literal <…> brackets the model often echoes back; values never contain them.
      const grab = (k) => { const m = s.match(new RegExp(k + '\\s*=\\s*([^|\\n]*)', 'i')); return m ? m[1].replace(/[<>]/g, '').trim() : ''; };
      const intentRaw = grab('INTENT').toLowerCase();
      const intent = INTENTS.includes(intentRaw) ? intentRaw : 'lookup';
      const entities = splitList(grab('ENTITIES')).filter(x => x !== '-');
      const expanded_terms = splitList(grab('TERMS')).filter(x => x !== '-');
      const internal_targets = filterTargets(grab('INTERNAL'), PLANNABLE_INTERNAL);
      const external_targets = filterTargets(grab('EXTERNAL'), PLANNABLE_EXTERNAL);
      return { query, intent, entities, expanded_terms, internal_targets, external_targets, raw: s.slice(0, 240) };
    };
  }

  // ---- RERANK (local) --------------------------------------------------------------------------
  const RERANK_CAP = 20;   // only ask the model to order the head of the lane
  const RERANK_SYS = [
    'You re-rank search results by relevance to the QUERY. You may ONLY reorder the given items.',
    'Respond with EXACTLY one line: ORDER=<comma-separated item numbers, most relevant first>.',
    'Include every number exactly once. Do not invent numbers, do not add commentary.',
  ].join('\n');

  function makeReranker({ complete, model, base, headers } = {}) {
    return async (query, cards) => {
      const list = Array.isArray(cards) ? cards : [];
      if (list.length <= 1) return list.map((c, i) => ({ ...c, rank: i + 1 }));
      const head = list.slice(0, RERANK_CAP);
      const tail = list.slice(RERANK_CAP);
      const lines = head.map((c, i) => `[${i + 1}] ${c.title} — ${String(c.snippet || '').slice(0, 120)}`).join('\n');
      let text = '';
      try { text = await complete({ model, base, headers, messages: [{ role: 'system', content: RERANK_SYS }, { role: 'user', content: `QUERY: ${query}\n${lines}` }] }); }
      catch (e) { text = ''; }
      const m = String(text || '').match(/ORDER\s*=\s*([0-9,\s]+)/i);
      const order = m ? m[1].split(',').map(x => parseInt(x.trim(), 10)).filter(Number.isFinite) : [];
      // Build a permutation: valid unique indices first, then any head card the model omitted.
      const seen = new Set();
      const reordered = [];
      for (const n of order) { const idx = n - 1; if (idx >= 0 && idx < head.length && !seen.has(idx)) { seen.add(idx); reordered.push(head[idx]); } }
      for (let i = 0; i < head.length; i++) if (!seen.has(i)) reordered.push(head[i]);
      const final = reordered.concat(tail);
      return final.map((c, i) => ({ ...c, rank: i + 1 }));
    };
  }

  // ---- OVERVIEW (cloud) ------------------------------------------------------------------------
  const OVERVIEW_CAP = 8;
  const OVERVIEW_SYS = [
    'You write a brief, neutral answer to the QUERY using ONLY the numbered SOURCES.',
    'Cite every claim with its source number in square brackets, e.g. [1] or [2][3].',
    'If the sources do not support an answer, reply exactly: INSUFFICIENT.',
    'Two or three sentences maximum. Do not add information that is not in the sources.',
  ].join('\n');

  function makeOverview({ complete, model, base, headers } = {}) {
    return async (query, cards) => {
      const list = (Array.isArray(cards) ? cards : []).slice(0, OVERVIEW_CAP);
      if (!list.length) return { answer: '', citations: [], rendered: false };  // nothing to cite
      const sources = list.map((c, i) => `[${i + 1}] (${c.cite || c.title}) ${String(c.enrich && c.enrich.body ? c.enrich.body : c.snippet || '').slice(0, 600)}`).join('\n');
      let text = '';
      try { text = await complete({ model, base, headers, messages: [{ role: 'system', content: OVERVIEW_SYS }, { role: 'user', content: `QUERY: ${query}\nSOURCES:\n${sources}` }] }); }
      catch (e) { text = ''; }
      const answer = String(text || '').trim();
      if (!answer || /^INSUFFICIENT\b/i.test(answer)) return { answer: '', citations: [], rendered: false };
      // cite_floor: collect the [n] markers the answer actually used; map back to cards.
      const used = new Set();
      let mm; const re = /\[(\d+)\]/g;
      while ((mm = re.exec(answer)) !== null) { const idx = parseInt(mm[1], 10) - 1; if (idx >= 0 && idx < list.length) used.add(idx); }
      if (used.size === 0) return { answer: '', citations: [], rendered: false };  // uncited ⇒ does not render
      const citations = [...used].sort((a, b) => a - b).map((idx) => ({ n: idx + 1, id: list[idx].id, cite: list[idx].cite, url: list[idx].url || null, source: list[idx].source }));
      return { answer, citations, rendered: true };
    };
  }

  return {
    PLANNABLE_INTERNAL, PLANNABLE_EXTERNAL, INTENTS,
    makePlanner, makeReranker, makeOverview,
    PLAN_SYS, RERANK_SYS, OVERVIEW_SYS, filterTargets,
  };
});
