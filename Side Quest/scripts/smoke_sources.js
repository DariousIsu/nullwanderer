/* Smoke: lib/sources — the provenance spine (Pillar 1). Proves URL extraction (clean/dedupe/junk-drop),
 * structured-record detection, per-entity collection, save_source frontmatter, run-wide dedupe, and the
 * rendered Sources section. Pure: no model/file/db/Echo. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_sources.js
 */
'use strict';
const S = require('../lib/sources');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- domainOf ---
ok(S.domainOf('https://www.heritage.org/about') === 'heritage.org', 'domainOf strips www + path');
ok(S.domainOf('http://cato.org') === 'cato.org', 'domainOf bare host');
ok(S.domainOf('not a url') === '', 'domainOf junk → ""');

// --- extractUrls: clean, dedupe, drop junk ---
const raw = `Found leadership at https://www.heritage.org/staff. See also https://heritage.org/staff/ (dupe).
Searched google.com first: https://www.google.com/search?q=x. Logo at https://cdn.heritage.org/logo.png.
Contact page: https://cato.org/people/peter-goettler.`;
const urls = S.extractUrls(raw);
const domains = urls.map(u => u.domain);
ok(domains.includes('heritage.org') && domains.includes('cato.org'), 'extractUrls finds the real sources');
ok(urls.filter(u => u.domain === 'heritage.org').length === 1, 'trailing-slash dupe collapses to one');
ok(!domains.includes('google.com'), 'search-engine URL dropped as junk');
ok(!urls.some(u => /\.png/.test(u.url)), 'image/asset URL dropped as junk');
ok(urls.every(u => !/[.,;)]$/.test(u.url)), 'trailing punctuation trimmed from URLs');

// --- structuredRefs: detect authoritative record classes in deep raw ---
const deep = '990: revenue $40M from the Form 990; affiliated PAC found via FEC; kg_search returned 3 people; USAspending shows a federal grant.';
const sr = S.structuredRefs(deep);
const labels = sr.map(x => x.label);
ok(labels.some(l => /990/.test(l)) && labels.some(l => /FEC/.test(l)) && labels.some(l => /knowledge graph/i.test(l)) && labels.some(l => /USAspending/i.test(l)), 'structuredRefs detects 990/FEC/KG/USAspending');
ok(sr.every(x => x.kind === 'structured'), 'structured refs tagged kind=structured');
ok(S.structuredRefs('nothing structured here').length === 0, 'no structured language → none');

// --- collectSources: unified, entity-tagged ---
const col = S.collectSources({ entity: 'Heritage Foundation', webRaw: 'https://heritage.org/staff', deepRaw: deep });
ok(col.length >= 5 && col.every(s => s.entity === 'Heritage Foundation'), 'collectSources tags every source with the entity');
ok(col.some(s => s.kind === 'web') && col.some(s => s.kind === 'structured'), 'collectSources merges web + structured');

// --- frontmatterFor: save_source contract ---
const fmWeb = S.frontmatterFor({ kind: 'web', url: 'https://cato.org/x', domain: 'cato.org', entity: 'Cato Institute' }, { capturedAt: '2026-06-30' });
ok(fmWeb.source === 'https://cato.org/x' && fmWeb.collection_date === '2026-06-30' && fmWeb.domain === 'cato.org', 'web frontmatter: source=url + collection_date + domain');
ok(fmWeb.entity === 'Cato Institute' && fmWeb.kind === 'web', 'web frontmatter carries entity + kind');
const fmStruct = S.frontmatterFor({ kind: 'structured', label: 'IRS Form 990 filing', entity: 'Cato' }, { capturedAt: '2026-06-30' });
ok(fmStruct.source === 'IRS Form 990 filing' && fmStruct.domain === 'structured', 'structured frontmatter: source=label, domain=structured');

// --- dedupe: run-wide, merges entities ---
const merged = S.dedupe([
  { kind: 'web', url: 'https://heritage.org/staff', domain: 'heritage.org', entity: 'Heritage Foundation' },
  { kind: 'web', url: 'https://heritage.org/staff/', domain: 'heritage.org', entity: 'CEI' },   // same URL, other org
  { kind: 'structured', label: 'FEC filings', entity: 'Heritage Foundation' },
  { kind: 'structured', label: 'FEC filings', entity: 'Cato' },
]);
ok(merged.length === 2, 'dedupe collapses same URL + same structured label to one each');
const heritageRow = merged.find(s => s.kind === 'web');
ok(/Heritage Foundation/.test(heritageRow.entity) && /CEI/.test(heritageRow.entity), 'dedupe merges the citing entities');

// --- renderSourcesSection ---
const sec = S.renderSourcesSection([
  { kind: 'web', url: 'https://cato.org/people', domain: 'cato.org', entity: 'Cato Institute' },
  { kind: 'structured', label: 'IRS Form 990 filing', entity: 'Cato Institute' },
]);
ok(/^## Sources/m.test(sec), 'render starts with "## Sources"');
ok(/1\. \[cato\.org\]\(https:\/\/cato\.org\/people\) — Cato Institute/.test(sec), 'web source rendered as a numbered markdown link with entity');
ok(/2\. IRS Form 990 filing \(structured\) — Cato Institute/.test(sec), 'structured source rendered with (structured) tag');
ok(S.renderSourcesSection([]) === '', 'empty sources → "" (no section)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
