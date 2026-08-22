/* Smoke: lib/legis_acquire — the directed legislative acquisition limb (2026-08-21).
 * Lucas: a direct user order's fuel is fetched NOW, never queued behind the corpus drain.
 * Pure detect + injected-I/O acquire; offline, no db, no network.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_legis_acquire.js */
'use strict';
const la = require('../lib/legis_acquire');
const fs = require('fs'); const path = require('path');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const T = 1785700000000;

(async () => {
  console.log('detect:');
  const d = la.detect('anti-China legislation state by state: Utah, Arizona, Texas, Florida, Tennessee, Louisiana, Iowa — bills, statuses, and per-state breakdown');
  ok(d.states.join(',') === 'AZ,FL,IA,LA,TN,TX,UT'.split(',').sort().join(',') || d.states.length === 7, `the seven states resolve to codes (${d.states.join(',')})`);
  ok(d.query === 'china', `the search query is the salient non-state token ("${d.query}")`);
  ok(la.detect('a report on parish rosters in Louisiana').states.length === 0, 'no legislative term → no acquisition (roster reports stay on their own path)');
  ok(la.detect('anti-China legislation trends nationwide').states.length === 0, 'no named state → no acquisition');
  ok(la.detect('legislation in Texas and New Mexico').query === '' && la.detect('legislation in Texas and New Mexico').states.length === 2,
    'states with NO searchable subject → detected states but empty query (acquire stands down)');
  ok(la.detect('foreign adversary land ownership bills in Montana').states.join(',') === 'MT', 'a single state resolves');

  console.log('acquire:');
  const fakeResults = { total_results: 3, results: [
    { bill_number: 'HB1', title: 'Foreign adversary land', last_action: 'Signed', last_action_date: '2026-01-01', url: 'https://legiscan.com/x/HB1', relevance: 100 },
    { bill_number: 'SB2', title: 'Divestment', last_action: 'Died', last_action_date: '2026-02-01', url: 'https://legiscan.com/x/SB2', relevance: 90 },
  ]};
  const landedDocs = [];
  const deps = {
    states: ['UT', 'TX'], query: 'china', now: T,
    dispatch: async (tag) => ({ ok: true, text: JSON.stringify(fakeResults) }),
    insertDocument: (doc) => { landedDocs.push(doc); return landedDocs.length; },
    findExisting: () => false,
  };
  const r1 = await la.acquire(deps);
  ok(r1.landed === 2 && landedDocs.length === 2, 'one sheet lands per state');
  ok(/LegiScan sweep — china bills: UT/.test(landedDocs[0].title), 'the sheet title names the query and state');
  ok(/HB1 — Foreign adversary land/.test(landedDocs[0].body) && /https:\/\/legiscan\.com\/x\/HB1/.test(landedDocs[0].body),
    'every row carries the bill, status, and source URL (citable)');
  ok(landedDocs[0].source === 'legislation' && /^legiscan-search:ut:china:\d{4}-\d{2}-\d{2}$/.test(landedDocs[0].ref),
    'the sheet is a legislation doc with a dated dedup ref');
  const r2 = await la.acquire({ ...deps, findExisting: () => true });
  ok(r2.landed === 0 && r2.skipped === 2, 'a sheet already held today is SKIPPED — repeated orders never spam the store');
  ok((await la.acquire({ ...deps, dispatch: async () => null })).landed === 0, 'Echo down → 0 landed, no throw (the gather proceeds on held)');
  ok((await la.acquire({ ...deps, dispatch: async () => ({ ok: true, text: JSON.stringify({ results: [] }) }) })).landed === 0,
    'an honest empty search never lands a sheet');
  ok((await la.acquire({ ...deps, dispatch: async () => { throw new Error('boom'); } })).landed === 0, 'a dispatch throw is contained per state');
  ok((await la.acquire({ ...deps, query: '' })).landed === 0, 'an empty query stands down entirely');

  console.log('wiring:');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  // P3: the compose door routes through the ACQUIRER REGISTRY now; legislation is acquirer #1
  // inside it (behavior unchanged — the P2 gate passed on it).
  ok(/acquirer_registry'\)/.test(mainSrc) && /directed acquisition/.test(mainSrc), 'buildReportFromHeld runs the directed acquisition (via the registry) before the gather');
  ok(mainSrc.indexOf("require('./lib/acquirer_registry')") < mainSrc.indexOf('const _clean = t.replace'), 'the acquisition runs BEFORE the phrase-LIKE gather');
  ok(/name: 'legislation'/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'acquirer_registry.js'), 'utf8')), 'legislation is acquirer #1 in the registry');

  console.log(`\nsmoke_legis_acquire: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
