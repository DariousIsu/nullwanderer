/*
 * Editor Studio — verification harness STAGE 7: FACT CHECK (verify_factcheck).
 *
 * The SECOND lane, and a different question from everything before it.
 *
 *   CITATION VERIFICATION (stages 2-6) asks: is what the document says correctly sourced to the
 *   source the document CITES? It reads that source and nothing else. If the cited source cannot be
 *   reached the answer is "inaccessible" — never a substitute found by search, because a page the
 *   author never cited cannot settle whether the author cited correctly.
 *
 *   FACT CHECK (this stage) asks: what does the REST OF THE RECORD say? It deliberately goes looking
 *   for INDEPENDENT sources and reports what it finds — corroborating sources that strengthen the
 *   claim, countering sources the author should weigh before publishing.
 *
 * The distinction is not cosmetic. This lane's output is ADVISORY: it is offered for consideration
 * and never rules on the author's sourcing. A countering source is a thing to think about, not a
 * defect — so nothing here may place a document on hold. Conflating the two is what produced a
 * certificate that failed an author for pages the verifier itself went and found.
 *
 * Output contract (one item per claim):
 *   { uid, claim, stance, note, supporting: [Source], countering: [Source], consulted: [Source],
 *     searched: bool }
 *   Source = { url, title, stance, quote }
 *   stance ∈ { corroborated, contested, mixed, no-independent-source }
 *
 * Deterministic control flow; the model is caged at one leaf (classify ONE fetched source against
 * ONE claim). Every outside call is injected, so this runs identically offline and live.
 *
 * Runs in Node (offline smoke) and the browser: CommonJS + window fallback.
 */
