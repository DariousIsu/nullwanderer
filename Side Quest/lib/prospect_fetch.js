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

// A relevant sub-link to DRILL into from a landing page — nav to the real team/contact page, or an
// individual bio/profile. Deliberately scoped so we don't wander the whole site.
const RELEVANT_LINK = /\b(leader(?:ship)?|team|our[-\s]?people|staff|about[-\s]?us|contact|bio(?:graphy)?|profile|management|executives?|leadership[-\s]?team|board|directors?|officers?|who[-\s]?we[-\s]?are)\b/i;
// read().text lists interactive elements as "  [L0] link: Some Name" / "[B1] button: …". Parse them.
const HANDLE_RE = /\[([LBC]\d+)\]\s+(?:link|card|button):\s*(.+)/gi;
function parseHandles(text) {
  const out = []; let m; HANDLE_RE.lastIndex = 0;
  while ((m = HANDLE_RE.exec(String(text || ''))) !== null) { const name = m[2].trim(); if (name && name !== '(unlabeled)') out.push({ handle: m[1], name }); }
  return out;
}
// Pick the sub-links worth drilling into: dedupe by name, keep the RELEVANT ones, cap at maxHops. Pure.
function pickFollowLinks(text, { maxHops = 3 } = {}) {
  const seen = new Set(); const out = [];
  for (const h of parseHandles(text)) {
    const k = h.name.toLowerCase();
    if (seen.has(k)) continue; seen.add(k);
    if (RELEVANT_LINK.test(h.name)) out.push(h);
    if (out.length >= maxHops) break;
  }
  return out;
}

// MULTI-LAYER browse (Lucas: "make sure we are actually clicking through multiple layers"). Land on the
// top search result, read it, then CLICK THROUGH up to `maxHops` relevant sub-links (the real team page,
// a Contact page, individual bios) one layer deeper — returning to the index between hops so each click
// resolves against a fresh element registry. Merges every layer as a browser source. `browser` = lib/web
// (injected: open/openTopResult/read/click/back). Fail-soft: any hop that errors is skipped. Never throws.
async function deepBrowse(browser, query, { maxHops = 3, minText = 200, log } = {}) {
  const rows = [];
  if (!browser) return rows;
  try {
    const s = await browser.open(query); if (!s || !s.ok) return rows;
    const top = await browser.openTopResult(); if (!top || !top.ok) return rows;
    let r = await browser.read(); if (!r || !r.ok) return rows;
    const seenUrl = new Set();
    const landingUrl = top.url || r.url;
    if (String(r.text || '').trim().length >= minText) { rows.push({ text: String(r.text).slice(0, 8000), url: landingUrl, source: 'browser' }); }
    seenUrl.add(landingUrl);
    const follow = pickFollowLinks(r.text, { maxHops });
    for (const h of follow) {
      try {
        const c = await browser.click(h.handle);
        if (c && c.ok && c.url && !seenUrl.has(c.url)) {
          const r2 = await browser.read();
          const t2 = String((r2 && r2.text) || '').trim();
          if (r2 && r2.ok && t2.length >= minText) { rows.push({ text: t2.slice(0, 8000), url: r2.url || c.url, source: 'browser', via: h.name }); seenUrl.add(r2.url || c.url); }
        }
      } catch {}
      try { await browser.back(); await browser.read(); } catch {}   // back to the index + rebuild the registry for the next hop
    }
    log && log(`[browser] deep-browsed ${rows.length} layer(s) from ${landingUrl}${follow.length ? ' (via ' + follow.map(f => f.name).join(', ') + ')' : ''}`);
  } catch (e) { log && log(`[browser] deepBrowse failed: ${e && e.message}`); }
  return rows;
}

module.exports = { makeWebFetcher, pageResult, deepBrowse, pickFollowLinks, parseHandles, RELEVANT_LINK };
