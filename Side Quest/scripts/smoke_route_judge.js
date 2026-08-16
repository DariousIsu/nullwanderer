'use strict';
/* smoke_route_judge.js — the turn-router's MODEL TIER (2026-08-16, Lucas: "regex has a high fail rate").
 * The real route pick is the model's (proven live in the drill log); here we lock the deterministic
 * scaffolding with an INJECTED classify (no network): the one-word reply parses to a route, is validated
 * against the candidate menu, and FAILS OPEN (→ null → the router keeps its cheap decision) on anything bad.
 * Run: node scripts/smoke_route_judge.js */
const J = require('../lib/route_judge');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

console.log('parseRoute — one-word reply → route, validated against candidates:');
ok(J.parseRoute('LOOKUP') === 'lookup', '"LOOKUP" → lookup');
ok(J.parseRoute('  status ') === 'status', 'lowercase + whitespace → status');
ok(J.parseRoute('The best fit is TASK.') === 'task', 'a sentence containing TASK → task');
ok(J.parseRoute('ANSWER') === 'answer' && J.parseRoute('CONTACTS') === 'contacts' && J.parseRoute('CONVERSE') === 'converse', 'the rest of the menu parses');
ok(J.parseRoute('LOOKUP', ['status', 'lookup']) === 'lookup', 'in-candidate answer is kept');
ok(J.parseRoute('CONTACTS', ['status', 'lookup']) === null, 'OUT-of-candidate answer → null (the router keeps cheap)');
ok(J.parseRoute('') === null && J.parseRoute('banana') === null && J.parseRoute(null) === null, 'empty / garbage / null → null');

console.log('\nclassifyRoute — gating + injected classify (no network):');
(async () => {
  ok(await J.classifyRoute('', { classify: () => 'lookup' }) === null, 'empty text → null (never calls the model)');
  ok(await J.classifyRoute("what's the bill's status?", { candidates: ['status', 'lookup'], classify: () => 'lookup' }) === 'lookup',
    'injected classify → its route (lookup)');
  ok(await J.classifyRoute('x', { candidates: ['status', 'lookup'], classify: () => 'task' }) === 'task',
    'injected classify is trusted as-is (validation vs candidates is the router\'s job via resolveTurnRoute)');
  ok(await J.classifyRoute('x', { classify: () => { throw new Error('down'); } }) === null, 'classify THROWS → null (FAIL-OPEN)');
  ok(await J.classifyRoute('x', { classify: async () => 'status' }) === 'status', 'async classify is awaited');
  ok(await J.classifyRoute('x', { classify: () => null }) === null, 'classify returns null → null');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
