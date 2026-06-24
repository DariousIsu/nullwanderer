/*
 * Editor Studio — verification harness STAGE 2: extract units (verify_extract).
 *
 * Pipeline (EDITOR_TAB_SPEC, FROZEN): file → [intake] → working copy → THIS → resolve → match
 * → preflight → classify → contract. This is the deterministic mouth of the engine: it rides
 * the importer's light block model (editor_import.parseBlocks → {anchor,hash,type,text,...}) and
 * turns prose into a flat, standardized list of VERIFICATION UNITS — the atoms every later stage
 * operates on. ZERO model cognition here: pure lexical detection, fixed regexes, one output shape.
 *
 * A unit is one sentence (or table row / list item) that carries something CHECKABLE — a quote, a
 * source reference (url/doi/citation-marker), or a statistic. Sentences with no verifiable signal
 * are dropped (nothing to resolve a source against) unless includeBareClaims is set. This is the
 * first token-economy gate: we never escalate prose that has nothing to verify.
 *
 * Output contract (per spec stage-2 row): [{ uid, anchor, blockType, kind, text, quote?, url?,
 * doi?, marker?, numbers? }]. `kind` ∈ {quote, citation, numeric, claim} (precedence in that
 * order). `quote/url/doi/marker` are the PRIMARY (first) detection; `numbers` lists every stat.
 *
 * Runs in Node (offline smoke) and the browser (harness): CommonJS + window fallback, like
 * studio/checks_contract.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VerifyExtract = api;
})(this, function () {
  'use strict';

  // Frozen unit-kind enum (precedence order: a quote outranks a bare citation, etc.).
  const KINDS = Object.freeze(['quote', 'citation', 'numeric', 'claim']);

  // Block types we mine for units. Code is skipped verbatim (never a claim); tables are mined
  // row-by-row (see splitCandidates). Everything text-bearing is fair game.
  const TEXT_BLOCKS = new Set(['heading', 'paragraph', 'list_item', 'table']);

  // ---- lexical detectors (all deterministic, all 0-token) --------------------------------

  // Sentence splitter: regex split guarded against decimals, two-letter initialisms (U.S.),
  // and common abbreviations (Dr., vs., etc.). Protected dots are stashed as U+222F then restored.
  const ABBREV = 'Mr|Mrs|Ms|Dr|Prof|Sen|Rep|Gov|Pres|St|Ave|vs|etc|al|Inc|Ltd|Co|Corp|No|Fig|pp|Vol|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
  function splitSentences(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return [];
    const prot = t
      .replace(/\b([A-Za-z])\.(?=[A-Za-z]\.)/g, '$1∯')                 // U.S.A., e.g.
      .replace(/\b([A-Za-z])\.(?=[A-Za-z]\b)/g, '$1∯')                 // trailing single initial
      .replace(new RegExp('\\b(' + ABBREV + ')\\.', 'gi'), '$1∯')      // known abbreviations
      .replace(/(\d)\.(\d)/g, '$1∯$2')                                 // decimals
      .replace(/\.{3,}/g, m => '∯'.repeat(m.length));                  // ellipses
    const parts = prot.split(/(?<=[.?!])["'”’)\]]?\s+(?=[A-Z0-9"'“‘(\[])/);
    return parts.map(s => s.replace(/∯/g, '.').trim()).filter(Boolean);
  }

  // Verbatim quoted spans — straight or curly double quotes, min length to skip scare-quotes.
  function detectQuotes(text, minLen) {
    const out = [];
    const re = /[“]([^”]{MIN,}?)[”]|"([^"]{MIN,}?)"/g.source.replace(/MIN/g, String(Math.max(1, minLen | 0)));
    const rx = new RegExp(re, 'g');
    let m;
    while ((m = rx.exec(text))) { const q = (m[1] || m[2] || '').trim(); if (q) out.push(q); }
    // Leading markdown blockquote ("> …") — the importer keeps the marker inline.
    const bq = String(text || '').match(/^>\s?(.+)$/);
    if (bq && bq[1].trim()) out.push(bq[1].trim());
    return out;
  }

  // Bare http(s) URLs (markdown-link targets included — the regex finds the url inside `](…)`).
  function detectUrls(text) {
    const out = [];
    const rx = /\bhttps?:\/\/[^\s<>()\[\]"'“”]+/gi;
    let m;
    while ((m = rx.exec(text))) out.push(m[0].replace(/[.,;:]+$/, '')); // strip trailing sentence punctuation
    return out;
  }

  // DOIs (registrant/suffix form). Independent of url detection (a doi may appear bare).
  function detectDois(text) {
    const out = [];
    const rx = /\b10\.\d{4,9}\/[^\s"'<>)\]“”]+/gi;
    let m;
    while ((m = rx.exec(text))) out.push(m[0].replace(/[.,;:]+$/, ''));
    return out;
  }

  // Citation markers: numeric refs [1] / [1,2] / [3-5], and author-year in brackets or parens.
  function detectMarkers(text) {
    const out = [];
    const patterns = [
      /\[\d+(?:\s?[-,]\s?\d+)*\]/g,
      /\[[A-Z][\w.'’-]+(?:\s+(?:et al\.?|&|and)\s+[A-Z][\w.'’-]+)*,?\s*\d{4}[a-z]?\]/g,
      /\([A-Z][\w.'’-]+(?:\s+(?:et al\.?|&|and)\s+[A-Z][\w.'’-]+)*,?\s*\d{4}[a-z]?\)/g,
    ];
    for (const rx of patterns) { let m; while ((m = rx.exec(text))) out.push(m[0]); }
    return out;
  }

  // Statistics worth verifying: percentages, currency, and scale-word magnitudes. Bare integers
  // and years are intentionally NOT captured — too noisy to be useful verification targets.
  function detectNumbers(text) {
    const out = [];
    const patterns = [
      /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:billion|million|trillion|thousand|bn|m|k)?\b/gi,   // currency
      /\b\d[\d,]*(?:\.\d+)?\s?(?:percentage points?|percent|bps|%)/gi,                 // percentages (no trailing \b — "%" is non-word)
      /\b\d[\d,]*(?:\.\d+)?\s?(?:billion|million|trillion|thousand)\b/gi,              // magnitudes
    ];
    for (const rx of patterns) { let m; while ((m = rx.exec(text))) out.push(m[0].trim()); }
    return out;
  }

  // First element or undefined — keeps optional fields absent (not null) when nothing detected.
  const first = (a) => (a && a.length ? a[0] : undefined);

  // Resolve a unit's kind from its detected signals (fixed precedence). null ⇒ not a unit.
  function kindOf(sig, includeBareClaims) {
    if (sig.quote) return 'quote';
    if (sig.url || sig.doi || sig.marker) return 'citation';
    if (sig.numbers && sig.numbers.length) return 'numeric';
    return includeBareClaims ? 'claim' : null;
  }

  // Turn one block into candidate text fragments. Tables split row-wise (separator rows dropped);
  // everything else sentence-splits its text. Each candidate is one potential unit's `text`.
  function splitCandidates(block) {
    if (block.type === 'table') {
      return String(block.text || '')
        .split('\n')
        .map(r => r.trim())
        .filter(r => r && !/^\|?\s*:?-{2,}/.test(r.replace(/\|/g, ' ').trim().split(/\s+/)[0] || '') && !/^[|\s:-]+$/.test(r))
        .map(r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean).join(' — '))
        .filter(Boolean);
    }
    return splitSentences(block.text);
  }

  /**
   * Extract verification units from a working copy (editor_import shape: { blocks: [...] }).
   * Pure + deterministic — same input always yields the same units in the same order.
   *
   * @param {object} workingCopy  { blocks: [{anchor,type,text,...}], ... }
   * @param {object} [opts]
   *   minQuoteLen       {number}  min chars inside a "quote" to count (default 4)
   *   includeHeadings   {boolean} mine heading blocks too (default true)
   *   includeBareClaims {boolean} emit kind:'claim' for signal-less declarative sentences (default false)
   * @returns {{ units: Array, summary: object }}
   */
  function extractUnits(workingCopy, opts = {}) {
    const minQuoteLen = opts.minQuoteLen != null ? opts.minQuoteLen : 4;
    const includeHeadings = opts.includeHeadings !== false;
    const includeBareClaims = !!opts.includeBareClaims;

    const blocks = (workingCopy && workingCopy.blocks) || [];
    const units = [];
    let candidateCount = 0;

    for (const block of blocks) {
      if (!TEXT_BLOCKS.has(block.type)) continue;
      if (block.type === 'heading' && !includeHeadings) continue;

      const candidates = splitCandidates(block);
      candidates.forEach((text, si) => {
        candidateCount++;
        const quotes = detectQuotes(text, minQuoteLen);
        const urls = detectUrls(text);
        const dois = detectDois(text);
        const markers = detectMarkers(text);
        const numbers = detectNumbers(text);
        const sig = { quote: first(quotes), url: first(urls), doi: first(dois), marker: first(markers), numbers };
        const kind = kindOf(sig, includeBareClaims);
        if (!kind) return;

        const unit = { uid: `${block.anchor}.s${si}`, anchor: block.anchor, blockType: block.type, kind, text };
        if (sig.quote) unit.quote = sig.quote;
        if (sig.url) unit.url = sig.url;
        if (sig.doi) unit.doi = sig.doi;
        if (sig.marker) unit.marker = sig.marker;
        if (numbers.length) unit.numbers = numbers;
        units.push(unit);
      });
    }

    const byKind = {};
    for (const k of KINDS) byKind[k] = 0;
    for (const u of units) byKind[u.kind]++;

    return {
      units,
      summary: { blockCount: blocks.length, candidateCount, unitCount: units.length, byKind },
    };
  }

  return {
    extractUnits, kindOf, splitCandidates,
    splitSentences, detectQuotes, detectUrls, detectDois, detectMarkers, detectNumbers,
    KINDS, TEXT_BLOCKS,
  };
});
