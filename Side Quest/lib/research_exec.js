'use strict';
/**
 * lib/research_exec.js — F3 the REAL executors that close the gap (the injected search/fetch/judge behind
 * research_lane.runResearchItem). Two arms:
 *   corroborate     — web-search the fact → return INDEPENDENT NEW sources (mirror-collapsed) to raise its
 *                     calibrated confidence. Anti-collapse core: N mirrors of one source count as ONE.
 *   verify-citation — find a source for the claim + FETCH it + confirm it actually supports the claim.
 *                     verified ONLY when a fetched page supports it (a search/cloud suggesting a URL is
 *                     NOT grounding — the page must corroborate; cloud-vouch-alone never verifies).
 *
 * search/fetch/judge are INJECTED (default: the app's lib/web_search + a token-overlap judge; a cloud judge
 * or Echo web_extract plug in), so the whole thing is pure + offline-testable. Fail-soft everywhere — a
 * dead search backend just yields nothing (→ the item parks), never throws.
 */
const corroboration = require('./corroboration');

// Normalize any web_search / search result shape (array | {results:[...]} | objects | raw text) → URLs.
function extractUrls(results) {
  const out = [];
  const push = (u) => { if (u && /^https?:\/\//i.test(String(u))) out.push(String(u).replace(/[)"'<>]+$/, '')); };
  const walk = (r, depth = 0) => {
    if (r == null || depth > 4) return;
    if (typeof r === 'string') { const m = r.match(/https?:\/\/[^\s"'<>)]+/g); if (m) m.forEach(push); return; }
    if (Array.isArray(r)) { r.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof r === 'object') { push(r.url || r.href || r.link || r.source); if (r.results) walk(r.results, depth + 1); if (r.items) walk(r.items, depth + 1); }
  };
  walk(results);
  return [...new Set(out)];
}

// Candidate URLs that are INDEPENDENT of the existing source set AND of each other (mirror families
// collapse to one). The anti-collapse filter: Wikipedia + three mirrors → a single independent source.
function independentNew(urls, existing = []) {
  const seen = new Set((existing || []).map((s) => corroboration.sourceFamily(s)).filter(Boolean));
  const out = [];
  for (const u of urls) {
    const fam = corroboration.sourceFamily(u);
    if (!fam || seen.has(fam)) continue;
    seen.add(fam);
    out.push(u);
  }
  return out;
}

// The default entailment judge: does the fetched page text SUPPORT the claim? A conservative token-overlap
// heuristic — most significant claim tokens must appear on the page. (A cloud judge replaces this for real
// semantic entailment; the heuristic keeps the loop offline-testable + favors NOT-verified when unsure.)
function tokenJudge(claim, text) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const body = norm(text);
  const toks = [...new Set(norm(claim).split(/\s+/).filter((t) => t.length >= 4))];
  if (!toks.length || !body) return false;
  const hit = toks.filter((t) => body.includes(t)).length;
  return hit / toks.length >= 0.75;
}

function makeCorroborate({ search, existing = [] } = {}) {
  return async function corroborate(plan) {
    if (typeof search !== 'function') return { sources: [] };
    const query = plan.query || [plan.subject, plan.object].filter(Boolean).join(' ');
    let res = null;
    try { res = await search(query); } catch { return { sources: [] }; }
    return { sources: independentNew(extractUrls(res), existing) };
  };
}

function makeVerifyCitation({ search, fetch, judge = tokenJudge, maxCandidates = 3 } = {}) {
  return async function verifyCitation(plan) {
    if (typeof search !== 'function' || typeof fetch !== 'function') return { verified: false, reason: 'no-executor' };
    let res = null;
    try { res = await search(plan.claim || plan.query || ''); } catch { return { verified: false, reason: 'search-error' }; }
    for (const url of extractUrls(res).slice(0, Math.max(1, maxCandidates))) {
      let page = null;
      try { page = await fetch(url); } catch { continue; }
      const text = typeof page === 'string' ? page : (page && (page.text || page.body || page.content || page.text_preview)) || '';
      if (judge(plan.claim || '', text)) return { verified: true, citation_url: url };
    }
    return { verified: false, reason: 'unverified' };
  };
}

module.exports = { extractUrls, independentNew, tokenJudge, makeCorroborate, makeVerifyCitation };
