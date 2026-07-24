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

  // Cut a body into rankable units. A LADDER, because "paragraph" is a property of the READER, not of
  // the source, and retrieval must not depend on one.
  //
  // ⚠️ THE SILENT-HEAD DEFECT (live, 2026-07-23, third run). This used to be a bare
  // `body.split(/\n{2,}/)`, and locatePassage returned `clip(body, cap)` whenever that yielded one
  // chunk. lib/search_lane's browser reader finishes with `.replace(/\s+/g, ' ')` — `\s` matches
  // newlines — so EVERY page it returns has zero line breaks and always hit that branch. The judge
  // was then handed the first N characters of the document while the call still looked like it had
  // "located a passage". A cited 23,859-char case study that plainly says ESA money bought
  // "diamonds, lingerie, big screen TVs, iPhones, and Kenmore appliances" — 57.6% of the way in, far
  // past any 6,000-char head — was judged against its introduction, and the studio ruled NOT
  // SUPPORTED against a citation that was exactly right.
  //
  // A reader's whitespace habits must never be able to manufacture a verdict, so the fallbacks below
  // are ordered from most to least structure and the last one always succeeds. Retrieval runs on
  // every body larger than the cap — there is no path that silently returns the head.
  const CHUNK_TARGET = 700;                 // chars per synthesized window when the text has no line structure
  function packWindows(body, target = CHUNK_TARGET) {
    // Sentence-aware first so a window rarely splits mid-fact; hard-cut only if there are no sentences.
    const parts = body.split(/(?<=[.!?]["'”’)\]]?)\s+/).filter(s => s.trim().length > 0);
    const out = [];
    let cur = '';
    for (const s of parts) {
      if (cur && cur.length + 1 + s.length > target) { out.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) out.push(cur);
    if (out.length > 1) return out;
    const hard = [];
    for (let i = 0; i < body.length; i += target) hard.push(body.slice(i, i + target));
    return hard.filter(c => c.trim().length > 0);
  }
  function chunkBody(body) {
    let chunks = body.split(/\n{2,}/).filter(c => c.trim().length > 0);      // blank-line paragraphs
    if (chunks.length > 1) return chunks;
    chunks = body.split(/\n+/).filter(c => c.trim().length > 0);             // one break per block
    if (chunks.length > 1) return chunks;
    return packWindows(body);                                               // no line structure at all
  }

  // Locate the most claim-relevant window of a large source so the model reads the RIGHT passage, not
  // the first 6k chars. Chunk (see chunkBody), score by embedding cosine (if injected) else lexical overlap.
  // ⚠️ ASYNC, and it must be awaited (fixed 2026-07-23, found in a live run). `opts.embed` is an
  // async embedder; this used to call `opts.cosine(opts.embed(claim), opts.embed(chunk))` with no
  // await, so cosine received two PROMISES and scored every chunk 0. Every chunk tying means the
  // "ranking" collapses to document order and the judge is handed THE FIRST N CHARACTERS of the
  // source instead of the relevant ones. Live consequence: a cited 202,673-char state literacy PDF
  // does contain "a 29-point gap between…", the exact figure under review, and the judge was shown
  // the front matter and correctly reported that what it could see did not support the claim — a
  // wrong verdict against a good citation, produced by a missing `await`.
  async function locatePassage(text, claim, opts = {}) {
    const body = String(text || '');
    if (body.length <= (opts.maxPassage || MAX_PASSAGE)) return body;
    const chunks = chunkBody(body);
    if (chunks.length <= 1) return clip(body, opts.maxPassage || MAX_PASSAGE);
    const lexical = (chunk) => (VM ? VM.contentOverlap(claim, chunk) : 0);
    // Score every chunk lexically first — free, synchronous — then EMBED ONLY THE TOP FEW. A real
    // cited source runs to thousands of paragraphs (the state literacy PDF is 202,673 chars), and one
    // await per chunk turns a 6-claim audit into minutes of embedding. The lexical pass is a recall
    // filter, not the verdict: factual claims share their distinctive tokens (figures, proper nouns)
    // with the passage that supports them, so the right window is virtually always in the top slice —
    // and embeddings then decide the ORDER within it, which is what actually picks the window.
    // TRADEOFF, asserted rather than hidden: a passage that supports the claim with NO shared
    // content word can fall outside the candidate set and never be embedded.
    const topK = opts.embedTopK != null ? opts.embedTopK : 40;
    let scored = chunks.map((c, i) => ({ c, i, s: lexical(c) }));
    if (typeof opts.embed === 'function' && typeof opts.cosine === 'function') {
      const candidates = scored.slice().sort((a, b) => b.s - a.s).slice(0, topK);
      try {
        const qv = await opts.embed(claim);
        for (const cand of candidates) {
          try { const s = opts.cosine(qv, await opts.embed(cand.c)); if (Number.isFinite(s)) cand.s = 1 + s; }
          catch { /* keep the lexical score */ }
        }
        // +1 above keeps any embedded candidate ranked above every un-embedded chunk, so the
        // embedding decides the winner while the lexical tail still provides a deterministic order.
      } catch { /* embedder unavailable → pure lexical ranking */ }
    }
    const ranked = scored.sort((a, b) => b.s - a.s);
    // Stitch the top chunks (in original order) → context around the best match.
    //
    // ⚠️ BOUNDED BY CHUNK COUNT, NOT JUST BYTES (fixed 2026-07-23, second live run). The old loop
    // filled to 80% of the byte cap and stopped, which is fine at the 6,000-char default but became
    // actively harmful once the cap was sized from the model's real context (100,000): a 202,673-char
    // literacy PDF has 1,636 paragraphs averaging ~124 chars, so "as many as fit" kept ~800 of them
    // and handed the judge 80,000 chars of mostly-irrelevant document. The chunk carrying the figure
    // under review ranked #0 and was still in there — and the judge missed it and reported the
    // citation unsupported. **A bigger window is not better when retrieval fills it with noise;**
    // locating a passage means keeping the RELEVANT chunks, not the maximum number of them.
    const maxChunks = opts.maxChunks != null ? opts.maxChunks : 40;
    const cap = opts.maxPassage || MAX_PASSAGE;
    const keep = new Set(); let size = 0;
    for (const r of ranked) {
      if (keep.size >= maxChunks) break;
      // +2 for the '\n\n' this chunk will be joined with — otherwise the returned string overruns
      // the cap the caller sized against the model's window.
      const cost = r.c.length + (keep.size ? 2 : 0);
      if (size + cost > cap) continue;
      keep.add(r.i); size += cost;
    }
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
    passage = await locatePassage(passage, unit.claim || unit.text || '', opts);
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
    // Same envelope trap as the fact-check lane: callTool returns {content:[{text:'…json…'}]}, which
    // has no `results` key, so a hand-rolled parse silently sees zero hits and the cross-check
    // quietly never happens. verify_resolve.readSearchResults already unwraps every shape.
    let list = [];
    try { list = require('./verify_resolve').readSearchResults(results); } catch { /* browser build */ }
    if (!list.length) {
      const raw = Array.isArray(results) ? results : (results && (results.results || results.items || results.hits) || []);
      list = Array.isArray(raw) ? raw : [];
    }
    const citedHost = hostOf(unit.sourceUrl || unit.url);
    for (const r of list.slice(0, opts.searchTopN || DEFAULT_TOPN)) {
      const u = r && (r.url || r.link || r.source_url); if (!u) continue;
      if (citedHost && hostOf(u) === citedHost) continue;   // want an INDEPENDENT source
      try {
        const body = String(await opts.fetch(u) || '').trim();
        if (body.length >= MIN_BODY) return { url: u, title: r.title || r.name || u, passage: await locatePassage(body, unit.claim || unit.text || '', opts) };
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
    'M (mismatch / source contradicts the claim), NS (the cited source does not support the claim —',
    'it is silent on it, or discusses something adjacent but different).',
    'Do NOT emit NK: that code means "no record in an internal knowledge base", which is not a judgement',
    'you are being asked to make. If the cited source simply does not support the claim, that is NS.',
  ].join('\n');

  // `cap` is a parameter, not the module constant. It used to clip to MAX_PASSAGE unconditionally,
  // which meant opts.maxPassage governed how much text locatePassage SELECTED and then this threw
  // the surplus away again — a truncation no caller could turn off, sized for a window we no longer
  // run in. The caller now sizes it from the model's actual context (lib/cloud_window).
  function buildJudgePrompt(unit, primary, independent, cap = MAX_PASSAGE) {
    const parts = [`CLAIM: ${unit.claim || unit.text || ''}`];
    if (unit.quote) parts.push(`QUOTED AS: ${unit.quote}`);
    parts.push(`\nCITED SOURCE PASSAGE:\n${primary && primary.trim() ? clip(primary, cap) : '(no source text could be retrieved)'}`);
    if (independent && independent.trim()) parts.push(`\nINDEPENDENT SOURCE PASSAGE:\n${clip(independent, cap)}`);
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
    // A model that emitted NK is answering the OLD rubric (or reaching for a familiar code); in this
    // lane the only thing it can mean is "the cited source doesn't support it" → NS.
    if (code === 'NK') code = 'NS';
    return {
      // No parseable code ⇒ ERR, never a verdict. This used to default to NK, which the contract
      // graded `info`, so a truncated or unparseable judge reply was indistinguishable from a clean
      // result and quietly helped clear the document. ERR grades as warn and says what happened.
      status_code: code || 'ERR',
      caveat: caveat || '',
      evidence_quote: evidence || '',
      confidence: conf != null ? conf : (code ? 0.75 : 0.2),
      valid: !!code,
    };
  }

  // Deterministic stub when NO model is injected (offline end-to-end, like verify_classify's stub).
  function stubJudge(unit, primary) {
    const overlap = VM ? VM.contentOverlap(unit.claim || unit.text || '', primary || '') : 0;
    const code = overlap >= 0.7 ? 'V' : (overlap >= 0.4 ? 'VP' : 'NS');
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
        messages: [{ role: 'system', content: RUBRIC_SYS },
          { role: 'user', content: buildJudgePrompt(unit, primary, independent, opts.maxPassage || MAX_PASSAGE) }],
      });
    } catch { text = ''; }
    const v = parseVerdict(text);
    v.note = v.caveat || v.evidence_quote
      || (v.valid ? '' : `no usable verdict from the judge — ${text ? 'reply did not parse (often a truncated verdict: check num_predict/num_ctx)' : 'the model returned nothing'}`);
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
