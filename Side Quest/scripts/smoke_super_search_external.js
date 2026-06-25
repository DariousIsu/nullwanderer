/**
 * Offline smoke for Super Search SLICE 3 (the external lane in studio/super_search_recipes.js):
 * web (Zoe-search primary, engine fallback, web_extract body enrichment) + academic (keyless).
 * Pure deterministic — every dependency injected, fixtures are the REAL shapes captured live
 * (2026-06-24): Zoe web_search, engine web_search (empty/no-keys), academic_search, web_extract.
 *
 * Run: node scripts/smoke_super_search_external.js
 */
const card = require('../studio/super_search_card');
const R = require('../studio/super_search_recipes');
const { validateCard, runRecipe } = card;

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- REAL fixtures ---------------------------------------------------------------------------
// Zoe's DuckDuckGo search shape: { query, results: [ { title, url, snippet } ] }
const ZOE_SEARCH = { query: 'cloud seeding snowpack', results: [
  { title: 'Cloud seeding - Wikipedia', url: 'https://en.wikipedia.org/wiki/Cloud_seeding', snippet: 'Cloud seeding is a type of weather modification...' },
  { title: 'Does cloud seeding work? - NOAA', url: 'https://www.noaa.gov/cloud-seeding', snippet: 'Studies offer mixed results on precipitation enhancement.' },
] };
// Engine web_search with no provider keys (the reason we inject Zoe's search).
const ENGINE_WEB_EMPTY = { query: 'x', results: [], providers_used: [], providers_skipped: { exa: 'no_key_or_error', brave: 'no_key_or_error' } };
// Engine web_extract: body lives in text_preview.
const WEB_EXTRACT = { url: 'https://en.wikipedia.org/wiki/Cloud_seeding', extractor: 'trafilatura', title: 'Cloud seeding - Wikipedia', text_preview: 'Cloud seeding is a type of weather modification that aims to change the amount or type of precipitation. '.repeat(20), text_chars: 65644, text_truncated: true };
// academic_search: keyless, rich. (abstract present on first, null on second.)
const ACADEMIC = { results: [
  { title: 'Implementation of a Silver Iodide Cloud-Seeding Parameterization in WRF', authors: ['Lulin Xue', 'Akihiro Hashimoto', 'Masataka Murakami', 'Roy Rasmussen'], year: 2013, venue: 'Journal of Applied Meteorology and Climatology', doi: '10.1175/jamc-d-12-0148.1', url: 'https://openalex.org/W2015399783', abstract: 'A silver iodide (AgI) cloud-seeding parameterization has been implemented...', cited_by_count: 82, is_oa: true, source: 'openalex' },
  { title: 'Assessment of Seeding Effects in Snowpack Augmentation Programs', authors: ['Warburton, J. A.', 'Young, L. G.', 'Stone, R. H.'], year: 1995, venue: 'Journal of Applied Meteorology and Climatology', doi: '10.1175/1520-0450-34.1.121', url: 'https://doi.org/10.1175/1520-0450-34.1.121', abstract: null, cited_by_count: 15, is_oa: null, source: 'crossref' },
] };

// ---- web recipe: mapping ---------------------------------------------------------------------
{
  const cards = R.webRecipe.toCards(ZOE_SEARCH.results);
  ok('web: card per result', cards.length === 2);
  ok('web: contract-valid', cards.every(c => validateCard(c).valid), JSON.stringify(cards.map(c => validateCard(c).missing)));
  ok('web: plane=external, source=web', cards.every(c => c.plane === 'external' && c.source === 'web'));
  ok('web: url carried through', cards[0].url === 'https://en.wikipedia.org/wiki/Cloud_seeding');
  ok('web: id derived from url (stable)', cards[0].id.startsWith('web:') && cards[0].id === R.webRecipe.toCards(ZOE_SEARCH.results)[0].id);
  ok('web: host in enrich', cards[0].enrich.host === 'en.wikipedia.org');
  ok('web: cite carries url', /en\.wikipedia\.org/.test(cards[0].cite));
  ok('web: positional score (hit1 > hit2)', cards[0].score > cards[1].score);
}

