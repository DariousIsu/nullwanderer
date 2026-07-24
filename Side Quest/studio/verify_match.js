/*
 * Editor Studio — verification harness STAGE 4: match + score (verify_match).
 *
 * Pipeline (EDITOR_TAB_SPEC, FROZEN): extract → resolve → THIS → preflight → classify → contract.
 * Given a unit and its resolved source text, score how well the source supports the claim — as
 * CHEAPLY as possible, stopping the moment we're confident. This is where ~90% of units settle
 * with ZERO tokens. The model is never touched here; we only DECIDE whether a unit must escalate.
 *
 * Cascade (cheap → expensive, stop when confident):
 *   numeric  regex the stat, compare → equal=Verified, differ=Contradicted (deterministic M)
 *   Tier A   lexical: normalize → exact substring → fuzzy token-window ratio (verbatim quote = V)
 *   Tier B   local embeddings: bge-small cosine over source passages (paraphrase; ~0 cloud tokens)
 *   → band:  verified (≥0.90) · gray (escalate) · weak (escalate) · unsupported · contradicted
 *
 * Layer-0 guards (deterministic, NEVER escalate — the first token-economy wall):
 *   unresolved source · empty/boilerplate passage · degenerate claim ·
 *   zero content-word overlap AND embedding ~0 → Unsupported.
 *
 * The embedder is INJECTED (opts.embed / opts.cosine — lib/memory.embed,cosine in production; a
 * stub in the offline smoke) so Tier B is deterministic + testable with no model load. If no
 * embedder is supplied, Tier B is skipped (Tier A + numeric still run; residue marked needs_model).
 *
 * cite_floor: count INDEPENDENT confirms (canonical-domain dedup) across the unit's resolved
 * sources; met = confirms ≥ required.
 *
 * Output (per spec stage-4 row): { uid, match_score, tier, band, needs_model, rubric, cite_floor }.
 *
 * Runs in Node (offline smoke) and the browser: CommonJS + window fallback.
 */
