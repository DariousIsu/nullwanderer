/* scripts/smoke_puller_variants.js — offline checks for nickname + subdomain variant expansion.
 * Run: node scripts/smoke_puller_variants.js  (pure, no db) */
'use strict';
const V = require('../studio/puller_variants');
const B = require('../studio/puller_beliefs');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

// ---- nicknames (bidirectional) ----
ok('robert → bob/rob', V.nicknamesOf('Robert').includes('bob') && V.nicknamesOf('robert').includes('rob'));
ok('bob → robert (reverse)', V.nicknamesOf('bob').includes('robert'));
ok('elizabeth → liz/beth', V.nicknamesOf('Elizabeth').includes('liz') && V.nicknamesOf('elizabeth').includes('beth'));
ok('unknown name → []', V.nicknamesOf('Zebediah').length === 0);
ok('nicknamesOf excludes self', !V.nicknamesOf('bob').includes('bob'));

// ---- name variants ----
const nv = V.nameVariants('Robert Smith');
ok('nameVariants keeps original first', nv[0] === 'Robert Smith');
ok('nameVariants adds bob/rob forms', nv.some(n => n.toLowerCase() === 'bob smith') && nv.some(n => n.toLowerCase() === 'rob smith'));
ok('nameVariants of plain name → just itself', V.nameVariants('Zebediah Jones').length === 1);

// ---- domain variants ----
ok('ibm.com → redhat.com + us.ibm.com', V.domainVariants('ibm.com').includes('redhat.com') && V.domainVariants('ibm.com').includes('us.ibm.com'));
ok('domainVariants base-first', V.domainVariants('ibm.com')[0] === 'ibm.com');
ok('unknown domain → just itself', V.domainVariants('acme.com').length === 1 && V.domainVariants('acme.com')[0] === 'acme.com');

// ---- variantCandidates ----
const st = B.emptyState();
const cands = V.variantCandidates(st, 'Robert Smith', 'acme.com', []);
ok('includes base first.last', cands.some(c => c.email === 'robert.smith@acme.com' && !c.isVariant));
ok('includes nickname variant', cands.some(c => c.email === 'bob.smith@acme.com' && c.isVariant));
const candsT = V.variantCandidates(st, 'Robert Smith', 'acme.com', ['robert.smith@acme.com']);
ok('excludes tried email', !candsT.some(c => c.email === 'robert.smith@acme.com'));
ok('de-dupes by email', new Set(cands.map(c => c.email)).size === cands.length);
// subdomain variant surfaces for a known parent
const ibm = V.variantCandidates(st, 'Robert Smith', 'ibm.com', []);
ok('subdomain variant present (redhat.com)', ibm.some(c => c.domain === 'redhat.com' && c.isVariant));

console.log(`\nsmoke_puller_variants: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