(function (root, factory) {
  const req = (typeof require !== 'undefined') ? require : null;
  const deep = req ? req('./verify_deepcheck') : root.VerifyDeepcheck;
  const match = req ? req('./verify_match') : root.VerifyMatch;
  const api = factory(deep, match);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VerifyFactcheck = api;
})(this, function (DEEP, VM) {
  'use strict';

  const MIN_BODY = 40;            // below this a fetched "source" is too thin to weigh
  const MAX_PASSAGE = 4000;       // cap per source handed to the model
  const DEFAULT_SOURCES = 3;      // independent sources to gather per claim
  const DEFAULT_TOPN = 6;         // search hits to walk while gathering

  const STANCES = Object.freeze(['corroborated', 'contested', 'mixed', 'no-independent-source']);

  function hostOf(url) {
    const m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
    return m ? m[1].replace(/^www\./i, '').toLowerCase() : '';
  }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }

  // Reuse the citation lane's passage locator when available (embedding-ranked windowing of a big
  // document); fall back to a head clip so this module works standalone.
  function locate(body, claim, opts) {
    if (DEEP && typeof DEEP.locatePassage === 'function') {
      return DEEP.locatePassage(body, claim, Object.assign({ maxPassage: MAX_PASSAGE }, opts));
    }
    return clip(body, MAX_PASSAGE);
  }
  function dedupe(list) {
    if (DEEP && typeof DEEP.dedupeSources === 'function') return DEEP.dedupeSources(list);
    const seen = new Set(), out = [];
    for (const s of (list || [])) {
      if (!s || !s.url) continue;
      const k = String(s.url).replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
      if (seen.has(k)) continue; seen.add(k);
      out.push(s);
    }
    return out;
  }

  /**
   * Gather up to `want` INDEPENDENT sources for a claim. Independent means: not the host the document
   * cited — corroboration from the same site is not corroboration. Uses the claim SENTENCE as the
   * query, never a bare quoted name (searching "Camaro Dragon" alone returns a Chevrolet).
   */
  async function gatherSources(unit, opts = {}) {
    if (typeof opts.search !== 'function' || typeof opts.fetch !== 'function') return [];
    const want = opts.sources || DEFAULT_SOURCES;
    const q = clip(unit.claim || unit.text || '', 300);
    if (!q) return [];
    let results = [];
    try { results = await opts.search(q, { kind: unit.kind }); } catch { return []; }
    const list = Array.isArray(results) ? results : (results && (results.results || results.items || results.hits)) || [];
    const citedHost = hostOf(unit.sourceUrl || unit.url);
    const out = [];
    for (const r of (Array.isArray(list) ? list : []).slice(0, opts.searchTopN || DEFAULT_TOPN)) {
      if (out.length >= want) break;
      const u = r && (r.url || r.link || r.source_url);
      if (!u) continue;
      if (citedHost && hostOf(u) === citedHost) continue;          // must be INDEPENDENT
      if (out.some(s => hostOf(s.url) === hostOf(u))) continue;    // one voice per outlet
      try {
        const body = String(await opts.fetch(u) || '').trim();
        if (body.length < MIN_BODY) continue;
        out.push({ url: u, title: r.title || r.name || u, passage: locate(body, unit.claim || unit.text || '', opts) });
      } catch { /* try the next hit */ }
    }
    return out;
  }

  // The model's ONLY job here: read one independent source and say how it bears on the claim. It is
  // explicitly told this is NOT a judgement of the author's citation — that already happened in the
  // citation lane, against a different source, and re-litigating it here would double-punish.
  const FACTCHECK_SYS = [
    'You are a fact-checker assembling context for a pre-publication review.',
    'You are given a CLAIM from a draft and a PASSAGE from an INDEPENDENT source (not the source the',
    'draft cited). Decide how that passage bears on the claim. You are NOT judging whether the draft',
    'cited correctly — only what this independent source says.',
    'Respond with ONLY a JSON object (no prose, no code fence):',
    '{"stance":"<STANCE>","quote":"<the exact line from the passage that decides it, or empty>","note":"<one short sentence>"}',
    'STANCE is one of:',
    '  supports  — the passage affirms the claim (fully or substantially)',
    '  counters  — the passage contradicts the claim, or materially undercuts it',
    '  unrelated — the passage does not address the claim either way',
  ].join('\n');

  function parseStance(text) {
    const raw = String(text == null ? '' : text);
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const braces = (fence ? fence[1] : raw).match(/\{[\s\S]*\}/);
    let obj = null;
    if (braces) { try { obj = JSON.parse(braces[0]); } catch { obj = null; } }
    let stance = obj && typeof obj.stance === 'string' ? obj.stance.trim().toLowerCase() : '';
    if (!/^(supports|counters|unrelated)$/.test(stance)) {
      // tolerant fallback — a bare word anywhere, else treat as unrelated (the SAFE default: an
      // unparseable answer must never become a "counter" the author is asked to answer for).
      const m = raw.match(/\b(supports?|counters?|contradicts?|unrelated)\b/i);
      const w = m ? m[1].toLowerCase() : '';
      stance = /^supports?$/.test(w) ? 'supports' : (/^(counters?|contradicts?)$/.test(w) ? 'counters' : 'unrelated');
    }
    return {
      stance,
      quote: obj && typeof obj.quote === 'string' ? obj.quote.trim() : '',
      note: obj && typeof obj.note === 'string' ? obj.note.trim() : '',
      valid: !!obj,
    };
  }

  // Deterministic stub when no model is injected — keeps the lane runnable offline end-to-end.
  function stubStance(unit, src) {
    const overlap = (VM && typeof VM.contentOverlap === 'function') ? VM.contentOverlap(unit.claim || unit.text || '', src.passage || '') : 0;
    return { stance: overlap >= 0.5 ? 'supports' : 'unrelated', quote: '', note: 'fact-check stub', valid: true, stub: true };
  }

  async function classifySource(unit, src, opts) {
    if (typeof opts.complete !== 'function') return stubStance(unit, src);
    let text = '';
    try {
      text = await opts.complete({
        model: opts.model, base: opts.base, headers: opts.headers,
        options: { num_predict: opts.numPredict || 2000, num_ctx: opts.numCtx || 32768 },
        messages: [
          { role: 'system', content: FACTCHECK_SYS },
          { role: 'user', content: `CLAIM: ${unit.claim || unit.text || ''}\n\nINDEPENDENT SOURCE PASSAGE:\n${clip(src.passage, MAX_PASSAGE)}` },
        ],
      });
    } catch { text = ''; }
    return parseStance(text);
  }

  // Overall stance from the per-source verdicts. "Mixed" is a real and useful answer — the author
  // should know the record is split rather than be handed only whichever side we saw first.
  function aggregate(sources) {
    const sup = sources.filter(s => s.stance === 'supports').length;
    const con = sources.filter(s => s.stance === 'counters').length;
    if (!sources.length) return 'no-independent-source';
    if (sup && con) return 'mixed';
    if (con) return 'contested';
    if (sup) return 'corroborated';
    return 'no-independent-source';                    // everything we found was unrelated
  }

  /**
   * Fact-check ONE claim against independent sources.
   * unit: { uid, claim|text, kind?, url?/sourceUrl? }  (sourceUrl = what the document cited, excluded)
   * opts: { search, fetch, complete, model, base, headers, embed, cosine, sources, searchTopN }
   */
  async function factCheckOne(unit, opts = {}) {
    const u = unit || {};
    const found = await gatherSources(u, opts);
    const searched = typeof opts.search === 'function' && typeof opts.fetch === 'function';
    const rated = [];
    for (const src of found) {
      const v = await classifySource(u, src, opts);
      rated.push({ url: src.url, title: src.title, stance: v.stance, quote: v.quote || '', note: v.note || '' });
    }
    const supporting = rated.filter(s => s.stance === 'supports');
    const countering = rated.filter(s => s.stance === 'counters');
    const stance = aggregate(rated);
    return {
      uid: u.uid, claim: u.claim || u.text || '', stance,
      supporting, countering, consulted: dedupe(rated),
      searched,
      note: stance === 'no-independent-source'
        ? (searched ? 'no independent source addressed this claim' : 'fact-check search unavailable')
        : `${supporting.length} supporting · ${countering.length} countering`,
    };
  }

  /** Fact-check many claims with bounded concurrency. Input order is preserved. */
  async function factCheckAll(items, opts = {}) {
    const list = Array.isArray(items) ? items : [];
    const conc = Math.max(1, opts.concurrency | 0 || 3);
    const out = new Array(list.length);
    let next = 0;
    async function worker() {
      while (true) {
        const i = next++;
        if (i >= list.length) return;
        try { out[i] = await factCheckOne(list[i], opts); }
        catch (e) {
          const u = list[i] || {};
          out[i] = { uid: u.uid, claim: u.claim || u.text || '', stance: 'no-independent-source', supporting: [], countering: [], consulted: [], searched: false, note: 'fact-check failed: ' + (e && e.message) };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(conc, list.length) }, worker));
    return out;
  }

  return { factCheckOne, factCheckAll, gatherSources, classifySource, parseStance, aggregate, FACTCHECK_SYS, STANCES, MIN_BODY, MAX_PASSAGE };
});