// ---- academic recipe: mapping ----------------------------------------------------------------
{
  const cards = R.academicRecipe.toCards(ACADEMIC.results);
  ok('academic: contract-valid', cards.every(c => validateCard(c).valid));
  ok('academic: plane=external, source=academic', cards.every(c => c.plane === 'external' && c.source === 'academic'));
  ok('academic: id from doi (stable)', cards[0].id === R.academicRecipe.toCards(ACADEMIC.results)[0].id && cards[0].id.startsWith('academic:'));
  ok('academic: snippet from abstract', /silver iodide/i.test(cards[0].snippet));
  ok('academic: >2 authors → "et al." byline', cards[0].enrich.authors === 'Lulin Xue et al.');
  ok('academic: null abstract → composed snippet (byline/venue/year)', cards[1].abstract === undefined && /Journal of Applied Meteorology/.test(cards[1].snippet) && /1995/.test(cards[1].snippet));
  ok('academic: doi → url when url present uses url', cards[0].url === 'https://openalex.org/W2015399783');
  ok('academic: cited_by + open_access + provider in enrich', cards[0].enrich.cited_by === 82 && cards[0].enrich.open_access === true && cards[0].enrich.provider === 'openalex');
  ok('academic: cite has byline+year+venue+doi', /Lulin Xue et al\./.test(cards[0].cite) && /\(2013\)/.test(cards[0].cite) && /doi:/.test(cards[0].cite));
}

// ---- async: run wiring, Zoe-primary/engine-fallback, web_extract enrichment, gates -----------
(async () => {
  // web run uses injected Zoe search as PRIMARY (engine web_search never called).
  let engineCalled = false;
  const zoeDeps = { search: async (q) => ZOE_SEARCH, callTool: async (t) => { if (t === 'web_search') engineCalled = true; return ENGINE_WEB_EMPTY; } };
  const w = await runRecipe(R.webRecipe, { query: 'cloud seeding', plan: null, deps: zoeDeps });
  ok('web run prefers injected Zoe search', w.cards.length === 2 && engineCalled === false);

  // No injected search → falls back to engine web_search (which is empty without keys).
  const engineOnly = await runRecipe(R.webRecipe, { query: 'x', plan: null, deps: { callTool: async (t, a) => ENGINE_WEB_EMPTY } });
  ok('web run falls back to engine web_search (empty without keys)', engineOnly.error === null && engineOnly.cards.length === 0);

  // web_extract body enrichment on the top hits (engine path: text_preview).
  const enrichDeps = { search: async () => ZOE_SEARCH, callTool: async (t, a) => (t === 'web_extract' ? WEB_EXTRACT : ENGINE_WEB_EMPTY) };
  const we = await runRecipe(R.webRecipe, { query: 'cloud seeding', plan: null, deps: enrichDeps });
  ok('web enrich pulls body from web_extract text_preview', we.cards[0].enrich.fetched === true && /weather modification/.test(we.cards[0].enrich.body));
  ok('web enrich body is bounded (<=1200 chars)', we.cards[0].enrich.body.length <= 1200);

  // web enrich prefers injected fetchPage when present (Zoe's own fetcher → {text}).
  const fpDeps = { search: async () => ZOE_SEARCH, fetchPage: async (url) => ({ ok: true, url, title: 't', text: 'FETCHPAGE BODY about seeding' }), callTool: async () => { throw new Error('should not call web_extract'); } };
  const wfp = await runRecipe(R.webRecipe, { query: 'x', plan: null, deps: fpDeps });
  ok('web enrich uses injected fetchPage over web_extract', /FETCHPAGE BODY/.test(wfp.cards[0].enrich.body));

  // web enrich fail-safe: fetch throws → card kept, just not deepened.
  const badFetch = { search: async () => ZOE_SEARCH, callTool: async (t) => { if (t === 'web_extract') throw new Error('fetch down'); return ENGINE_WEB_EMPTY; } };
  const wbad = await runRecipe(R.webRecipe, { query: 'x', plan: null, deps: badFetch });
  ok('web enrich fail-safe (cards survive a fetch error)', wbad.error === null && wbad.cards.length === 2 && !wbad.cards[0].enrich.fetched);

  // academic run wiring.
  const a = await runRecipe(R.academicRecipe, { query: 'cloud seeding', plan: null, deps: { callTool: async (t, args) => { ok('academic forwards query+top_k', t === 'academic_search' && args.query === 'cloud seeding'); return ACADEMIC; } } });
  ok('academic run returns mapped cards', a.cards.length === 2 && a.error === null);

  // external_targets gating.
  const webOff = await runRecipe(R.webRecipe, { query: 'x', plan: { external_targets: ['academic'] }, deps: zoeDeps });
  ok('web skipped when not in external_targets', webOff.skipped === true);
  const webOn = await runRecipe(R.webRecipe, { query: 'x', plan: { external_targets: ['web'] }, deps: zoeDeps });
  ok('web runs when in external_targets', webOn.cards.length === 2);

  // ---- registry now spans both lanes ----------------------------------------------------------
  const reg = R.buildRegistry();
  ok('buildRegistry has all 8 recipes (knowledge+5 internal+2 external)', Object.keys(reg).length === 8 && reg.web && reg.academic);
  ok('EXTERNAL recipes are plane=external', R.EXTERNAL.every(r => r.plane === 'external'));
  ok('two lanes represented', R.recipes().some(r => r.plane === 'internal') && R.recipes().some(r => r.plane === 'external'));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
