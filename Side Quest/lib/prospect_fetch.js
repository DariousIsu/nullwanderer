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

// DATA-BROKER / contact-aggregator domains — paywalled "reveal email" walls (often Cloudflare-gated),
// NOT the person's real bio. Skip them so the multi-layer drill spends its hops on real company pages.
const BROKER_RE = /(?:^|\.)(?:zoominfo|wiza|contactout|rocketreach|apollo|lusha|signalhire|leadiq|hunter|clearbit|datanyze|uplead|seamless|cufinder|adapt|kaspr|snov|getprospect|findymail|anymailfinder|nymeria|swordfish|lead411|spokeo|beenverified|radaris|whitepages|usphonebook|peoplefinder|truepeoplesearch|fastpeoplesearch)\.[a-z.]{2,}$/i;
function isBrokerUrl(url) {
  let host = '';
  try { host = new URL(String(url)).hostname.replace(/^www\./, ''); } catch { host = String(url || '').replace(/^https?:\/\//i, '').split(/[\/?#]/)[0].replace(/^www\./, ''); }
  return BROKER_RE.test(host);
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
// Pick the sub-links worth drilling into: a REAL nav link is short ("Leadership", "Our Team", "Contact")
// — skip long hero/heading text ("Meet the Team Dedicated to Building a Better Future") that happens to
// contain a keyword. Dedupe by name, keep the RELEVANT short ones, cap at maxHops. Pure.
function pickFollowLinks(text, { maxHops = 3 } = {}) {
  const seen = new Set(); const out = [];
  for (const h of parseHandles(text)) {
    const k = h.name.toLowerCase();
    if (seen.has(k)) continue; seen.add(k);
    if (h.name.split(/\s+/).length > 4 || h.name.length > 40) continue;   // nav links are short; skip hero/heading text
    if (RELEVANT_LINK.test(h.name)) out.push(h);
    if (out.length >= maxHops) break;
  }
  return out;
}

// nav labels that are NOT a person's name — used to gate the person-bio link heuristic.
const NAV_STOP = /\b(home|about|contact|leader|leadership|team|careers?|jobs?|login|sign|search|menu|news|media|press|privacy|terms|cookie|subscribe|donate|events?|resources?|blog|services?|products?|solutions?|investors?|governance|sitemap|faq|help|support|more|read|learn|view|our|company|overview|board|directors?|officers?|staff|people|profile)\b/i;
// Does a link's TEXT look like a person's name (2-4 capitalized tokens, e.g. "Jane Roe", "J. Clay Sell")?
// On a team INDEX page each leader's name links to their bio (where the direct email/title lives).
function looksLikePersonLink(name) {
  const n = String(name || '').trim();
  const toks = n.split(/\s+/);
  if (toks.length < 2 || toks.length > 4) return false;
  if (NAV_STOP.test(n)) return false;
  const capish = toks.filter(t => /^[A-Z][a-z'’.\-]+$/.test(t) || /^[A-Z]\.?$/.test(t) || /^(de|la|van|von|del|di)$/i.test(t)).length;
  return capish >= 2;   // at least a capitalized first + last
}
// Pick individual-bio links (person names) from the index, deduped, capped. Pure.
function pickPersonLinks(text, { max = 4 } = {}) {
  const seen = new Set(); const out = [];
  for (const h of parseHandles(text)) {
    const k = h.name.toLowerCase();
    if (seen.has(k)) continue; seen.add(k);
    if (looksLikePersonLink(h.name)) out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

// pure: the filename tokens of an image URL ("jane-doe-2024.jpg" → [jane, doe, 2024]).
function _fileTokens(src) {
  try { const p = (new URL(String(src)).pathname.split('/').pop()) || ''; return p.toLowerCase().replace(/\.[a-z0-9]+$/, '').split(/[^a-z0-9]+/).filter(Boolean); }
  catch { return String(src || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
}
// pure: pick the best OFFICIAL PHOTO for a person from a page's images. Score = how many of the person's
// name tokens appear in the image's alt / nearby text / filename. Requires ≥2 tokens matched (or the whole
// name if single-token). Returns the src or null. Deterministic → offline-smoke-testable.
function matchPhotoForPerson(name, images) {
  const want = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  if (want.length < 2 || !Array.isArray(images) || !images.length) return null;   // need first+last; a lone token grabs the wrong person
  let best = null, bestScore = 0;
  for (const im of images) {
    if (!im || !im.src) continue;
    const hay = new Set([
      ...String(im.alt || '').toLowerCase().split(/[^a-z0-9]+/),
      ...String(im.near || '').toLowerCase().split(/[^a-z0-9]+/),
      ..._fileTokens(im.src),
    ].filter(Boolean));
    const overlap = want.filter((w) => hay.has(w)).length;
    if (overlap > bestScore) { bestScore = overlap; best = im; }
  }
  return bestScore >= 2 ? best.src : null;   // ≥2 name tokens must match — the corroboration bar for a confident grab
}

// MULTI-LAYER browse (Lucas: "make sure we are actually clicking through multiple layers"). Land on the
// top search result, read it, then CLICK THROUGH one layer deeper: up to `maxHops` relevant NAV links
// (the real team page, a Contact page) AND up to `maxBios` individual PERSON-name links (each leader's
// bio, where the direct email/title lives). Returns to the index between hops so each click resolves
// against a fresh element registry. Merges every layer as a browser source. `browser` = lib/web (injected:
// open/openTopResult/read/click/back). Fail-soft: any hop that errors is skipped. Never throws.
async function deepBrowse(browser, query, { maxHops = 2, maxBios = 4, minText = 200, log, bankPdf = null } = {}) {
  const rows = [];
  if (!browser) return rows;
  try {
    const s = await browser.open(query); if (!s || !s.ok) return rows;
    const top = await browser.openTopResult(); if (!top || !top.ok) return rows;
    let r = await browser.read(); if (!r || !r.ok) return rows;
    const norm = (u) => String(u || '').split('#')[0].replace(/\/+$/, '').toLowerCase();   // ignore #anchors + trailing slash
    const seenUrl = new Set();
    const landingUrl = top.url || r.url;
    // Skip a data-broker landing entirely (paywalled aggregator, not a real bio) → [] so the caller falls
    // back to the layered fetch instead of minting broker-CTA junk.
    if (isBrokerUrl(landingUrl)) { log && log(`[browser] skipped data-broker landing: ${landingUrl}`); return rows; }
    // A PDF landing can never deep-browse (no links to click, read yields nothing) — every attempt
    // logged "deep-browsed 0 layer(s)" and NOTHING remembered the failure, so the same dead PDF was
    // retried forever in the VISIBLE browser (live 2026-07-23: fcoe.org directory PDF on loop while
    // Lucas watched). Skip it; the caller falls back to the layered fetch, which CAN read PDFs.
    // VISITED LEDGER (2026-07-23): an autonomous re-visit of a fresh-enough capture is the
    // 500-calls disease — reuse the capture instead of navigating again. Checked BEFORE the PDF
    // branch so a repeat PDF landing reads "already digested" instead of re-firing the bank chain
    // (live: two contact queries topped out at the same OJP scan 15 min apart). Fail-soft: a
    // ledger error only PERMITS a navigation, never blocks one.
    try {
      const _lg = require('./site_ledger').shouldSkip(landingUrl);
      if (_lg.skip) { log && log(`[browser] already digested — ${_lg.why}: ${landingUrl}`); return rows; }
    } catch {}
    if (/\.pdf(?:[?#]|$)/i.test(String(landingUrl || ''))) {
      // The search compute is already SPENT by the time we land here — discarding the found PDF
      // wastes it (Lucas 2026-07-23: "logging the data … or spending the compute finding the wrong
      // thing and then discarding it outright?"). BANK it through the download lane instead: it
      // extracts, decomposes, and dedups (content-hash + cross-boot ledger) like any grabbed file.
      log && log(`[browser] PDF landing → ${typeof bankPdf === 'function' ? 'banked to the download lane' : 'skipped'} (deep-browse can't read it): ${landingUrl}`);
      if (typeof bankPdf === 'function') { try { Promise.resolve(bankPdf(landingUrl)).catch(() => {}); } catch {} }
      return rows;
    }
    const imgsAt = async () => { try { return (typeof browser.pageImages === 'function') ? (await browser.pageImages()) || [] : []; } catch { return []; } };
    if (String(r.text || '').trim().length >= minText) { rows.push({ text: String(r.text).slice(0, 8000), url: landingUrl, source: 'browser', images: await imgsAt() }); }
    seenUrl.add(norm(landingUrl));
    // nav links first (reach the real team page if we landed on a homepage), then individual bios.
    const follow = [...pickFollowLinks(r.text, { maxHops }), ...pickPersonLinks(r.text, { max: maxBios })];
    for (const h of follow) {
      try {
        const c = await browser.click(h.handle);
        const cu = c && c.ok ? norm(c.url) : '';
        if (cu && !seenUrl.has(cu) && !isBrokerUrl(c.url)) {   // a genuinely NEW, non-broker page
          seenUrl.add(cu);
          const r2 = await browser.read();
          const t2 = String((r2 && r2.text) || '').trim();
          if (r2 && r2.ok && t2.length >= minText) rows.push({ text: t2.slice(0, 8000), url: r2.url || c.url, source: 'browser', via: h.name, images: await imgsAt() });
        }
      } catch {}
      try { await browser.back(); await browser.read(); } catch {}   // back to the index + rebuild the registry for the next hop
    }
    log && log(`[browser] deep-browsed ${rows.length} layer(s) from ${landingUrl}${follow.length ? ' (via ' + follow.map(f => f.name).join(', ') + ')' : ''}`);
    // SITE DIGEST PLAN: the pages this browse actually reached extend the host's checklist, and the
    // coverage line NARRATES progress — slowness explained, never silent (Lucas 2026-07-23).
    try {
      const sl = require('./site_ledger');
      sl.buildPlan(landingUrl, rows.map((x) => x && x.url).filter(Boolean));
      const pl = sl.planLine(sl.hostOf(landingUrl));
      if (pl) log && log(pl);
    } catch {}
  } catch (e) { log && log(`[browser] deepBrowse failed: ${e && e.message}`); }
  return rows;
}

module.exports = { makeWebFetcher, pageResult, deepBrowse, matchPhotoForPerson, pickFollowLinks, pickPersonLinks, looksLikePersonLink, isBrokerUrl, parseHandles, RELEVANT_LINK };
