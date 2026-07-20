/*
 * Editor Studio — DEEP AGENTIC VERIFICATION (verify_deepcheck).
 *
 * The frontier-quality upgrade to the harness's single caged classify leaf. Where classify makes ONE
 * model call over a pre-matched snippet, this READS the primary source deeply, CROSS-CHECKS an
 * independent second source, and JUDGES with a precision-aware rubric — the workflow a frontier agent
 * uses by hand (see docs/DEEP_VERIFY_DESIGN.md; benchmark Process_Log_ELI_Oped_Walker_v1.md). It is the
 * deliberate, operator-invoked deep pass, driven by the STRONGEST cloud reasoning model (frontier-first).
 *
 *   deepVerifyOne(unit, opts) -> { uid, status_code, caveat, note, evidence_quote, confidence,
 *                                  sources_consulted:[{url,title}], tier:'deep'|'deep-stub' }
 *
 * Same discipline as the rest of the harness: EVERY I/O dep is injected, so it runs identically offline
 * (mocks) and live (real adapters lib/editor_checks builds). Output uses the frozen status enum
 * (V/VC/VP/QO/QP/A/M/NK) so it flows straight through studio/checks_contract. Node + browser (UMD).
 */
(function (root, factory) {
  const VC = (typeof require !== 'undefined') ? require('./verify_classify')
    : (typeof window !== 'undefined' ? window.VerifyClassify : null);
  const VM = (typeof require !== 'undefined') ? require('./verify_match')
    : (typeof window !== 'undefined' ? window.VerifyMatch : null);
  const api = factory(VC, VM);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VerifyDeepCheck = api;
})(this, function (VC, VM) {
  'use strict';

  const MIN_BODY = 40;            // below this a "source" is too thin to judge on
  const MAX_PASSAGE = 6000;       // cap the passage handed to the model; large sources are located first
  const DEFAULT_TOPN = 3;         // search hits to try when cross-checking
  // Kinds that get an INDEPENDENT cross-check by default (headline stats/numbers benefit most; bound cost).
  const CROSSCHECK_KINDS = new Set(['numeric']);

  function hostOf(url) { const m = String(url || '').match(/^https?:\/\/([^/?#]+)/i); return m ? m[1].replace(/^www\./i, '').toLowerCase() : ''; }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }

  // Dedupe a sources-consulted list by normalized URL.
  function dedupeSources(list) {
    const seen = new Set(), out = [];
    for (const s of (Array.isArray(list) ? list : [])) {
      if (!s || !s.url) continue;
      const k = String(s.url).replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
      if (seen.has(k)) continue; seen.add(k);
      out.push({ url: s.url, title: s.title || s.url });
    }
    return out;
  }

  // Locate the most claim-relevant window of a large source so the model reads the RIGHT passage, not
  // the first 6k chars. Paragraph-chunk, score by embedding cosine (if injected) else lexical overlap.
  function locatePassage(text, claim, opts = {}) {
    const body = String(text || '');
    if (body.length <= (opts.maxPassage || MAX_PASSAGE)) return body;
    const chunks = body.split(/\n{2,}/).filter(c => c.trim().length > 0);
    if (chunks.length <= 1) return clip(body, opts.maxPassage || MAX_PASSAGE);
    const score = (chunk) => {
      if (typeof opts.embed === 'function' && typeof opts.cosine === 'function') {
        try { return opts.cosine(opts.embed(claim), opts.embed(chunk)); } catch { /* fall through */ }
      }
      return VM ? VM.contentOverlap(claim, chunk) : 0;
    };
    const ranked = chunks.map((c, i) => ({ c, i, s: score(c) })).sort((a, b) => b.s - a.s);
    // stitch the top chunks (in original order) up to the cap → keeps context around the best match
    const keep = new Set(); let size = 0;
    for (const r of ranked) { if (size + r.c.length > (opts.maxPassage || MAX_PASSAGE)) continue; keep.add(r.i); size += r.c.length; if (size >= (opts.maxPassage || MAX_PASSAGE) * 0.8) break; }
    if (!keep.size) keep.add(ranked[0].i);
    return chunks.filter((_, i) => keep.has(i)).join('\n\n');
  }

  // READ the primary source deeply: prefer the already-resolved source text; if it's thin and we have a
  // URL + a fetch tool, pull the full document; locate the relevant passage if the source is large.
  async function readPrimary(unit, opts) {
    let passage = String(unit.sourceText != null ? unit.sourceText : (unit.passage || '')).trim();
    const url = unit.sourceUrl || unit.url || null;
    if (passage.length < MIN_BODY && url && typeof opts.fetch === 'function') {
      try { const body = String(await opts.fetch(url) || '').trim(); if (body.length >= MIN_BODY) passage = body; } catch { /* keep what we had */ }
    }
    passage = locatePassage(passage, unit.claim || unit.text || '', opts);
    return { passage, sourceUrl: url };
  }

  // Should this claim get an independent cross-check? Numeric/headline by default; opts can force on/off.
  function shouldCrossCheck(unit, opts) {
    if (opts.crossCheck === false) return false;
    if (opts.crossCheck === true) return true;
    return CROSSCHECK_KINDS.has(unit.kind);
  }

  // CROSS-CHECK: one independent web search for a SECOND source (skipping the cited domain), fetch the
  // top non-blocked hit. Two confirmations beat one. Needs opts.search + opts.fetch; null if none found.
  async function crossCheck(unit, opts) {
    if (typeof opts.search !== 'function' || typeof opts.fetch !== 'function') return null;
    const q = clip(unit.quote || unit.claim || unit.text || '', 200);
    let results = [];
    try { results = await opts.search(q, { kind: unit.kind }); } catch { return null; }
    const list = Array.isArray(results) ? results : (results && (results.results || results.items || results.hits) || []);
    const citedHost = hostOf(unit.sourceUrl || unit.url);
    for (const r of (Array.isArray(list) ? list : []).slice(0, opts.searchTopN || DEFAULT_TOPN)) {
      const u = r && (r.url || r.link || r.source_url); if (!u) continue;
      if (citedHost && hostOf(u) === citedHost) continue;   // want an INDEPENDENT source
      try {
        const body = String(await opts.fetch(u) || '').trim();
        if (body.length >= MIN_BODY) return { url: u, title: r.title || r.name || u, passage: locatePassage(body, unit.claim || unit.text || '', opts) };
      } catch { /* try next hit */ }
    }
    return null;
  }

  // The precision-aware verification rubric — the depth a single match call can't produce.
  const RUBRIC_SYS = [
    'You are a rigorous citation and fact verifier for a pre-publication review. You are given a CLAIM from a',
    'document and one or more SOURCE PASSAGES fetched from the cited source and (sometimes) an independent source.',
    'Decide how well the sources support the claim, checking PRECISION, not just gist:',
    '- numbers/statistics: is the figure EXACT? is the timeframe/qualifier ("in the 1990s", "since 2020") accurate?',
    '- quotations: is a quoted sentence VERBATIM, or a paraphrase presented inside quotation marks?',
    '- attribution: is the claim attributed to the right person/body?',
    '- if an independent source is provided, does it corroborate or contradict the cited one?',
    'Respond with ONLY a JSON object (no prose, no code fence):',
    '{"status_code":"<CODE>","caveat":"<short precision caveat, or empty>","evidence_quote":"<the exact line from a source that decides it>","confidence":<0..1>}',
    'CODE ∈ V (source clearly supports), VC (verified but with a caveat), VP (verified but paraphrased),',
    'QO (quote present, minor omission), QP (quotation is actually a paraphrase), A (attribution issue),',
    'M (mismatch / source contradicts the claim), NK (not supported / not found in the sources).',
  ].join('\n');

  function buildJudgePrompt(unit, primary, independent) {
    const parts = [`CLAIM: ${unit.claim || unit.text || ''}`];
    if (unit.quote) parts.push(`QUOTED AS: ${unit.quote}`);
    parts.push(`\nCITED SOURCE PASSAGE:\n${primary && primary.trim() ? clip(primary, MAX_PASSAGE) : '(no source text could be retrieved)'}`);
    if (independent && independent.trim()) parts.push(`\nINDEPENDENT SOURCE PASSAGE:\n${clip(independent, MAX_PASSAGE)}`);
    return parts.join('\n');
  }

  // Parse the model's verdict — JSON first (optionally fenced), then key=val / synonym fallback.
  function parseVerdict(text) {
    const raw = String(text == null ? '' : text);
    let obj = null;
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence ? fence[1] : raw;
    const braces = body.match(/\{[\s\S]*\}/);
    if (braces) { try { obj = JSON.parse(braces[0]); } catch { obj = null; } }
    let code = null, caveat = '', evidence = '', conf = null;
    if (obj && typeof obj === 'object') {
      code = VC ? VC.parseStatusCode(obj.status_code != null ? obj.status_code : obj.code) : (obj.status_code || null);
      caveat = typeof obj.caveat === 'string' ? obj.caveat.trim() : '';
      evidence = typeof obj.evidence_quote === 'string' ? obj.evidence_quote.trim() : (typeof obj.evidence === 'string' ? obj.evidence.trim() : '');
      conf = typeof obj.confidence === 'number' ? obj.confidence : null;
    }
    if (!code) {                                   // fallbacks: STATUS=, bare token, synonym scan
      const m = raw.match(/STATUS\s*=\s*([A-Za-z]+)/i);
      code = m && VC ? VC.parseStatusCode(m[1]) : null;
      if (!code) { const tok = raw.match(/\b(VC|VP|QO|QP|NK|V|A|M)\b/); code = tok ? tok[1] : null; }
      if (!code && VC) code = VC.parseStatusCode(raw);
      const cm = raw.match(/CAVEAT\s*=\s*(.+)$/im); if (cm) caveat = cm[1].trim();
    }
    return {
      status_code: code || 'NK',
      caveat: caveat || '',
      evidence_quote: evidence || '',
      confidence: conf != null ? conf : (code ? 0.75 : 0.2),
      valid: !!code,
    };
  }

  // Deterministic stub when NO model is injected (offline end-to-end, like verify_classify's stub).
  function stubJudge(unit, primary) {
    const overlap = VM ? VM.contentOverlap(unit.claim || unit.text || '', primary || '') : 0;
    const code = overlap >= 0.7 ? 'V' : (overlap >= 0.4 ? 'VP' : 'NK');
    return { status_code: code, caveat: '', evidence_quote: '', confidence: 0.3, note: `deep-stub: overlap=${Math.round(overlap * 100) / 100}`, valid: true, stub: true };
  }

  async function judge(unit, primary, independent, opts) {
    if (typeof opts.complete !== 'function') return stubJudge(unit, primary);
    let text = '';
    try {
      // num_predict/num_ctx belong INSIDE options — the transport reads options.*, so a top-level
      // num_predict was silently dropped and the judge inherited the 8192 default context. Two
      // MAX_PASSAGE passages plus the rubric plus a reasoning model's hidden chain-of-thought
      // overruns that, and an overrun judge returns truncated JSON that parses as NK.
      text = await opts.complete({
        model: opts.model, base: opts.base, headers: opts.headers,
        // 4000, not 1200: a frontier reasoner spends most of its budget on hidden reasoning before
        // it emits the verdict object, and a cap that clips mid-JSON degrades silently to NK.
        options: { num_predict: opts.numPredict || 4000, num_ctx: opts.numCtx || 32768 },
        messages: [{ role: 'system', content: RUBRIC_SYS }, { role: 'user', content: buildJudgePrompt(unit, primary, independent) }],
      });
    } catch { text = ''; }
    const v = parseVerdict(text);
    v.note = v.caveat || v.evidence_quote || (v.valid ? '' : 'model output unparseable');
    return v;
  }

  /**
   * Deep-verify ONE claim. unit: { uid, claim|text, quote?, url?/sourceUrl?, sourceText?/passage?, kind?, sourceTitle? }.
   * opts (all injected): { complete, model, base, headers, numPredict, fetch(url)->text, search(q,{kind})->results,
   *                        embed, cosine, crossCheck?:bool, searchTopN, maxPassage }.
   */
  async function deepVerifyOne(unit, opts = {}) {
    const u = unit || {};
    const consulted = [];
    const prim = await readPrimary(u, opts);
    if (prim.sourceUrl && prim.passage && prim.passage.length >= MIN_BODY) consulted.push({ url: prim.sourceUrl, title: u.sourceTitle || prim.sourceUrl });

    let indep = null;
    if (shouldCrossCheck(u, opts)) { indep = await crossCheck(u, opts); if (indep) consulted.push({ url: indep.url, title: indep.title }); }

    const v = await judge(u, prim.passage, indep && indep.passage, opts);
    return {
      uid: u.uid,
      status_code: v.status_code, caveat: v.caveat || '', note: v.note || '', evidence_quote: v.evidence_quote || '',
      confidence: v.confidence, sources_consulted: dedupeSources(consulted),
      tier: v.stub ? 'deep-stub' : 'deep', valid: v.valid !== false,
    };
  }

  /**
   * Deep-verify many claims with a bounded concurrency (default 3 — a frontier reasoning model per claim).
   * Preserves input order in the returned array.
   */
  async function deepVerifyAll(items, opts = {}) {
    const list = Array.isArray(items) ? items : [];
    const conc = Math.max(1, opts.concurrency | 0 || 3);
    const out = new Array(list.length);
    let next = 0;
    async function worker() { for (let i = next++; i < list.length; i = next++) out[i] = await deepVerifyOne(list[i], opts); }
    await Promise.all(Array.from({ length: Math.min(conc, list.length || 1) }, worker));
    return out;
  }

  return { deepVerifyOne, deepVerifyAll, parseVerdict, locatePassage, dedupeSources, shouldCrossCheck, RUBRIC_SYS, MIN_BODY, MAX_PASSAGE };
});
