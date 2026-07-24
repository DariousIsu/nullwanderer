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
 * doi?, marker?, domain?, numbers? }]. `kind` ∈ {quote, citation, numeric, claim} (precedence in
 * that order). `quote/url/doi/marker/domain` are the PRIMARY (first) detection; `numbers` lists
 * every stat. `domain` is a BARE cited host ("ago.mo.gov") from a designed document that prints its
 * sources without a scheme — a citation signal only, never promoted to a fetchable url (see below).
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
    // ⚠️ A CITATION MARKER MUST NOT WELD TWO SENTENCES TOGETHER (fixed 2026-07-23).
    // The terminator class allows ONE optional closing character, so "…nation.[1] Only 26 percent…"
    // never split: `[1]` is three characters. Every sentence carrying a marker therefore SWALLOWED
    // the sentence after it, and the verifier was handed a two-sentence unit whose second half the
    // citation was never meant to cover. Live cost on the Arizona ESA op-ed: "Nobody serious defends
    // ESA dollars going to diamond rings.[4]" — which its source supports outright — was fused with
    // "But fraud prevention and eligibility restriction are two different problems…", pure argument,
    // and the whole unit came back NOT SUPPORTED. The marker stays with the sentence it cites: it is
    // matched inside the LOOKBEHIND (variable-length lookbehind is supported), so only the following
    // whitespace is consumed as the separator.
    const MARKER_RUN = String.raw`(?:\[\d{1,3}(?:\s*[-,]\s*\d{1,3})*\])*`;
    const splitter = new RegExp(`(?<=[.?!]${MARKER_RUN})["'”’)\\]]?\\s+(?=[A-Z0-9"'“‘(\\[])`);
    const parts = prot.split(splitter);
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

  // Bare cited domains. A DESIGNED document prints its sources as "…June 15, 2026. ago.mo.gov"
  // rather than as a full http url, so detectUrls sees nothing and the sentence is not even a unit —
  // a whole class of citation goes unverified. The TLD allowlist is what keeps this off filenames
  // ("report.pdf"), abbreviations ("e.g.") and version strings; emails and anything already inside a
  // url are excluded by the lookbehind.
  const CITE_TLDS = new Set([
    'gov', 'org', 'com', 'net', 'edu', 'mil', 'int', 'info', 'news', 'press', 'law',
    'us', 'uk', 'ca', 'eu', 'io', 'co',
  ]);
  function detectDomains(text) {
    const out = [];
    const rx = /(?<![\w@:/.-])((?:[a-z0-9][a-z0-9-]*\.)+([a-z]{2,}))(?![\w-])/gi;
    let m;
    while ((m = rx.exec(text))) {
      const host = m[1].toLowerCase().replace(/\.$/, '');
      if (!CITE_TLDS.has(m[2].toLowerCase())) continue;
      if (host.split('.').length < 2) continue;
      out.push(host);
    }
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
  // Spelled-out ratios ("three out of every four students", "one in five households"). A statistic
  // does not stop being a statistic for being written in words, but every pattern above keys on a
  // DIGIT — so the Arizona op-ed's "failing three out of every four students in reading", which is
  // the piece's own restatement of its headline figure, was not a verification unit at all. Bounded
  // to the small-number words a ratio is actually written with, so ordinary prose ("one of the
  // reasons") cannot trip it: the `out of` / `in` frame is required.
  const RATIO_WORD = 'one|two|three|four|five|six|seven|eight|nine|ten';
  const RATIO_RE = new RegExp(
    String.raw`\b(?:${RATIO_WORD}|\d{1,3})\s+(?:out\s+of|in)\s+(?:every\s+)?(?:${RATIO_WORD}|\d{1,3})\b`, 'gi');

  function detectNumbers(text) {
    const out = [];
    const patterns = [
      /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:billion|million|trillion|thousand|bn|m|k)?\b/gi,   // currency
      /\b\d[\d,]*(?:\.\d+)?\s?(?:percentage points?|percent|bps|%)/gi,                 // percentages (no trailing \b — "%" is non-word)
      /\b\d[\d,]*(?:\.\d+)?\s?(?:billion|million|trillion|thousand)\b/gi,              // magnitudes
      RATIO_RE,                                                                        // "three out of every four"
    ];
    for (const rx of patterns) { let m; rx.lastIndex = 0; while ((m = rx.exec(text))) out.push(m[0].trim()); }
    return out;
  }

  // First element or undefined — keeps optional fields absent (not null) when nothing detected.
  const first = (a) => (a && a.length ? a[0] : undefined);

  // Is a quoted span a QUOTATION worth verifying verbatim, or just a name in quotes? Writers quote
  // proper nouns constantly ("Camaro Dragon", "Brickstorm") and those are not assertions — but they
  // were becoming kind:'quote' units, so the harness went looking for a source that "supports" a
  // malware name. On cert CFC-2026-07-20-01 that produced three of seven findings, all meaningless.
  // A real checkable quotation has sentence-like substance: several words, or a decent span.
  // NOTE this gates UNIT KIND only — detectQuotes still reports every quoted span, because other
  // stages (and the operator's citation list) legitimately want them all.
  function isVerifiableQuote(q, { minWords = 4, minChars = 30 } = {}) {
    const t = String(q || '').trim();
    if (!t) return false;
    return t.split(/\s+/).length >= minWords || t.length >= minChars;
  }

  // ---- reference/endnote section -----------------------------------------------------------
  // A document's own endnote list is NOT a set of claims — it is the SOURCE TABLE for the claims
  // above it. Mining it produces junk units (a source title in quotation marks reads as a "quote"
  // to verify verbatim) and, worse, leaves body claims carrying a bare "[7]" with no url at all —
  // so the resolver blind-searches the web for a source the document already named. Detecting the
  // section once fixes both: skip it as claim material, and use it to dereference markers.

  const NOTES_HEADING_RE = /^\s*(notes?|endnotes?|footnotes?|references?|sources?|citations?|works\s+cited|bibliography)\s*:?\s*$/i;
  // Leading ordinal on an endnote line: "1." / "1)" / "[1]" / "**1 **" / "1 " (docx converters emit
  // the bolded variant, so the emphasis marks are part of the pattern, not noise to strip first).
  const LEADING_ORDINAL_RE = /^\s*(?:\*\*\s*)?\[?(\d{1,3})\]?[\s.):\]]*(?:\*\*)?\s*/;
  const REF_BLOCKS = new Set(['list_item', 'paragraph']);

  /**
   * Locate the trailing reference/endnote section of a working copy.
   *
   * Two signals, in order: an explicit "Notes"/"References"/… heading, else the longest TRAILING
   * run of list-item/paragraph blocks that mostly carry urls. Requires >= 2 entries so a single
   * closing link never swallows the conclusion paragraph.
   *
   * @returns {{ startIndex:number, entries:Object }|null}  entries maps ordinal -> {anchor,url,text}
   */
  function findReferenceSection(blocks, opts = {}) {
    const list = Array.isArray(blocks) ? blocks : [];
    if (list.length < 2) return null;
    const minEntries = opts.minRefEntries != null ? opts.minRefEntries : 2;
    const hasUrl = (b) => detectUrls(String((b && b.text) || '')).length > 0;

    // How many non-reference blocks may follow the list (an author bio / dateline commonly trails it).
    const maxTail = opts.maxRefTail != null ? opts.maxRefTail : 3;

    let startIndex = -1, endIndex = list.length - 1;
    // Signal 1 — an explicit heading. Everything after the LAST such heading is the section.
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (b && b.type === 'heading' && NOTES_HEADING_RE.test(String(b.text || ''))) { startIndex = i + 1; break; }
    }
    // Signal 2 — no heading (docx converters routinely drop it). Take the LONGEST consecutive run of
    // ref-shaped blocks that EACH carry a url. Requiring the url per block is what keeps the run from
    // swallowing body prose: an endnote list is uniformly linked, an argument is not.
    if (startIndex < 0) {
      let best = null, runStart = -1;
      for (let i = 0; i <= list.length; i++) {
        const ok = i < list.length && list[i] && REF_BLOCKS.has(list[i].type) && hasUrl(list[i]);
        if (ok) { if (runStart < 0) runStart = i; continue; }
        if (runStart >= 0) {
          const len = i - runStart;
          if (!best || len > best.len) best = { start: runStart, end: i - 1, len };
          runStart = -1;
        }
      }
      // References TRAIL the argument — a linked run buried mid-document is evidence, not a source list.
      if (!best || best.len < minEntries || best.end < list.length - 1 - maxTail) return null;
      startIndex = best.start;
      endIndex = best.end;

      // Requiring a url PER BLOCK finds the run, but a reference list may OPEN with an unlinked
      // entry (a poll provided directly, an interview, a book). Dropping it shifts every positional
      // ordinal by one and silently cites each claim one source off — observed live: the SNAP op-ed's
      // note 1 is an unlinked Rainey Center poll, so a polling claim resolved to a USDA fraud page.
      // Extend backwards only over blocks that are unmistakably part of the SAME list: a contiguous
      // list_item run, or a paragraph that prints its own leading ordinal.
      const runIsList = list[startIndex] && list[startIndex].type === 'list_item';
      while (startIndex > 0) {
        const prev = list[startIndex - 1];
        if (!prev || !REF_BLOCKS.has(prev.type)) break;
        const sameList = runIsList && prev.type === 'list_item';
        const numbered = LEADING_ORDINAL_RE.test(String(prev.text || ''));
        if (!sameList && !numbered) break;
        startIndex--;
      }
    }
    if (startIndex < 0 || startIndex >= list.length) return null;

    const section = list.slice(startIndex, endIndex + 1);
    if (section.length < minEntries) return null;

    // Ordinals: prefer the number the document itself prints, else fall back to position. A list
    // that numbers nothing is still dereferenceable — endnote lists are written in citation order.
    const entries = {};
    section.forEach((b, i) => {
      const text = String((b && b.text) || '');
      const m = text.match(LEADING_ORDINAL_RE);
      const ordinal = m ? parseInt(m[1], 10) : i + 1;
      if (!(ordinal > 0) || entries[ordinal]) return;      // never let a later entry clobber an earlier one
      // EVERY url in the note, not just the first. A single endnote routinely cites several sources
      // ("…NCES, <url>; Rezal, Axios, <url>"), and keeping only the first silently discards the rest.
      // Observed live on the Arizona ESA op-ed: note 1's first url is NAEP's interactive state-trends
      // page (whose text layer carries no state figures), while the Axios piece it also cites states
      // the claimed 26%/25% outright — the supporting source was thrown away before anything read it,
      // and the judge then reported the author's own citation as unsupported. `url` stays the first
      // for every existing caller; `urls` carries the full list for the resolver to work through.
      const urls = detectUrls(text);
      entries[ordinal] = { anchor: b.anchor, url: urls[0] || null, urls, text: m ? text.slice(m[0].length) : text };
    });
    return Object.keys(entries).length ? { startIndex, endIndex, entries } : null;
  }

  // "[7]" / "[7,8]" / "[3-5]" -> 7. Author-year markers ("[Smith, 2019]", "(GAO, 2021)") carry no
  // endnote ordinal: the marker must be PURELY numeric, or a year's leading digits would be read as
  // an endnote number and silently point the claim at an unrelated source.
  function markerOrdinal(marker) {
    const m = String(marker || '').match(/^\[\s*(\d{1,3})\s*(?:[-,]\s*\d{1,3}\s*)*\]$/);
    return m ? parseInt(m[1], 10) : null;
  }

  // Resolve a unit's kind from its detected signals (fixed precedence). null ⇒ not a unit.
  function kindOf(sig, includeBareClaims) {
    if (sig.quote) return 'quote';
    if (sig.url || sig.doi || sig.marker || sig.domain) return 'citation';
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

    // The endnote list is the document's SOURCE TABLE, not claim material: skip it when mining, and
    // keep it to dereference "[n]" markers below. opts.mineReferences re-enables the old behaviour.
    const refs = opts.mineReferences ? null : findReferenceSection(blocks, opts);

    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      if (!block || !TEXT_BLOCKS.has(block.type)) continue;
      if (block.type === 'heading' && !includeHeadings) continue;
      if (refs && bi >= refs.startIndex && bi <= refs.endIndex) continue;   // a source, not a claim

      // A note covers the sentences that DEPEND on it, not only the one carrying the digit. Authors
      // mark the first sentence of a run and let the rest inherit — footnote 1 here is explicitly a
      // source for fourth AND eighth grade, yet "Only 25 percent of eighth graders do." carried no
      // marker and was reported to the author as uncited. Carried forward within ONE BLOCK (a
      // paragraph) and reset at its edge, because a citation does not reach across a paragraph break.
      // Recorded as `inheritedMarker` rather than silently becoming the unit's own: a claim verified
      // — or faulted — on a citation it does not itself carry has to say so.
      let carried = null;
      const candidates = splitCandidates(block);
      candidates.forEach((text, si) => {
        candidateCount++;
        const quotes = detectQuotes(text, minQuoteLen);
        const urls = detectUrls(text);
        const dois = detectDois(text);
        const markers = detectMarkers(text);
        const numbers = detectNumbers(text);
        const domains = urls.length ? [] : detectDomains(text);   // a full url already carries the host
        const qOpts = { minWords: opts.minQuoteWords, minChars: opts.minQuoteChars };
        const sig = {
          quote: first(quotes.filter(q => isVerifiableQuote(q, qOpts))),   // a NAME in quotes is not a claim
          url: first(urls), doi: first(dois), marker: first(markers), domain: first(domains), numbers,
        };
        const kind = kindOf(sig, includeBareClaims);
        if (!kind) return;

        const unit = { uid: `${block.anchor}.s${si}`, anchor: block.anchor, blockType: block.type, kind, text };
        if (sig.quote) unit.quote = sig.quote;
        if (sig.url) unit.url = sig.url;
        if (sig.doi) unit.doi = sig.doi;
        if (sig.marker) unit.marker = sig.marker;
        // DELIBERATELY `domain`, not `url`: promoting "ago.mo.gov" to "https://ago.mo.gov" would send
        // the resolver's rung 1 at a HOMEPAGE and then judge the claim against whatever is on it
        // today — a confident verdict from the wrong page. As a domain it stays a citation SIGNAL, so
        // the unit is verified via search on its own citation text (publisher + title + date), which
        // is the strong query here, and the host is kept for scoping/display.
        if (sig.domain) unit.domain = sig.domain;
        if (numbers.length) unit.numbers = numbers;
        // A sentence may cite several sources inline, exactly as an endnote may.
        if (urls.length > 1) unit.urls = urls.slice();

        // Dereference "[n]" against the endnote list so the resolver can fetch the source the
        // document actually cited (ladder rung 1) instead of blind-searching the web (rung 4).
        if (refs && sig.marker && !unit.url) {
          const ord = markerOrdinal(sig.marker);
          const ref = ord != null ? refs.entries[ord] : null;
          if (ref && ref.url) {
            unit.url = ref.url;
            if (ref.urls && ref.urls.length > 1) unit.urls = ref.urls.slice();
            unit.refOrdinal = ord;
            unit.refAnchor = ref.anchor;
          }
        }

        // This sentence carries its own citation → it becomes what the rest of the paragraph
        // inherits. Otherwise, inherit the paragraph's last one (if any). Runs AFTER kindOf, so an
        // inherited citation can never turn a signal-less sentence into a unit — only supply the
        // source for a sentence that was already checkable on its own.
        if (sig.marker || sig.url || sig.doi) {
          carried = (unit.url || unit.doi)
            ? { marker: sig.marker || null, url: unit.url || null, urls: unit.urls || null, doi: unit.doi || null, ordinal: unit.refOrdinal != null ? unit.refOrdinal : null }
            : null;
        } else if (carried && !unit.url && !unit.doi) {
          if (carried.url) unit.url = carried.url;
          if (carried.urls) unit.urls = carried.urls.slice();
          if (carried.doi) unit.doi = carried.doi;
          if (carried.ordinal != null) unit.refOrdinal = carried.ordinal;
          unit.inheritedMarker = carried.marker || (carried.ordinal != null ? `[${carried.ordinal}]` : null);
        }
        units.push(unit);
      });
    }

    const byKind = {};
    for (const k of KINDS) byKind[k] = 0;
    for (const u of units) byKind[u.kind]++;

    return {
      units,
      summary: {
        blockCount: blocks.length, candidateCount, unitCount: units.length, byKind,
        referenceStart: refs ? refs.startIndex : null,
        referenceEntries: refs ? Object.keys(refs.entries).length : 0,
        markersDereferenced: units.filter(u => u.refOrdinal != null).length,
      },
    };
  }

  return {
    extractUnits, kindOf, splitCandidates, findReferenceSection, markerOrdinal, detectDomains, isVerifiableQuote,
    splitSentences, detectQuotes, detectUrls, detectDois, detectMarkers, detectNumbers,
    KINDS, TEXT_BLOCKS,
  };
});
