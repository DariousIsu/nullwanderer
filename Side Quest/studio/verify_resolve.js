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
  const PAYWALL = /(subscribe to (?:continue|read)|metered paywall|this article is for subscribers|subscribers only|create a free account to|sign in to (?:read|continue)|to continue reading)/i;
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
    if (PAYWALL.test(body)) return { blocked: true, reason: 'paywall' };
    if (fr.finalUrl && LOGIN_PATH.test(fr.finalUrl)) return { blocked: true, reason: 'login-redirect' };
    return { blocked: false, reason: null };
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

    const tryFetch = async (url, step) => {
      const raw = await callTool(tools.fetch, Object.assign({ url }, opts.fetchArgs || {}));
      const fr = readFetch(raw);
      const b = isBlocked(fr);
      trail.push({ step, tool: tools.fetch, url, ok: !b.blocked, reason: b.reason });
      return { fr, blocked: b.blocked };
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

    // Rung 1 — direct fetch.
    if (unit && unit.url) {
      const { fr, blocked } = await tryFetch(unit.url, 'fetch');
      if (!blocked) return done('fetch', fr);

      // Rung 2 — archive (wayback, then verify_url_history).
      for (const toolKey of ['waybackHistory', 'urlHistory']) {
        let archiveUrl = '';
        try {
          const raw = await callTool(tools[toolKey], { url: unit.url });
          archiveUrl = readArchiveUrl(raw);
        } catch (e) { /* tool unavailable → next */ }
        trail.push({ step: 'archive', tool: tools[toolKey], url: unit.url, ok: !!archiveUrl, reason: archiveUrl ? null : 'no-snapshot' });
        if (archiveUrl) {
          const { fr, blocked } = await tryFetch(archiveUrl, 'archive-fetch');
          if (!blocked) return done('archive', fr, { archive_url: archiveUrl, source_url: unit.url });
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

    // Rung 4 — search by source-kind, fetch top-N until one is readable. An injected opts.search
    // (e.g. Zoe's own DuckDuckGo provider) is preferred when present — Echo's web_search needs a
    // provider key the operator may not have set, so this keeps no-URL claims resolvable.
    const kind = sourceKind(unit);
    const stool = tools[searchToolKey(kind)];
    const query = (unit && (unit.quote || unit.text) || '').slice(0, 300);
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

    // Rung 5 — deterministic terminal.
    return { uid, resolved: false, tier: 'inaccessible', source_text: '', source_url: unit && unit.url || null, archive_url: null, reason: 'inaccessible', trail };
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
    sourceKind, searchToolKey, hostOf,
    DEFAULT_TOOLS, MIN_BODY, PAYWALL, LOGIN_PATH,
  };
});
