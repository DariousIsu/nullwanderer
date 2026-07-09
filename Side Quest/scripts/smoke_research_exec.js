/* Smoke: lib/research_exec — F3 real executors (offline, injected search/fetch/judge).
 * Proof: URL extraction from any result shape; the anti-collapse independence filter (mirrors → one);
 * the corroborate + verify-citation executors; and an END-TO-END run through research_lane.runResearchItem
 * driven by these executors (mock web) — a mid-band fact gains independent sources → promotes; an
 * ungrounded fact gets a fetched-and-confirmed citation → promotes; a search that finds nothing → parks.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_research_exec.js
 */
'use strict';
const X = require('../lib/research_exec');
const R = require('../lib/research_lane');
const ingest = require('../lib/ingest_lane');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- extractUrls -----------------------------------------------------------------------------------
console.log('== extractUrls (any shape) ==');
ok(X.extractUrls([{ url: 'https://a.com/1' }, { href: 'https://b.org/2' }]).length === 2, 'array of {url}/{href}');
ok(X.extractUrls({ results: [{ link: 'https://c.net/3' }] }).length === 1, '{results:[{link}]}');
ok(X.extractUrls('see https://d.io/x and https://e.gov/y').length === 2, 'raw text with URLs');
ok(X.extractUrls([{ url: 'https://a.com/1' }, { url: 'https://a.com/1' }]).length === 1, 'dedups identical URLs');

// --- independentNew (anti-collapse) ----------------------------------------------------------------
console.log('== independentNew (mirror-collapse) ==');
const wikiMirrors = ['https://en.wikipedia.org/wiki/X', 'https://www.wikiwand.com/en/X', 'https://dbpedia.org/page/X'];
ok(X.independentNew(wikiMirrors).length === 1, 'Wikipedia + 2 mirrors → ONE independent source');
ok(X.independentNew(['https://a.com/1', 'https://b.org/2'], ['https://a.com/other']).length === 1, 'filters out a source on an EXISTING registrable domain (a.com)');
ok(X.independentNew(['https://a.com/1', 'https://a.com/2', 'https://b.org/3']).length === 2, 'two URLs on the same domain collapse to one');

// --- tokenJudge ------------------------------------------------------------------------------------
console.log('== tokenJudge (entailment heuristic) ==');
ok(X.tokenJudge('Acme Corporation funds Senator Doe', 'A filing shows Acme Corporation funds Senator Doe re-election') === true, 'claim tokens present on the page → supported');
ok(X.tokenJudge('Acme funds Senator Doe', 'An unrelated article about weather in Denver') === false, 'claim absent from the page → NOT supported');

(async () => {
  console.log('== makeCorroborate ==');
  const search2 = async () => [{ url: 'https://reuters.com/a' }, { url: 'https://apnews.com/b' }];
  const corr = X.makeCorroborate({ search: search2, existing: ['https://a.com/x'] });
  const cr = await corr({ query: 'Acme PAC Sen Doe' });
  ok(cr.sources.length === 2 && cr.sources.some((s) => /reuters/.test(s)), 'corroborate: returns the independent new sources found');
  ok((await X.makeCorroborate({ search: async () => { throw new Error('ddg down'); } })({ query: 'x' })).sources.length === 0, 'corroborate: a dead search → empty (fail-soft)');

  console.log('== makeVerifyCitation ==');
  const searchC = async () => [{ url: 'https://src.org/doc' }];
  const fetchSupports = async () => ({ text: 'The document confirms Widget links to Gadget per the filing.' });
  const vc = X.makeVerifyCitation({ search: searchC, fetch: fetchSupports });
  const v1 = await vc({ claim: 'Widget links to Gadget' });
  ok(v1.verified === true && v1.citation_url === 'https://src.org/doc', 'verify-citation: a fetched page that SUPPORTS the claim → verified + url');
  const fetchNo = async () => ({ text: 'A page about something entirely different.' });
  ok((await X.makeVerifyCitation({ search: searchC, fetch: fetchNo })({ claim: 'Widget links to Gadget' })).verified === false, 'verify-citation: a fetched page that does NOT support → not verified (page must corroborate)');

  console.log('== END-TO-END: executors driving research_lane.runResearchItem ==');
  // a mid-band fact (grade B, 1 source) → corroborate finds 2 independent → crosses the bar → PROMOTE
  const midband = { name: 'Acme PAC', source_name: 'Acme PAC', target_name: 'Sen. Doe', relation: 'FUNDS', metadata: { grade: 'B', source_set: ['https://a.com/x'] } };
  const search3ind = async () => [{ url: 'https://reuters.com/a' }, { url: 'https://apnews.com/b' }, { url: 'https://bbc.co.uk/c' }];
  const e1 = await R.runResearchItem(midband, { search: X.makeCorroborate({ search: search3ind, existing: midband.metadata.source_set }) });
  ok(e1.outcome === 'promote' && ingest.threeBand(e1.proposal) === 'promote', 'END-TO-END corroboration: mid-band fact + 3 independent web sources → PROMOTE');

  const ungrounded = { name: 'Widget', source_name: 'Widget', target_name: 'Gadget', relation: 'LINKED_TO', confidence: 0.95, metadata: {} };
  // the page must support the claim AS THE LOOP GENERATES IT ("Widget linked to Gadget" from LINKED_TO)
  const fetchE2E = async () => ({ text: 'Public disclosure records confirm Widget linked to Gadget in the filing.' });
  const e2 = await R.runResearchItem(ungrounded, { verifyCitation: X.makeVerifyCitation({ search: searchC, fetch: fetchE2E }) });
  ok(e2.outcome === 'promote' && ingest.isGrounded(e2.proposal), 'END-TO-END citation: ungrounded promote-band + a confirmed fetched citation → grounded → PROMOTE');

  const e3 = await R.runResearchItem(midband, { search: X.makeCorroborate({ search: async () => [], existing: midband.metadata.source_set }) });
  ok(e3.outcome === 'park' && e3.reason === 'no-external-found', 'END-TO-END: search finds nothing → PARK (never invents corroboration)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
