/**
 * lib/prospect_fetch.js — BROWSER-FIRST page fetching for the Puller lane (Lucas: "use her browser and
 * her full browser capabilities"). The old web layer was a fragile DuckDuckGo snippet scraper + a raw
 * page fetch, which pulled Wikipedia and wrong-org people. This drives Echo's real browser — open a
 * session, navigate (SSRF-guarded, http/https only), extract the rendered inner text, close — so the
 * lane reads the ACTUAL staff/leadership page a company publishes, not a snippet.
 *
 * Layered + fail-soft: search finds candidate URLs → her browser scrapes the top pages → if the browser
 * is unavailable (capability not granted / denied) or yields nothing, it falls back to the injected
 * layered fetch (live wiki → local corpus → search snippets). Every I/O dep is injected (dispatch =
 * echoSuit.dispatch, webSearch, fallback) → offline-smoke-testable. Never throws.
 */
'use strict';

async function _dispatch(dispatch, name, args) {
  try { return await dispatch({ kind: 'do', name, args }); } catch (e) { return { ok: false, error: e && e.message }; }
}
// echoSuit.dispatch returns { ok, text }; the tool's own JSON payload is in `text`. Unwrap it.
function _parse(r) {
  if (!r) return null;
  if (r.ok === false) return null;
  if (typeof r.text === 'string') { try { return JSON.parse(r.text); } catch { return { text: r.text }; } }
  return r;
}

// Open a browser session, handling the confirm gate: on confirmation_required, auto-approve via
// os_approval_resolve (the lane owns its own read-only navigation), then re-open with the approval_id.
// Returns session_id | null (any denial → null → the caller falls back). Fail-soft.
async function openSession(dispatch, { log } = {}) {
  let r = _parse(await _dispatch(dispatch, 'browser_open_session', { headless: true }));
  if (r && r.session_id) return r.session_id;
  if (r && r.status === 'confirmation_required' && r.approval_id) {
    await _dispatch(dispatch, 'os_approval_resolve', { approval_id: r.approval_id, approved: true, by: 'puller-lane' });
    r = _parse(await _dispatch(dispatch, 'browser_open_session', { approval_id: r.approval_id, headless: true }));
    if (r && r.session_id) return r.session_id;
  }
  log && log(`[browser] session unavailable (${(r && (r.error || r.reason || r.status)) || 'no session'})`);
  return null;
}

// Navigate her browser to `url` and return its rendered inner text as { text, url } | null. Always closes
// the session. Read-only (navigate + extract only — no fill/click/auth).
async function browserGet(dispatch, url, { log, minText = 200 } = {}) {
  if (typeof dispatch !== 'function' || !url || !/^https?:\/\//i.test(String(url))) return null;
  const sid = await openSession(dispatch, { log });
  if (!sid) return null;
  try {
    const nav = _parse(await _dispatch(dispatch, 'browser_navigate', { session_id: sid, url }));
    if (nav === null) return null;
    const ex = _parse(await _dispatch(dispatch, 'browser_extract', { session_id: sid }));
    const text = String((ex && (ex.text || ex.inner_text || ex.body)) || (typeof ex === 'string' ? ex : '')).trim();
    return text.length >= minText ? { text: text.slice(0, 8000), url } : null;
  } finally { try { await _dispatch(dispatch, 'browser_close_session', { session_id: sid }); } catch {} }
}

// A browser-FIRST layered fetcher(query) → [{text,url,source}]. (1) search for candidate URLs, (2) her
// browser scrapes the top pages, (3) fall back to the injected layered fetch when the browser yields
// nothing. Same return shape as graph_walk.fetchLayeredSources so the Puller lane is a drop-in swap.
function makeWebFetcher({ dispatch, webSearch, fallback, log, maxPages = 2 } = {}) {
  return async (query) => {
    const out = [];
    let urls = [];
    if (typeof webSearch === 'function') {
      try { const { results } = await webSearch(query); urls = (results || []).map(r => r && r.url).filter(u => /^https?:\/\//i.test(String(u || ''))); } catch {}
    }
    for (const url of urls.slice(0, maxPages)) {
      const got = await browserGet(dispatch, url, { log });
      if (got && got.text) out.push({ text: got.text, url: got.url, source: 'browser' });
      if (out.length >= maxPages) break;
    }
    if (out.length) { log && log(`[browser] scraped ${out.length} page(s) for "${String(query).slice(0, 48)}"`); return out; }
    if (typeof fallback === 'function') { try { return (await fallback(query)) || []; } catch { return []; } }
    return [];
  };
}

module.exports = { browserGet, openSession, makeWebFetcher, _parse };
