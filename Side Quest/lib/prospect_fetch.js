/**
 * lib/prospect_fetch.js — BROWSER-FIRST page fetching for the Puller lane (Lucas: "use her browser and
 * her full browser capabilities"). The old web layer was a fragile DuckDuckGo snippet scraper + a raw
 * page fetch, which pulled Wikipedia and wrong-org people. This reads the ACTUAL staff/leadership page a
 * company publishes, through HER OWN browser (lib/web — the ungated, prewarmed, persistent-profile Chrome
 * the main chat chain already uses to open+read sites — NOT the permission-gated Echo browser_* tools).
 *
 * The browser is injected as `pageFetch(url) → {text,url} | null` so this stays offline-smoke-testable and
 * browser-agnostic. Layered + fail-soft: search finds candidate URLs → her browser reads the top pages →
 * if the browser is unavailable or yields nothing, it falls back to the injected layered fetch (live wiki
 * → local corpus → search snippets). Only runs on the idle tick, when her browser is otherwise free.
 * Never throws.
 */
'use strict';

// Read one URL through the injected browser (pageFetch = her-browser open+read). Guards non-http(s) urls
// (SSRF-safe) and thin pages. Returns { text, url } | null. pageFetch is expected to be fail-soft itself.
async function browserGet(pageFetch, url, { minText = 200 } = {}) {
  if (typeof pageFetch !== 'function' || !url || !/^https?:\/\//i.test(String(url))) return null;
  let got = null;
  try { got = await pageFetch(url); } catch { return null; }
  if (!got || !got.text) return null;
  const text = String(got.text).trim();
  return text.length >= minText ? { text: text.slice(0, 8000), url: got.url || url } : null;
}

// A browser-FIRST layered fetcher(query) → [{text,url,source}]. (1) search for candidate URLs, (2) her
// browser reads the top pages, (3) fall back to the injected layered fetch when the browser yields
// nothing. Same return shape as graph_walk.fetchLayeredSources so the Puller lane is a drop-in swap.
function makeWebFetcher({ pageFetch, webSearch, fallback, log, maxPages = 2 } = {}) {
  return async (query) => {
    const out = [];
    let urls = [];
    if (typeof webSearch === 'function') {
      try { const { results } = await webSearch(query); urls = (results || []).map(r => r && r.url).filter(u => /^https?:\/\//i.test(String(u || ''))); } catch {}
    }
    for (const url of urls.slice(0, maxPages)) {
      const got = await browserGet(pageFetch, url);
      if (got && got.text) out.push({ text: got.text, url: got.url, source: 'browser' });
      if (out.length >= maxPages) break;
    }
    if (out.length) { log && log(`[browser] read ${out.length} page(s) for "${String(query).slice(0, 48)}"`); return out; }
    if (typeof fallback === 'function') { try { return (await fallback(query)) || []; } catch { return []; } }
    return [];
  };
}

module.exports = { browserGet, makeWebFetcher };
