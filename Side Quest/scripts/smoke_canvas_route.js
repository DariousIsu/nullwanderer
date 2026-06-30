/* Smoke: lib/canvas_route — chat / canvas / ask routing for deliverable answers.
 * Pure. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_canvas_route.js
 */
'use strict';
const cr = require('../lib/canvas_route');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const route = (text, kind) => cr.routeDeliverable({ text, kind }).target;

// --- short/specific answers stay in chat ---
ok(route('how many AI safety orgs?', 'count') === 'chat', 'count → chat');
ok(route('what do you have on MIRI?', 'sample') === 'chat', 'sample → chat');
ok(route("how's the research going?", 'status') === 'chat', 'status → chat');
ok(route('can you find the think tank research?', 'find') === 'chat', 'find → chat (locate/confirm in chat)');
ok(route('what 5 do we have the most info on?', 'rank') === 'chat', 'rank → chat (short ranked answer)');

// --- big enumerations with no medium → ASK ---
ok(route("what's the full list?", 'list') === 'ask', 'list (no medium) → ask');
ok(route('who leads each of them?', 'facet') === 'ask', 'facet (no medium) → ask');

// --- explicit medium is honored, overrides kind ---
ok(route('give me the list on the canvas', 'list') === 'canvas', 'explicit "on the canvas" → canvas');
ok(route('show me on the board who leads each', 'facet') === 'canvas', 'explicit "on the board" → canvas');
ok(route('just tell me the list right here', 'list') === 'chat', 'explicit "right here" → chat (overrides list→ask)');
ok(route('put the count on the canvas', 'count') === 'canvas', 'explicit canvas overrides count→chat');

// --- complete-work requests → canvas regardless of kind ---
ok(route('give me the full dossier', 'list') === 'canvas', '"full dossier" → canvas');
ok(route('write it up for me', 'sample') === 'canvas', '"write it up" → canvas (overrides sample→chat)');
ok(route('everything you have on these orgs', 'list') === 'canvas', '"everything you have" → canvas');

// --- precedence: explicit chat beats complete-work ---
ok(route('just tell me the full report here', 'list') === 'chat', 'explicit-chat beats complete-work');

// --- fail-safe ---
ok(cr.routeDeliverable({}).target === 'chat', 'empty input → chat (default, safe)');
ok(cr.routeDeliverable({ text: 'anything', kind: null }).target === 'chat', 'unclassified → chat default');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