(function (root, factory) {
  // verify_extract supplies the sentence splitter (passage segmentation) — same module both envs.
  const VE = (typeof require !== 'undefined') ? require('./verify_extract')
    : (typeof window !== 'undefined' ? window.VerifyExtract : null);
  const api = factory(VE);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VerifyMatch = api;
})(this, function (VE) {
  'use strict';

  const NEAR = 0.90;     // ≥ this ⇒ Verified, no model
  const GRAY = 0.62;     // [GRAY, NEAR) ⇒ gray residue (escalate)
  const WEAK = 0.20;     // [WEAK, GRAY) ⇒ weak (escalate unless Layer-0 guard fires)
  const ZERO_OVERLAP = 0.10;   // content-word overlap below this …
  const ZERO_EMBED = 0.25;     // … AND embed sim below this ⇒ Unsupported (Layer-0)
  const MIN_SOURCE = 40;       // shorter source text ⇒ treat as empty
  const NUM_TOL = 0.005;       // 0.5% relative tolerance for numeric equality (rounding)
  // How much of the claim must reappear IN THE SENTENCE that carries the matching number before a
  // numeric hit is allowed to settle the unit without the judge. See numericMatch.
  const NUM_CONTEXT = 0.45;

  const STOPWORDS = new Set(('a an the of to in on at for and or but is are was were be been being as by ' +
    'with from that this these those it its he she they we you i not no than then over under into out up down ' +
    'about after before more most some any all each which who whom whose has have had do does did will would can ' +
    'could should may might must also such per via').split(/\s+/));

  const BOILERPLATE = /(enable javascript|cookies? (?:to continue|are disabled)|page not found|404 error|access denied|are you a robot|verify you are human)/i;

  // --- normalization -----------------------------------------------------------------------------
  function normalize(s) {
    // Drop punctuation (incl. '.') to spaces so "site." matches "site"; keep % and $ for stats.
    return String(s == null ? '' : s).toLowerCase().replace(/[^\p{L}\p{N}\s%$]/gu, ' ').replace(/\s+/g, ' ').trim();
  }
  function words(s) { return normalize(s).split(' ').filter(Boolean); }
  function contentWords(s) { return words(s).filter(w => w.length > 1 && !STOPWORDS.has(w)); }

  // Fraction of the claim's content words present in the source (honest relatedness signal; drives
  // the Layer-0 zero-overlap guard — immune to spurious common-word window matches).
  function contentOverlap(needle, haystack) {
    const a = contentWords(needle);
    if (!a.length) return 0;
    const b = new Set(contentWords(haystack));
    return a.filter(w => b.has(w)).length / a.length;
  }

  // Tier A lexical score: exact normalized substring = 1.0; else best token-Dice over a sliding
  // window the width of the needle (catches near-verbatim with minor omissions/insertions).
  function lexicalScore(needle, haystack) {
    const a = words(needle), b = words(haystack);
    if (!a.length || !b.length) return 0;
    if ((' ' + b.join(' ') + ' ').includes(' ' + a.join(' ') + ' ')) return 1;
    const w = a.length, setA = new Set(a);
    let best = 0;
    for (let i = 0; i + 1 <= b.length; i++) {
      const win = b.slice(i, i + w);
      const inter = win.reduce((n, t) => n + (setA.has(t) ? 1 : 0), 0);
      const dice = (2 * inter) / (w + win.length);
      if (dice > best) best = dice;
      if (best >= 1) break;
    }
    return best;
  }

  // --- numeric ----------------------------------------------------------------------------------
  const SCALE = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, bn: 1e9, billion: 1e9, trillion: 1e12 };
  // Parse comparable statistics out of text → [{unit:'%'|'$'|'n', val, raw}].
  function parseStats(text) {
    const out = [];
    const t = String(text || '');
    let m;
    const pct = /(\d[\d,]*(?:\.\d+)?)\s?(?:%|percent|percentage points?)/gi;
    while ((m = pct.exec(t))) out.push({ unit: '%', val: parseFloat(m[1].replace(/,/g, '')), raw: m[0] });
    const cur = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?(billion|million|trillion|thousand|bn|m|k)?/gi;
    while ((m = cur.exec(t))) out.push({ unit: '$', val: parseFloat(m[1].replace(/,/g, '')) * (SCALE[(m[2] || '').toLowerCase()] || 1), raw: m[0] });
    const mag = /(?<!\$)(?<!\$\s)\b(\d[\d,]*(?:\.\d+)?)\s?(billion|million|trillion|thousand)\b/gi;  // not a $-magnitude (already captured by currency)
    while ((m = mag.exec(t))) out.push({ unit: 'n', val: parseFloat(m[1].replace(/,/g, '')) * (SCALE[m[2].toLowerCase()] || 1), raw: m[0] });
    return out;
  }
  const valEq = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * NUM_TOL);

  /**
   * Deterministic numeric verdict. → null (inconclusive, fall through) | {verdict, matched, passage}.
   *
   * ⚠️ CO-LOCATION IS THE WHOLE POINT (fixed 2026-07-23). This used to parse stats from the ENTIRE
   * source and verify if any comparable magnitude matched anywhere on the page — so a number was
   * treated as evidence purely for existing somewhere near the claim's subject. Proven on the live
   * Arizona ESA op-ed: the claim "Cap ESAs at families making under $150,000 a year" scored 1.0
   * `verified` against a real-estate page reading "a three-bedroom home in Mesa listed at $150,000".
   * That was the only "Verified" in the author's report, it never reached the judge (needs_model
   * false ends the cascade), and the rendered evidence was "match: verified (score 1)" — a verdict
   * with nothing behind it that an author could check.
   *
   * A number is evidence only in the sentence that USES it. So: find the sentence carrying a
   * comparable value, and require that sentence to restate enough of the claim (NUM_CONTEXT) before
   * this fast path may settle the unit. Below the bar we return null and the unit falls through to
   * lexical → embeddings → the judge, which is the correct home for anything ambiguous. The winning
   * sentence is returned so the finding can quote it.
   */
  function numericMatch(claimText, sourceText, opts = {}) {
    // Measure the CLAIM, not its citation apparatus. A trailing url and a "[3]" marker are not
    // things the source has to restate, but they count as claim words — which both deflates the
    // context ratio (a url contributes 4-5 tokens no source will ever match) and, worse, can
    // manufacture a statistic outright: a percent-encoded path like ".../AZ%20State%20Plan.pdf"
    // parses as "20 %".
    const claimCore = String(claimText == null ? '' : claimText)
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/\[\d{1,3}(?:\s*[-,]\s*\d{1,3})*\]/g, ' ');
    const claim = parseStats(claimCore);
    if (!claim.length) return null;
    const floor = opts.numContext != null ? opts.numContext : NUM_CONTEXT;
    const sents = splitPassages(sourceText, 2000);
    const scan = sents.length ? sents : [String(sourceText || '')];

    let agree = null, disagree = null, anyAgree = false;
    for (const s of scan) {
      const stats = parseStats(s);
      if (!stats.length) continue;
      const ctx = contentOverlap(claimCore, s);
      for (const c of claim) {
        const comparable = stats.filter(x => x.unit === c.unit);
        if (!comparable.length) continue;
        if (comparable.some(x => valEq(x.val, c.val))) {
          anyAgree = true;
          if (ctx >= floor && (!agree || ctx > agree.context)) agree = { context: ctx, matched: c.raw, passage: s };
        } else if (claim.length === 1 && ctx >= floor && (!disagree || ctx > disagree.context)) {
          disagree = { context: ctx, matched: comparable.map(x => x.raw).join(', '), passage: s };
        }
      }
    }
    if (agree) return { verdict: 'verified', matched: agree.matched, passage: agree.passage, context: agree.context };
    // Only call it a contradiction when NOTHING in the source agrees — otherwise a document that
    // states the figure in one sentence and a different figure in another would be reported as
    // contradicting itself on the strength of whichever sentence we happened to score higher.
    if (disagree && !anyAgree) return { verdict: 'contradicted', matched: disagree.matched, passage: disagree.passage, context: disagree.context };
    return null;
  }

  // --- passages / embeddings --------------------------------------------------------------------
  function splitPassages(text, max = 60) {
    const sents = (VE && VE.splitSentences) ? VE.splitSentences(text) : String(text || '').split(/(?<=[.?!])\s+/);
    return sents.map(s => s.trim()).filter(s => s.length > 8).slice(0, max);
  }
  function cosineOf(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  }

  function bandFromScore(score) {
    if (score >= NEAR) return 'verified';
    if (score >= GRAY) return 'gray';
    if (score >= WEAK) return 'weak';
    return 'unsupported';
  }

  // --- score one unit against ONE source (pure, deterministic, no model) ------------------------
  async function scoreAgainstSource(unit, source, opts) {
    const cos = opts.cosine || cosineOf;
    const needle = (unit && (unit.quote || unit.text) || '');
    const srcText = (source && source.source_text) || '';

    // Layer-0 guards (never escalate).
    // UNCITED is not INACCESSIBLE. "We could not reach your source" and "you gave no source" are
    // different facts and the author acts on them differently; collapsing them made the report
    // apologise for a fetch that never had a target.
    if (source && source.resolved === false && source.tier === 'uncited') {
      return { score: 0, tier: 'guard', band: 'uncited', needs_model: false, rubric: { method: 'guard', reason: 'uncited' } };
    }
    if (!source || source.resolved === false) return { score: 0, tier: 'guard', band: 'inaccessible', needs_model: false, rubric: { method: 'guard', reason: 'unresolved' } };
    if (srcText.trim().length < MIN_SOURCE) return { score: 0, tier: 'guard', band: 'unsupported', needs_model: false, rubric: { method: 'guard', reason: 'empty-source' } };
    if (BOILERPLATE.test(srcText)) return { score: 0, tier: 'guard', band: 'unsupported', needs_model: false, rubric: { method: 'guard', reason: 'boilerplate' } };
    if (contentWords(needle).length < 2) return { score: 0, tier: 'guard', band: 'unsupported', needs_model: false, rubric: { method: 'guard', reason: 'degenerate-claim' } };

    // numeric deterministic win (or contradiction).
    if (unit.kind === 'numeric' || (unit.numbers && unit.numbers.length)) {
      const nm = numericMatch(unit.text, srcText, opts);
      // The winning sentence rides along as best_passage so the finding can QUOTE the evidence.
      // A deterministic verdict with no quotable passage behind it is unauditable by the author.
      if (nm && nm.verdict === 'verified') return { score: 1, tier: 'numeric', band: 'verified', needs_model: false, rubric: { method: 'numeric', matched: nm.matched, best_passage: nm.passage, context: nm.context } };
      if (nm && nm.verdict === 'contradicted') return { score: 0, tier: 'numeric', band: 'contradicted', needs_model: false, rubric: { method: 'numeric', source_values: nm.matched, best_passage: nm.passage, context: nm.context } };
      // inconclusive → fall through to lexical/embeddings
    }

    // Tier A lexical.
    const lex = lexicalScore(needle, srcText);
    let score = lex, tier = 'A', bestPassage = null, embScore = 0;

    // Tier B embeddings (only if an embedder is supplied and Tier A didn't already verify).
    if (opts.embed && lex < NEAR) {
      const passages = splitPassages(srcText);
      if (passages.length) {
        const qv = await opts.embed(needle);
        for (const p of passages) {
          const s = cos(qv, await opts.embed(p));
          if (s > embScore) { embScore = s; bestPassage = p; }
        }
        if (embScore > score) { score = embScore; tier = 'B'; }
      }
    }

    const overlap = contentOverlap(needle, srcText);
    // Layer-0 zero-overlap guard: spurious lexical window + no real overlap + no embed signal.
    if (overlap < ZERO_OVERLAP && embScore < ZERO_EMBED) {
      return { score, tier: 'guard', band: 'unsupported', needs_model: false, rubric: { method: 'guard', reason: 'zero-overlap', lex, embScore, overlap } };
    }

    const band = bandFromScore(score);
    const needs_model = band === 'gray' || band === 'weak';
    return { score, tier, band, needs_model, rubric: { method: tier === 'B' ? 'embedding' : 'lexical', lex, embScore, overlap, best_passage: bestPassage } };
  }

  function canonicalDomain(url) {
    const m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
    if (!m) return '';
    return m[1].toLowerCase().replace(/^www\./, '').replace(/\.(web\.archive\.org)$/, '');
  }

  /**
   * Match a unit against its resolved source(s).
   * @param {object} unit       a verify_extract unit
   * @param {object|object[]} resolved  one verify_resolve result, or an array (multi-source)
   * @param {object} [opts]     { embed, cosine, citeFloor=1, near, gray, weak }
   * @returns {Promise<{uid,match_score,tier,band,needs_model,rubric,cite_floor}>}
   */
  async function matchUnit(unit, resolved, opts = {}) {
    const sources = Array.isArray(resolved) ? resolved : [resolved];
    const required = opts.citeFloor != null ? opts.citeFloor : 1;

    let best = null, bestSourceUrl = null, bestTrail = null;
    const confirmDomains = new Set();
    for (const src of sources) {
      const r = await scoreAgainstSource(unit, src, opts);
      if (r.band === 'verified' && src && src.source_url) confirmDomains.add(canonicalDomain(src.source_url));
      if (!best || r.score > best.score || (best.band === 'inaccessible' && r.band !== 'inaccessible')) {
        best = r; bestSourceUrl = src && src.source_url || null;
        // Carry the resolution trail so a downstream "inaccessible" can say which readers were tried.
        bestTrail = (src && Array.isArray(src.trail)) ? src.trail : null;
      }
    }

    const confirms = confirmDomains.size;
    const cite_floor = { required, confirms, met: confirms >= required };

    // cite_floor not met (e.g. need 2 independent confirms, only 1 domain) downgrades a clean
    // Verified to gray for the operator's attention — a deterministic sourcing-discipline gate.
    let band = best.band, needs_model = best.needs_model;
    if (band === 'verified' && !cite_floor.met && required > 1) { band = 'gray'; needs_model = true; best.rubric.cite_floor_short = true; }

    return {
      uid: unit && unit.uid,
      match_score: Math.round(best.score * 1000) / 1000,
      tier: best.tier,
      band,
      needs_model,
      rubric: Object.assign({ source_url: bestSourceUrl }, best.rubric),
      trail: bestTrail,
      cite_floor,
    };
  }

  // Batch (sequential = deterministic order). resolvedFor(unit, i) supplies each unit's source(s).
  async function matchUnits(units, resolvedFor, opts = {}) {
    const list = Array.isArray(units) ? units : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const res = typeof resolvedFor === 'function' ? resolvedFor(list[i], i) : (Array.isArray(resolvedFor) ? resolvedFor[i] : resolvedFor);
      out.push(await matchUnit(list[i], res, opts));
    }
    return out;
  }

  return {
    matchUnit, matchUnits, scoreAgainstSource,
    lexicalScore, contentOverlap, numericMatch, parseStats, splitPassages, bandFromScore,
    canonicalDomain, cosineOf, normalize, words, contentWords,
    NEAR, GRAY, WEAK, ZERO_OVERLAP, ZERO_EMBED, MIN_SOURCE, NUM_CONTEXT,
  };
});
