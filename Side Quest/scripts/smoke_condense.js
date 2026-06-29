/* Smoke: lib/condense — the Consolidate (condense) + Iterate (expand) logic for a research run.
 * Pure functions, no model/file/db. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_condense.js
 */
'use strict';
const cd = require('../lib/condense');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- CONDENSE prompt: grounded, dedup, uniform schema ---
const cp = cd.buildCondensePrompt({ goal: 'study every right-of-center think tank', raw: '## Heritage\nfree market\n## Heritage\nfree market again' });
ok(cp.length === 2 && cp[0].role === 'system' && cp[1].role === 'user', 'condense prompt is system+user');
ok(/DEDUPE/i.test(cp[0].content) && /never add|Ground EVERY line/i.test(cp[0].content), 'condense system forbids invention + demands dedup');
ok(/Gaps/i.test(cp[0].content), 'condense asks for a Gaps list (feeds the next expand pass)');
ok(cp[1].content.includes('study every right-of-center') && cp[1].content.includes('Heritage'), 'condense user carries the goal + the raw notes');

// --- MERGE prompt for map-reduce ---
const mp = cd.buildMergePrompt({ goal: 'g', parts: ['## A\nx', '## B\ny'] });
ok(/MERGE/i.test(mp[0].content) && mp[1].content.includes('## A') && mp[1].content.includes('## B'), 'merge prompt combines partial dossiers');

// --- chunker: small stays whole, big splits on org boundaries, never loses content ---
ok(cd.chunkForCondense('short note', 1000).length === 1, 'small raw → single chunk');
ok(cd.chunkForCondense('', 1000).length === 0, 'empty raw → no chunks');
const big = Array.from({ length: 40 }, (_, i) => `## Org${i}\n${'detail '.repeat(60)}`).join('\n');
const chunks = cd.chunkForCondense(big, 2000);
ok(chunks.length > 1, 'large raw → multiple chunks (map-reduce)');
ok(chunks.every(c => c.length <= 2400), 'each chunk is within the size bound (small slack)');
ok(chunks.join('').replace(/\n/g, '').length >= big.replace(/\n/g, '').length - 5, 'chunking loses no content');
ok(/^##\s+Org0/.test(chunks[0]), 'first chunk starts at an org boundary (orgs not split mid-section)');

// --- EXPAND detection: fires on deepen verbs, extracts the target ---
ok(cd.detectExpandOrder('expand the energy think tanks').isExpand === true, '"expand the …" → expand order');
ok(cd.detectExpandOrder('go deeper on R Street\'s staff').isExpand === true, '"go deeper on …" → expand order');
ok(cd.detectExpandOrder('flesh out the contacts for the AI ones').isExpand === true, '"flesh out …" → expand order');
ok(cd.detectExpandOrder('expand the energy think tanks').target === 'energy think tanks', 'target extracted after "expand the"');
ok(cd.detectExpandOrder('go deeper on R Street staff').target === 'R Street staff', 'target extracted after "go deeper on"');
// negatives — must NOT mistake a normal task or chatter for an expand
ok(cd.detectExpandOrder('research every right-of-center think tank').isExpand === false, 'a fresh research task is NOT an expand order');
ok(cd.detectExpandOrder('what is the date today').isExpand === false, 'a plain question is NOT an expand order');
ok(cd.detectExpandOrder('how are you').isExpand === false, 'small talk is NOT an expand order');

// --- EXPAND goal seeding: scoped, names in-scope orgs from the dossier, demands depth ---
const dossier = '# dossier\n## Heritage Foundation\n...\n## R Street Institute\n...\n## Cato Institute\n...';
const eg = cd.buildExpandGoal({ priorGoal: 'study every right-of-center think tank', target: 'energy', dossier });
ok(/energy/i.test(eg), 'expand goal carries the target focus');
ok(/Heritage Foundation/.test(eg) && /R Street Institute/.test(eg), 'expand goal pulls in-scope orgs from the prior dossier');
ok(/staff|leadership|contact/i.test(eg) && /ADD depth|go FURTHER|further/i.test(eg), 'expand goal demands the depth (staff/contacts) the first pass lacked');
ok(eg.length <= 800, 'expand goal stays within the focus-content cap');
// expand goal must itself read as a directed task so the driver picks it up
ok(require('../lib/operator').isDirectedTask(eg), 'the seeded expand goal IS recognized as a directed task');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
