/**
 * lib/prospect_fetch.js — BROWSER-FIRST fetching for the Puller lane (Lucas: "use her browser and her
 * full browser capabilities"). The old web layer was a fragile DuckDuckGo HTML scraper (now returns 0 —
 * DDG blocks the raw fetch) + a Wikipedia fallback, which is why prospecting pulled wrong-org people.
 *
 * This routes through HER OWN browser (lib/web — the ungated, prewarmed, persistent-profile real Chrome
 * the chat chain uses; NOT the permission-gated Echo browser_* tools). Her real browser SEARCHES (DDG's
 * HTML SERP served to a real browser where the raw scraper is blocked) → opens the top result → reads the
 * ACTUAL staff/leadership page a company publishes.
 *
 * The whole her-browser sequence is injected as `browserSearch(query) → [{text,url,source}]` so this stays
 * offline-smoke-testable and browser-agnostic. Fail-soft + layered: her browser first; if it yields
 * nothing (blocker / nav fail / not connected), fall back to the injected layered fetch (live wiki →
 * local corpus). Only runs on the idle tick, when her browser is otherwise free. Never throws.
 */
'use strict';

// query → [{text,url,source}]. Her browser first (injected browserSearch), else the layered fallback.
function makeWebFetcher({ browserSearch, fallback, log } = {}) {
  return async (query) => {
    if (typeof browserSearch === 'function') {
      try {
        const r = await browserSearch(query);
        if (Array.isArray(r) && r.length) { log && log(`[browser] read "${String(query).slice(0, 48)}" → ${r[0] && r[0].url}`); return r; }
      } catch (e) { log && log(`[browser] search failed: ${e && e.message}`); }
    }
    if (typeof fallback === 'function') { try { return (await fallback(query)) || []; } catch { return []; } }
    return [];
  };
}

// Shape a her-browser read into the {text,url,source} the lane expects, or null if too thin. Pure helper
// (used by the live browserSearch in monologue + the smoke) so the min-length rule is in one place.
function pageResult(read, url, { minText = 200 } = {}) {
  const text = String((read && read.text) || '').trim();
  if (text.length < minText) return null;
  return { text: text.slice(0, 8000), url: url || (read && read.url) || null, source: 'browser' };
}

module.exports = { makeWebFetcher, pageResult };
