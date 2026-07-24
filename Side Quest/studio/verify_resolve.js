/*
 * Editor Studio — verification harness STAGE 3: resolve the source (verify_resolve).
 *
 * Pipeline (EDITOR_TAB_SPEC, FROZEN): extract → THIS → match → preflight → classify → contract.
 * A unit names a source (url/doi) or just carries a quote/claim; this stage turns that into actual
 * SOURCE TEXT to match against — deterministically, via a fixed RESOLUTION LADDER where every
 * branch is `if blocked -> next`. ZERO model cognition: the only judgement is the mechanical
 * blocked-signal (!2xx / empty body / paywall marker / login redirect).
 *
 * The ladder (resolved at any rung exits immediately; the last rung is a deterministic terminal):
 *   1. fetch    web_fetch(url)
 *   2. archive  wayback_history / verify_url_history  → fetch the snapshot
 *   3. oa       web_resolve_oa(doi)                   → fetch the open-access copy
 *   4. search   web_search · academic_search · courtlistener · edgar · fr_search  (by source-kind;
 *               fetch top-N until one is not blocked)
 *   5. inaccessible  (terminal — operator finds another source)
 *
 * Tools are reached through an injected callTool(name,args) (the same dispatcher editor_checks
 * uses — echoClient.callTool in production, a mock in the smoke). Tool names are parameterized
 * (opts.tools) so step-6 wiring can map them to the live Echo MCP names without touching the ladder.
 *
 * Output contract (per spec stage-3 row): { uid, resolved, tier, source_text, source_url,
 * archive_url, reason, trail }. `trail` records every rung attempt (transparency + determinism).
 *
 * Runs in Node (offline smoke, mock callTool) and the browser: CommonJS + window fallback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VerifyResolve = api;
})(this, function () {
  'use strict';

  // Default Echo MCP tool names per ladder rung (override via opts.tools when wiring live).
  const DEFAULT_TOOLS = Object.freeze({
    fetch: 'web_fetch',
    waybackHistory: 'wayback_history',
    urlHistory: 'verify_url_history',
    resolveOa: 'web_resolve_oa',
    webSearch: 'web_search',
    academicSearch: 'academic_search',
    courtSearch: 'courtlistener_opinion_search',
    edgarSearch: 'edgar_full_text_search',
    frSearch: 'fr_search',
  });

  const MIN_BODY = 40;                       // shorter than this ⇒ treat as empty (blocked)
  // A reader can return HTTP 200 with a long body that is still NOT THE DOCUMENT. Observed live
  // through Echo's web_extract (2026-07-23): a cited PDF came back as RAW BYTES ("%PDF-1.7 %…
  // /L 2431168 … endobj") and a cited news article came back as its HTML METADATA ONLY
  // ("headline: … description: …"). Both cleared status, length and the bot/paywall checks, so both
  // became THE SOURCE PASSAGE — and the judge, reading binary or a meta tag, correctly reported that
  // it did not support the claim. Five of eight claims on a real op-ed were faulted this way against
  // citations that were fine. ⭐This is the cert CFC-2026-07-20-01 lesson again: WRONG-source is far
  // worse than no-source, because it produces a confident, fabricated indictment of the author.
  const BINARY_BODY = /^\s*(?:%PDF-|PK\x03\x04|\x89PNG|GIF8|\xFF\xD8\xFF|%!PS-)/;

  // ⭐ THE POSITIVE TEST. Everything above this line is a BLACKLIST — paywall, bot-block, binary
  // magic — and a blacklist is why this kept breaking: each rule was added after an incident and
  // each was defeated by the next payload shape. A length floor died the same way, to a page's
  // <head> plus its JSON-LD schema, which is long AND useless.
  //
  // So ask the question directly instead: IS THIS THE DOCUMENT'S TEXT, OR ITS CONTAINER? Markup,
  // PDF bytes and JSON-LD are all container. Measured on the two readers that disagreed live —
  //   Echo web_extract → `<title data-next-head="">…</title>` + article schema : dense <>, ~0 sentences
  //   browser          → 2,547 chars, 0 markup characters, 17 sentences
  // — which a shape test separates cleanly and a size test cannot.
  //
  // SHAPE IS THE GATE, LENGTH IS ONLY A PREFERENCE. Conflating them is the bug I shipped earlier
  // today: a 120-character prose snippet is a real (if thin) source, while 4KB of markup is not a
  // source at all. Callers pick the LONGEST passing text; they never accept failing text.
  const MARKUP_RATIO_MAX = 0.01;   // prose carries ~0 angle brackets; markup is full of them
  // The module's ONE emptiness floor, deliberately reusing MIN_BODY rather than inventing a second
  // number: "there is nothing here" and "there is not much here" are different questions, and only
  // the first is a gate. Two independent floors is how the size-based thinking crept back in.
  const MIN_PROSE_CHARS = MIN_BODY;
  function isProse(text) {
    const t = String(text == null ? '' : text).trim();
    if (t.length < MIN_PROSE_CHARS) return { ok: false, why: `too short (${t.length} chars)` };
    if (BINARY_BODY.test(t)) return { ok: false, why: 'binary payload — the reader returned the file, not its text' };
    const markup = (t.match(/[<>]/g) || []).length;
    const ratio = markup / t.length;
    if (ratio > MARKUP_RATIO_MAX) return { ok: false, why: `markup, not prose (${markup} angle brackets in ${t.length} chars)` };
    // Real prose ends sentences. A metadata dump ("headline: …; description: …") and a JSON-LD blob
    // do not, which is what separates them from a genuinely short extract.
    const sentences = (t.match(/[.!?]["'”’)\]]?(?:\s|$)/g) || []).length;
    if (sentences < 2) return { ok: false, why: `no sentence structure (${sentences} terminators)` };
    return { ok: true, why: null, chars: t.length, sentences, markupRatio: ratio };
  }
  const PAYWALL = /(subscribe to (?:continue|read)|metered paywall|this article is for subscribers|subscribers only|create a free account to|sign in to (?:read|continue)|to continue reading)/i;
  // BOT/WAF INTERSTITIALS. These return HTTP 200 with a full body, so the status and length checks
  // both pass and the block page is handed to the judge AS THE SOURCE. That is the worst outcome in
  // this pipeline: the judge reads a real page, finds the claim absent (of course), and issues a
  // confident "not supported" — a fabricated indictment of the author's sourcing. Observed live on
  // cert CFC-2026-07-20-01, which quoted "This website is using a security service to protect itself
  // from online attacks" and "…a SQL command or malformed data" back as source passages.
  const BOT_BLOCK = /(using a security service to protect itself|attention required!?\s*\|?\s*cloudflare|cloudflare ray id|please enable (?:cookies|javascript) (?:and reload|to continue)|checking your browser before accessing|verify(?:ing)? you are (?:a )?human|access denied[\s\S]{0,80}(?:reference|error) ?#?\d|you have been blocked|why have i been blocked|enable javascript and cookies to continue|request unsuccessful\.? incapsula|ddos protection by|are you a robot\?)/i;
  const LOGIN_PATH = /\/(login|log-in|signin|sign-in|auth|sso|account\/login)(\b|\/|\?|$)/i;

  // ---- tolerant result readers (accept raw MCP result, {text}, parsed object, or string) -------

  // Pull a text payload out of whatever callTool returned.
  function resultText(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') return raw;
    if (typeof raw.text === 'string') return raw.text;
    if (Array.isArray(raw.content)) return raw.content.map(c => (c && c.text) || '').join('');
    return '';
  }
  // Read a tool result into { text, json } — json is the parsed object if the payload is JSON OR
  // the result was already a plain data object.
  function readResult(raw) {
    const text = resultText(raw);
    if (text) { try { return { text, json: JSON.parse(text) }; } catch { return { text, json: null }; } }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.text !== 'string' && !Array.isArray(raw.content)) {
      return { text: '', json: raw };                 // already-parsed data object (e.g. a mock)
    }
    return { text, json: null };
  }

  // Normalize a fetch tool result into { status, body, finalUrl }.
  function readFetch(raw) {
    const { text, json } = readResult(raw);
    if (json) {
      const status = json.status != null ? json.status
        : (json.status_code != null ? json.status_code : (json.http_status != null ? json.http_status : undefined));
      const body = json.body || json.text || json.content || json.markdown || json.extract || json.text_preview || json.text_excerpt || '';
      const finalUrl = json.final_url || json.resolved_url || json.location || json.url || undefined;
      return { status, body: String(body || ''), finalUrl };
    }
    return { status: undefined, body: String(text || ''), finalUrl: undefined };
  }

  // The one mechanical judgement: is this fetched source blocked? → {blocked, reason}.
  function isBlocked(fr) {
    if (!fr) return { blocked: true, reason: 'no-response' };
    if (fr.status != null && (fr.status < 200 || fr.status >= 300)) return { blocked: true, reason: `http-${fr.status}` };
    const body = (fr.body || '').trim();
    if (body.length < MIN_BODY) return { blocked: true, reason: 'empty-body' };
    // Raw bytes are not a readable source. A reader that hands back the FILE instead of its text has
    // failed, however many bytes it returned — judging a claim against "%PDF-1.7 … endobj" can only
    // ever produce a false "not supported".
    if (BINARY_BODY.test(body)) return { blocked: true, reason: 'binary-body (reader returned the file, not its text)' };
    if (PAYWALL.test(body)) return { blocked: true, reason: 'paywall' };
    if (BOT_BLOCK.test(body)) return { blocked: true, reason: 'bot-block' };
    if (fr.finalUrl && LOGIN_PATH.test(fr.finalUrl)) return { blocked: true, reason: 'login-redirect' };
    return { blocked: false, reason: null };
  }

  // A SUBSTANTIAL quotation is the best possible search key — a distinctive verbatim string usually
  // lands the exact source. A SHORT one is the worst: it drops all context and searches a bare name.
  // Live example from cert CFC-2026-07-20-01 — the quote "Camaro Dragon" (a Chinese APT group) became
  // the entire query and returned Wikipedia's CHEVROLET CAMARO, which the judge then dutifully ruled
  // did not support the claim. Below the bar, search the surrounding sentence instead, which carries
  // the subject matter ("…dubbed 'Camaro Dragon' deployed a custom firmware implant…").
  // Same bar verify_extract uses for "is this a real quotation": 4+ words OR 30+ chars. A 4-word
  // verbatim string is a fine search key; a two-word proper noun is not.
  const MIN_QUERY_WORDS = 4, MIN_QUERY_CHARS = 30;
  function searchQueryFor(unit) {
    const u = unit || {};
    const quote = String(u.quote || '').trim();
    const text = String(u.text || '').trim();
    const substantial = quote && (quote.split(/\s+/).length >= MIN_QUERY_WORDS || quote.length >= MIN_QUERY_CHARS);
    return (substantial ? quote : (text || quote)).slice(0, 300);
  }

  // ---- source-kind routing (deterministic, drives which search tool the ladder uses) -----------

  function hostOf(url) {
    const m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
    return m ? m[1].toLowerCase() : '';
  }
  // Classify a unit's source kind from url host, doi, or textual cues → routes rung 4's search.
  function sourceKind(unit) {
    const host = hostOf(unit && unit.url);
    if (host) {
      if (/courtlistener\.com|justia\.com|law\.cornell\.edu/.test(host)) return 'court';
      if (/sec\.gov/.test(host)) return 'sec';
      if (/federalregister\.gov|govinfo\.gov/.test(host)) return 'fr';
      if (/doi\.org|arxiv\.org|ncbi\.nlm|pubmed|nature\.com|sciencedirect|springer|jstor/.test(host)) return 'academic';
      return 'web';
    }
    if (unit && unit.doi) return 'academic';
    const t = (unit && unit.text) || '';
    if (/\b[A-Z][\w.]+ v\.\s+[A-Z]/.test(t) || /\b\d+\s+U\.S\.\s+\d+/.test(t)) return 'court';
    if (/\b(10-K|8-K|10-Q|S-1|Form\s+\d|SEC filing|S\.E\.C\.)\b/.test(t)) return 'sec';
    if (/\bFed(?:eral)?\.?\s*Reg(?:ister|\.)\b|\bC\.F\.R\.\b/.test(t)) return 'fr';
    if (/\bet al\.?\b|\bdoi:/i.test(t)) return 'academic';
    return 'web';
  }
  function searchToolKey(kind) {
    return { court: 'courtSearch', sec: 'edgarSearch', fr: 'frSearch', academic: 'academicSearch', web: 'webSearch' }[kind] || 'webSearch';
  }

  // Extract a list of candidate {url, title} from a search tool result.
  function readSearchResults(raw) {
    const { json } = readResult(raw);
    if (!json) return [];
    const list = Array.isArray(json) ? json : (json.results || json.items || json.hits || json.data || []);
    return (Array.isArray(list) ? list : [])
      .map(r => ({ url: r.url || r.link || r.source_url || r.pdf_url || '', title: r.title || r.name || r.snippet || '' }))
      .filter(r => r.url);
  }
  // Pull an archived-snapshot url from a wayback/url-history result.
  function readArchiveUrl(raw) {
    const { json } = readResult(raw);
    if (!json) return '';
    if (json.archived_url) return json.archived_url;
    if (json.closest && json.closest.url) return json.closest.url;
    const snaps = json.snapshots || json.history || json.captures;
    if (Array.isArray(snaps) && snaps.length) return snaps[0].url || snaps[0].archived_url || '';
    return json.url || '';
  }
  // Pull an open-access url from a web_resolve_oa result.
  function readOaUrl(raw) {
    const { json } = readResult(raw);
    if (!json) return '';
    return json.oa_url || json.pdf_url || (json.best_oa_location && json.best_oa_location.url) || json.url || '';
  }

  // ---- the ladder ------------------------------------------------------------------------------

  /**
   * Resolve one unit to source text via the deterministic ladder.
   * @param {object} unit    a verify_extract unit ({uid, kind, text, url?, doi?, quote?, ...})
   * @param {function} callTool  async (name, args) -> MCP tool result
   * @param {object} [opts]   { tools, searchTopN, fetchArgs }
   * @returns {Promise<{uid,resolved,tier,source_text,source_url,archive_url,reason,trail}>}
   */
  async function resolveUnit(unit, callTool, opts = {}) {
    const tools = Object.assign({}, DEFAULT_TOOLS, opts.tools || {});
    const topN = opts.searchTopN != null ? opts.searchTopN : 3;
    const trail = [];
    const uid = unit && unit.uid;
    const done = (tier, fr, extra = {}) => ({
      uid, resolved: true, tier, source_text: fr.body, source_url: extra.source_url || unit.url || null,
      archive_url: extra.archive_url || null, reason: null, trail,
    });

    // A LADDER OF READERS, not one reader. `tools.fetch` may be a single tool name or a list tried in
    // order, plus an optional injected `opts.readerFn(url)` last rung for anything a plain text tool
    // cannot open (a PDF, a JS-rendered page). One reader is why a live document's cited government
    // PDF and its cited interactive data page both came back "inaccessible" while both were, in fact,
    // perfectly reachable — the report blamed the author's sourcing for our missing capability.
    // Every attempt is recorded on the trail so a failure says WHICH readers were tried and why each
    // one gave up, instead of a bare "inaccessible".
    const fetchTools = Array.isArray(tools.fetch) ? tools.fetch.filter(Boolean) : [tools.fetch];

    // ⭐ ONE QUESTION, ONE ANSWER: "give me this source's readable text".
    //
    // `opts.readSource(url)` — built by lib/source_reader in production — OWNS that question: it
    // routes by resource TYPE (a .pdf never goes to an HTML text extractor) and returns prose or an
    // honest failure. When it is absent (the offline smokes, which mock callTool), the tool loop
    // below stands in. Both paths apply the SAME acceptance test, `isProse`, so there is exactly one
    // definition of "usable source" in the system rather than a rule per incident.
    const tryFetch = async (url, step) => {
      if (typeof opts.readSource === 'function') {
        let res = null;
        try { res = await opts.readSource(url); } catch (e) { res = { ok: false, why: `reader threw: ${e && e.message}` }; }
        for (const a of ((res && res.attempts) || [])) trail.push({ step, tool: a.reader, url, ok: !!a.ok, reason: a.why || null, chars: a.chars || 0 });
        if (res && res.ok && res.text) {
          trail.push({ step, tool: `source_reader:${res.reader || res.kind || 'ok'}`, url, ok: true, reason: null, chars: res.text.length });
          return { fr: { status: res.status || 200, body: res.text, finalUrl: url }, blocked: false };
        }
        trail.push({ step, tool: 'source_reader', url, ok: false, reason: (res && res.why) || 'no readable text' });
        return { fr: null, blocked: true };
      }

      // Fallback acquisition (offline/mocked): try each text tool, keep the LONGEST that is prose.
      // Shape gates; length only ranks. Both are `isProse` — see its note.
      let best = null, bestLen = -1, last = { fr: null, blocked: true };
      const consider = (fr, tool) => {
        const b = isBlocked(fr);
        const p = b.blocked ? { ok: false, why: b.reason } : isProse(fr && fr.body);
        trail.push({ step, tool, url, ok: !!p.ok, reason: p.why || null, chars: ((fr && fr.body) || '').length });
        if (!p.ok) { last = { fr, blocked: true }; return; }
        const len = (fr.body || '').trim().length;
        if (len > bestLen) { best = fr; bestLen = len; }
      };

      for (const tool of fetchTools) {
        let fr = null;
        try { fr = readFetch(await callTool(tool, Object.assign({ url }, opts.fetchArgs || {}))); }
        catch (e) { trail.push({ step, tool, url, ok: false, reason: `tool-error: ${(e && e.message) || 'threw'}` }); continue; }
        consider(fr, tool);
      }
      if (typeof opts.readerFn === 'function') {
        let body = '';
        try { body = String(await opts.readerFn(url) || ''); } catch (e) { body = ''; }
        consider({ status: 200, body, finalUrl: url }, 'reader(injected)');
      }
      if (best) return { fr: best, blocked: false };
      return last;
    };

    // Rung 0 — ATTACHED in-house source. When the operator has tagged an in-hand document to THIS
    // citation (by uid), resolve straight from its text and skip the web ladder entirely. The tag
    // decides the source; the downstream classify still judges whether the claim actually follows.
    const att = opts.attachments && uid ? opts.attachments[uid] : null;
    const attBody = att && String((att.text != null ? att.text : att.source_text) || '');
    if (attBody && attBody.trim().length >= MIN_BODY) {
      trail.push({ step: 'attached', tool: 'in-house-source', ok: true, reason: null });
      return {
        uid, resolved: true, tier: 'reference', source_text: attBody,
        source_url: (att.title || att.ref || att.docRef || 'in-house source'), archive_url: null, reason: null, trail,
      };
    }

    // EVERY url this unit cites, primary first. A citation that names several sources gets all of
    // them tried — keeping only the first is how a note's supporting source got discarded unread.
    const citedUrls = [];
    const pushUrl = (u) => { if (u && !citedUrls.includes(u)) citedUrls.push(u); };
    if (unit) { pushUrl(unit.url); (Array.isArray(unit.urls) ? unit.urls : []).forEach(pushUrl); }

    // The terminal verdict distinguishes UNCITED from INACCESSIBLE. "You gave no source" and "we
    // could not reach your source" are different facts and an author acts on them differently;
    // collapsing both into `inaccessible` made the report apologise for a fetch that never had a
    // target. Computed at the END, not up front — a unit with no url is precisely what rung 4's
    // search-by-quote exists for, so it must still get there when search is enabled.
    const nothingCited = !citedUrls.length && !(unit && unit.doi);
    const terminal = () => (nothingCited
      ? { uid, resolved: false, tier: 'uncited', source_text: '', source_url: null, archive_url: null, reason: 'uncited', trail }
      : { uid, resolved: false, tier: 'inaccessible', source_text: '', source_url: (unit && unit.url) || null, archive_url: null, reason: 'inaccessible', trail });

    // Rung 1 — direct fetch. Every cited url is fetched, not just the first that works: when a note
    // cites two sources, which one actually carries the claim is a question for the MATCH stage, and
    // it can only answer it if it is handed both. Extras ride on `alternates`; the primary keeps the
    // top-level shape every existing caller reads.
    const maxUrls = opts.maxCitedUrls != null ? opts.maxCitedUrls : 4;
    const fetched = [];
    for (const cu of citedUrls.slice(0, maxUrls)) {
      const { fr, blocked } = await tryFetch(cu, 'fetch');
      if (!blocked) fetched.push(done('fetch', fr, { source_url: cu }));
    }
    if (fetched.length) {
      const primary = fetched[0];
      if (fetched.length > 1) primary.alternates = fetched.slice(1);
      return primary;
    }

    // Rung 2 — archive (wayback, then verify_url_history), again across every cited url.
    for (const cu of citedUrls) {
      for (const toolKey of ['waybackHistory', 'urlHistory']) {
        let archiveUrl = '';
        try {
          const raw = await callTool(tools[toolKey], { url: cu });
          archiveUrl = readArchiveUrl(raw);
        } catch (e) { /* tool unavailable → next */ }
        trail.push({ step: 'archive', tool: tools[toolKey], url: cu, ok: !!archiveUrl, reason: archiveUrl ? null : 'no-snapshot' });
        if (archiveUrl) {
          const { fr, blocked } = await tryFetch(archiveUrl, 'archive-fetch');
          if (!blocked) return done('archive', fr, { archive_url: archiveUrl, source_url: cu });
        }
      }
    }

    // Rung 3 — open-access resolution by DOI.
    if (unit && unit.doi) {
      let oaUrl = '';
      try { oaUrl = readOaUrl(await callTool(tools.resolveOa, { doi: unit.doi })); } catch (e) { /* next */ }
      trail.push({ step: 'oa', tool: tools.resolveOa, ok: !!oaUrl, reason: oaUrl ? null : 'no-oa' });
      if (oaUrl) {
        const { fr, blocked } = await tryFetch(oaUrl, 'oa-fetch');
        if (!blocked) return done('oa', fr, { source_url: oaUrl });
      }
    }

    // Rung 4 — SOURCE SUBSTITUTION BY SEARCH. Off by default, and it must stay off for citation
    // verification: that lane asks one question — "is this claim correctly sourced to the source the
    // document CITES?" — and a page found by search is, by definition, not that source. Judging
    // against a substitute is how "Camaro Dragon" was checked against Wikipedia's CHEVROLET CAMARO,
    // and how two Cambridge Dictionary entries were reported as consulted sources
    // (cert CFC-2026-07-20-01). When the cited source cannot be reached the honest answer is rung 5
    // `inaccessible`, which already renders as "couldn't reach — operator finds another source".
    // Finding OTHER sources is the FACT-CHECK lane's job (studio/verify_factcheck), where a
    // corroborating or countering source is offered for consideration rather than used to rule on
    // the author's citation.
    if (!opts.allowSearch) {
      trail.push({ step: 'search', ok: false, reason: 'search-disabled (citation lane: cited source only)' });
      return terminal();
    }
    const kind = sourceKind(unit);
    const stool = tools[searchToolKey(kind)];
    const query = searchQueryFor(unit);
    let results = [];
    try {
      const raw = typeof opts.search === 'function' ? await opts.search(query, { kind }) : await callTool(stool, { query, q: query });
      results = readSearchResults(raw);
    } catch (e) { /* next */ }
    trail.push({ step: 'search', tool: typeof opts.search === 'function' ? 'search(injected)' : stool, kind, ok: results.length > 0, reason: results.length ? null : 'no-results', count: results.length });
    for (const r of results.slice(0, topN)) {
      const { fr, blocked } = await tryFetch(r.url, 'search-fetch');
      if (!blocked) return done('search', fr, { source_url: r.url });
    }

    // Rung 5 — deterministic terminal (uncited vs inaccessible, per `terminal()` above).
    return terminal();
  }

  /**
   * Resolve many units. Sequential by default (deterministic ordering); pass opts.concurrency>1
   * to fan out (order of the returned array still matches the input).
   */
  async function resolveUnits(units, callTool, opts = {}) {
    const list = Array.isArray(units) ? units : [];
    const conc = Math.max(1, opts.concurrency | 0 || 1);
    if (conc === 1) {
      const out = [];
      for (const u of list) out.push(await resolveUnit(u, callTool, opts));
      return out;
    }
    const out = new Array(list.length);
    let next = 0;
    async function worker() { for (let i = next++; i < list.length; i = next++) out[i] = await resolveUnit(list[i], callTool, opts); }
    await Promise.all(Array.from({ length: Math.min(conc, list.length) }, worker));
    return out;
  }

  return {
    resolveUnit, resolveUnits,
    isBlocked, readFetch, readResult, readSearchResults, readArchiveUrl, readOaUrl,
    sourceKind, searchToolKey, hostOf, searchQueryFor,
    DEFAULT_TOOLS, MIN_BODY, PAYWALL, LOGIN_PATH, BOT_BLOCK, BINARY_BODY, isProse, MARKUP_RATIO_MAX, MIN_PROSE_CHARS,
  };
});
