/* Smoke: single-dispatch turn router (lib/turn_router) — one route per turn, mutually exclusive.
 * Pure logic, no DB/model. Guards the proven "who is Trump → also list 19 orgs" bug: a factual entity
 * question with a MISFIRING deliverableAggQ must route to `answer`, never `status`.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_turn_router.js
 */
'use strict';
const { computeTurnRoute, isConversational, allowsOperator } = require('../lib/turn_router');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const route = (sig) => computeTurnRoute(sig).route;

// ── THE REGRESSION GUARD: factual entity Q + misfiring deliverableAggQ + no active focus → answer ──
ok(route({ factual: true, deliverableAggQ: true, hasDirectedFocus: false }) === 'answer',
  'factual + misfiring deliverableAggQ (no focus) → answer (NOT status) — the Trump/Thune bug');
ok(route({ factual: true, deliverableAggQ: true, hasDirectedFocus: true }) === 'answer',
  'factual OUTRANKS deliverableAggQ even during an active focus (no status dump on a factual Q)');

// ── conversational / answer paths ──
ok(route({ socialTurn: true }) === 'converse', 'social turn → converse');
ok(route({}) === 'converse', 'nothing set → converse (default)');
ok(route({ factual: true }) === 'answer', 'factual → answer');
ok(route({ personalFactQ: true }) === 'answer', 'personal-fact question → answer');
ok(route({ devQ: true }) === 'answer', 'dev question → answer');
ok(route({ stateQ: true }) === 'answer', 'state question → answer');
ok(route({ isLiveInfo: true }) === 'lookup', 'live-info question → lookup');

// ── work / status paths ──
ok(route({ isAssignment: true }) === 'task', 'assignment → task');
ok(route({ isContactsQuery: true }) === 'contacts', 'contacts-query → contacts');
ok(route({ isContactsQuery: true, isAssignment: true }) === 'contacts', 'contacts-query OUTRANKS assignment (list-what-we-have, not research)');
ok(route({ socialTurn: true, isContactsQuery: true }) === 'converse', 'social still outranks a contacts-query');
ok(route({ isStatusReq: true }) === 'status', 'explicit status request → status');
ok(route({ activityQ: true }) === 'status', 'activity question ("what are you working on") → status');
ok(route({ deliverableAggQ: true, hasDirectedFocus: true, factual: false }) === 'status',
  'deliverableAggQ + active focus + NOT factual → status (legit deliverable query)');

// ── priority: control/correction/docqa win ──
ok(route({ directedStopHandled: true, factual: true }) === 'control', 'stop-handled outranks factual → control');
ok(route({ correctionHandled: true, isAssignment: true }) === 'correction', 'correction outranks assignment');
ok(route({ docQaHandled: true, factual: true }) === 'docqa', 'doc-qa outranks factual');
ok(route({ socialTurn: true, isAssignment: true }) === 'converse', 'social outranks a stray assignment flag');

// ── predicates used for the main.js gates ──
ok(isConversational('answer') && isConversational('converse') && isConversational('lookup'), 'answer/converse/lookup are conversational');
ok(!isConversational('task') && !isConversational('status'), 'task/status are NOT conversational');
ok(allowsOperator('lookup') && allowsOperator('task') && !allowsOperator('answer') && !allowsOperator('status'),
  'operator allowed on lookup/task, blocked on answer/status');

// ── single-valued: every call returns exactly one route string ──
ok(typeof computeTurnRoute({ factual: true, isAssignment: true, activityQ: true }).route === 'string',
  'always returns exactly one route (never a pile)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
