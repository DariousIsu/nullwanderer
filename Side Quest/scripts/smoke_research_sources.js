/* Smoke: lib/research_sources — F3 authoritative-tool + browser backend (offline, mock dispatch/browser).
 * Proof: a fact routes to the RIGHT authoritative tools (FEC for funding, LegiScan for office/bills,
 * MediaWiki always, GDELT for news); result normalization (mediawiki titles→wiki URLs, FEC ids→fec URLs,
 * generic .url); makeSearch collects independent sources across tools; the browser fallback fires only
 * when the tools return nothing; makeFetch prefers the live browser then falls back to web_extract.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_research_sources.js
 */
'use strict';
const S = require('../lib/research_sources');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- pickTools (fact → authoritative tools) --------------------------------------------------------
console.log('== pickTools ==');
const funds = S.pickTools({ subject: 'Acme PAC', object: 'Sen. Doe', relation: 'FUNDS' }).map((t) => t.name);
ok(funds.includes('fec_committee_search') && funds.includes('usaspending_search'), 'a FUNDS edge routes to FEC + USAspending (authoritative funding sources)');
ok(funds[0] === 'fec_committee_search', 'the most-authoritative tool (FEC) is tried first');
const office = S.pickTools({ subject: 'Jane Roe', object: 'US Senate', relation: 'HELD_OFFICE' }).map((t) => t.name);
ok(office.includes('legiscan_search'), 'a HELD_OFFICE edge routes to LegiScan');
ok(S.pickTools({ subject: 'X', relation: 'RELATED_TO' }).some((t) => t.name === 'mediawiki_search'), 'MediaWiki (Wikipedia) is always in the set — the general corroborator');
ok(S.pickTools({ subject: 'A', object: 'B', relation: 'FUNDS' }).length <= 4, 'the tool set is capped (bounded cost)');

// --- normalize (per-tool → source URLs) ------------------------------------------------------------
console.log('== normalize ==');
ok(S.normalize('mediawiki_search', { results: [{ title: 'Benjamin Harrison' }] })[0] === 'https://en.wikipedia.org/wiki/Benjamin_Harrison', 'mediawiki titles → Wikipedia URLs');
ok(S.normalize('fec_committee_search', { results: [{ committee_id: 'C00123' }] })[0].includes('/committee/C00123/'), 'FEC committee ids → fec.gov data URLs');
ok(S.normalize('gdelt_article_search', { results: [{ url: 'https://reuters.com/a' }] })[0] === 'https://reuters.com/a', 'generic tools → their result .url');

(async () => {
  console.log('== makeSearch (dispatch the tools, collect independent sources) ==');
  const calls = [];
  const dispatch = async ({ name }) => {
    calls.push(name);
    if (name === 'fec_committee_search') return { text: JSON.stringify({ results: [{ committee_id: 'C00123' }] }) };
    if (name === 'mediawiki_search') return { text: JSON.stringify({ results: [{ title: 'Acme PAC' }] }) };
    if (name === 'gdelt_article_search') return { text: JSON.stringify({ results: [{ url: 'https://apnews.com/x' }] }) };
    return { text: '{}' };
  };
  const search = S.makeSearch({ dispatch });
  const urls = await search({ subject: 'Acme PAC', object: 'Sen. Doe', relation: 'FUNDS' });
  ok(calls.includes('fec_committee_search') && calls.includes('mediawiki_search'), 'makeSearch dispatched the authoritative tools for the fact');
  ok(urls.some((u) => /fec\.gov/.test(u)) && urls.some((u) => /wikipedia/.test(u)) && urls.some((u) => /apnews/.test(u)), 'makeSearch collected sources across FEC + Wikipedia + GDELT');

  // browser fallback fires ONLY when tools return nothing
  let opened = false;
  const emptyDispatch = async () => ({ text: '{}' });
  const browser = { isConnected: () => true, dispatch: async ({ tag }) => { if (tag === 'open_page') opened = true; return { text: 'results: https://example.gov/doc' }; } };
  const search2 = S.makeSearch({ dispatch: emptyDispatch, browser });
  const u2 = await search2({ subject: 'Obscure Thing', relation: 'RELATED_TO' });
  ok(opened === true && u2.some((u) => /example\.gov/.test(u)), 'when the tools find nothing, the live browser fallback runs a web search');

  console.log('== makeFetch (browser preferred, web_extract fallback) ==');
  const br2 = { isConnected: () => true, dispatch: async ({ tag }) => (tag === 'read' ? { text: 'The rendered page body — long enough (well over the 80-character minimum-real-content guard) to be treated as genuine page content for the entailment judge to read.' } : {}) };
  const f1 = await S.makeFetch({ browser: br2 })('https://x/y');
  ok(/rendered page body/.test(f1.text), 'makeFetch reads the page via the live browser');
  const f2 = await S.makeFetch({ dispatch: async () => ({ text: JSON.stringify({ text: 'clean extracted text' }) }) })('https://x/y');
  ok(f2.text === 'clean extracted text', 'makeFetch falls back to web_extract when no browser');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
