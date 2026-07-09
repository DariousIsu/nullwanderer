/* Smoke: lib/corroboration — C2 independent-source counting + mirror/copy detection (fully offline).
 * The proof gate: Wikipedia + 3 mirrors collapses to corroboration=1; N distinct domains count as N.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_corroboration.js
 */
'use strict';
const C = require('../lib/corroboration');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- hostOf / registrableDomain ---
ok(C.hostOf('https://en.wikipedia.org/wiki/X') === 'en.wikipedia.org', 'hostOf: full url');
ok(C.hostOf('bbc.co.uk/news') === 'bbc.co.uk', 'hostOf: bare host+path');
ok(C.hostOf('') === '' && C.hostOf(null) === '', 'hostOf: junk → empty');
ok(C.registrableDomain('https://www.nytimes.com/2020/x') === 'nytimes.com', 'registrableDomain: strips www');
ok(C.registrableDomain('https://m.bbc.co.uk/news') === 'bbc.co.uk', 'registrableDomain: two-level TLD (bbc.co.uk)');
ok(C.registrableDomain('https://sub.dept.example.com/x') === 'example.com', 'registrableDomain: deep subdomain → eTLD+1');

// --- sourceFamily: mirrors collapse to one family; distinct domains stay distinct ---
ok(C.sourceFamily('https://en.wikipedia.org/wiki/A') === C.sourceFamily('https://www.wikiwand.com/en/A'), 'sourceFamily: wikipedia & wikiwand → same family');
ok(C.sourceFamily('https://dbpedia.org/page/A') === C.sourceFamily('https://de.wikipedia.org/wiki/A'), 'sourceFamily: dbpedia & localized wikipedia → same family');
ok(C.sourceFamily('https://nytimes.com/x') !== C.sourceFamily('https://washingtonpost.com/x'), 'sourceFamily: two real papers → distinct');

// --- THE PROOF: Wikipedia + 3 mirrors → corroboration 1 ---
const mirrorSet = [
  'https://en.wikipedia.org/wiki/Jane_Roe',
  'https://www.wikiwand.com/en/Jane_Roe',
  'https://dbpedia.org/page/Jane_Roe',
  'https://simple.wikipedia.org/wiki/Jane_Roe',
];
ok(C.corroborationCount(mirrorSet) === 1, 'PROOF: Wikipedia + 3 mirrors → 1 independent source (self-echo collapsed)');

// --- N genuinely independent sources count as N ---
const indepSet = [
  'https://www.nytimes.com/2020/x',
  'https://www.reuters.com/y',
  'https://apnews.com/z',
];
ok(C.corroborationCount(indepSet) === 3, 'independent: 3 distinct domains → 3');

// --- mixed: 2 wiki-mirrors + 2 distinct papers → 3 (1 wiki family + 2 papers) ---
ok(C.corroborationCount([...mirrorSet.slice(0, 2), 'https://nytimes.com/a', 'https://reuters.com/b']) === 3, 'mixed: 2 mirrors + 2 papers → 3 independent');

// --- same domain, different pages → still 1 (copy within one source) ---
ok(C.corroborationCount(['https://nytimes.com/a', 'https://www.nytimes.com/b', 'https://nytimes.com/c']) === 1, 'same-domain copies → 1');

// --- accepts {url} objects + ignores junk ---
ok(C.corroborationCount([{ url: 'https://reuters.com/x' }, { url: '' }, null, 'not a url at all ']) === 1, 'accepts {url} objects; junk ignored');
ok(C.corroborationCount([]) === 0 && C.corroborationCount(null) === 0, 'empty/null set → 0');

// --- families list is exposed + ordered deterministically ---
const r = C.independentSources(indepSet);
ok(Array.isArray(r.families) && r.families.length === 3 && r.families.join(',') === [...r.families].sort().join(','), 'independentSources: returns sorted family keys');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
