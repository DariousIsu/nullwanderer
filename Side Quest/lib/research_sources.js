'use strict';
/**
 * lib/research_sources.js — F3's REAL search/fetch backend: the AUTHORITATIVE tool surface + her live
 * browser, not a flaky keyless web search. Answers "corroborate/verify THIS civic fact" by routing it to
 * the right structured sources (FEC for funding, LegiScan for bills, MediaWiki for people/orgs, GDELT for
 * events), then falling back to a real browser page-read. Light + programmatic — no cloud model per item
 * (a full agentic pass is the escalation, not the default).
 *
 * Provides the `search` + `fetch` executors that research_exec.makeCorroborate / makeVerifyCitation inject.
 * `dispatch` (Echo tools) + `browser` (lib/browser) are injected → the routing/normalizing is pure-testable.
 */
const { extractUrls } = require('./research_exec');

function _parse(res) {
  if (res == null) return null;
  if (typeof res === 'object') return res;
  try { return JSON.parse(res); } catch { return String(res); }
}
function _q(plan) { return (plan && (plan.query || [plan.subject, plan.object].filter(Boolean).join(' '))) || ''; }

// pickTools(plan) → the ordered AUTHORITATIVE tool calls for this fact (most-authoritative-first, capped).
// Reuses research.js's facet→toolset intent, keyed on the RELATION + endpoints. Pure.
function pickTools(plan = {}) {
  const rel = String(plan.relation || plan.relation_type || '').toUpperCase();
  const subj = String(plan.subject || ''); const obj = String(plan.object || '');
  const q = _q(plan);
  const tools = [];
  if (/FUND|DONAT|CONTRIBUT|\bPAC\b|COMMITTEE|SPONSOR/.test(rel)) {
    tools.push({ name: 'fec_committee_search', args: { query: subj || q } });
    tools.push({ name: 'usaspending_search', args: { query: q } });
  }
  if (/HELD_OFFICE|MEMBER|OFFICE|REPRESENT|ELECT|\bBILL\b|VOTE|LEGISLAT/.test(rel)) {
    tools.push({ name: 'legiscan_search', args: { query: q } });
  }
  // general people / orgs / places — Wikipedia is the highest-yield keyless corroborator
  tools.push({ name: 'mediawiki_search', args: { query: subj || q, limit: 5 } });
  // events / recent / news
  tools.push({ name: 'gdelt_article_search', args: { query: q } });
  // de-dupe by tool name, cap for cost
  const seen = new Set();
  return tools.filter((t) => !seen.has(t.name) && seen.add(t.name)).slice(0, 4);
}

// normalize(toolName, parsed) → source URLs from a tool's result. Most tools carry .url (extractUrls);
// mediawiki returns titles (→ Wikipedia URLs); FEC returns committees (→ fec.gov data URLs). Pure.
function normalize(toolName, parsed) {
  const urls = extractUrls(parsed);
  const items = (parsed && (parsed.results || parsed.items || parsed.data || parsed.hits)) || parsed;
  const arr = Array.isArray(items) ? items : (Array.isArray(parsed) ? parsed : []);
  if (/mediawiki/.test(toolName)) {
    for (const it of arr) {
      const title = it && (it.title || it.key || it.name);
      if (title) urls.push(`https://en.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/\s+/g, '_'))}`);
    }
  } else if (/^fec_/.test(toolName)) {
    for (const it of arr) {
      const id = it && (it.committee_id || it.candidate_id || it.id);
      if (id) urls.push(`https://www.fec.gov/data/committee/${encodeURIComponent(id)}/`);
    }
  }
  return [...new Set(urls)];
}

// makeSearch — dispatch the authoritative tools for the fact, collect + normalize source URLs; if nothing
// structured comes back, do a real browser web-search fallback (her live browser).
function makeSearch({ dispatch, browser = null, maxTools = 4 } = {}) {
  return async function search(planOrQuery) {
    const plan = typeof planOrQuery === 'string' ? { query: planOrQuery } : (planOrQuery || {});
    if (typeof dispatch !== 'function') return [];
    const out = [];
    for (const t of pickTools(plan).slice(0, maxTools)) {
      try {
        const r = await dispatch({ kind: 'do', name: t.name, args: t.args });
        normalize(t.name, _parse(r && (r.text !== undefined ? r.text : r))).forEach((u) => out.push(u));
      } catch { /* per-tool fail-soft */ }
    }
    if (!out.length && browser && typeof browser.isConnected === 'function' && browser.isConnected()) {
      try {
        const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(_q(plan))}`;
        await browser.dispatch({ tag: 'open_page', attrs: { url }, body: url });
        const read = await browser.dispatch({ tag: 'read', attrs: {}, body: '' });
        extractUrls(read && (read.text || read)).forEach((u) => out.push(u));
      } catch { /* browser fail-soft */ }
    }
    return [...new Set(out)];
  };
}

// makeFetch — read a page for the verify-citation judge. Prefers her live browser (real render); falls back
// to Echo web_extract (trafilatura clean text).
function makeFetch({ dispatch = null, browser = null } = {}) {
  return async function fetch(url) {
    if (browser && typeof browser.isConnected === 'function' && browser.isConnected()) {
      try {
        await browser.dispatch({ tag: 'open_page', attrs: { url }, body: url });
        const read = await browser.dispatch({ tag: 'read', attrs: {}, body: '' });
        const text = read && (read.text || (typeof read === 'string' ? read : ''));
        if (text && String(text).trim().length > 80) return { text: String(text), url };
      } catch { /* fall through to web_extract */ }
    }
    if (typeof dispatch === 'function') {
      try {
        const r = await dispatch({ kind: 'do', name: 'web_extract', args: { url } });
        const p = _parse(r && (r.text !== undefined ? r.text : r));
        return { text: (p && (p.text || p.body || p.content)) || (typeof p === 'string' ? p : ''), url };
      } catch { /* fail-soft */ }
    }
    return { text: '', url };
  };
}

module.exports = { pickTools, normalize, makeSearch, makeFetch };
