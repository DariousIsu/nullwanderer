/* Smoke: single-dispatch turn router (lib/turn_router) — one route per turn, mutually exclusive.
 * Pure logic, no DB/model. Guards the proven "who is Trump → also list 19 orgs" bug: a factual entity
 * question with a MISFIRING deliverableAggQ must route to a FACTUAL lane (lookup), never `status`.
 * 2026-08-12: EXTERNAL factual → `lookup` (ground from the verified DB + search the gaps), never
 * answer-from-memory/training — the [[db-is-foundation-no-recall-only]] principle. Only INTERNAL/self
 * facts (personalFactQ / devQ / stateQ) stay on `answer`.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_turn_router.js
 */
'use strict';
const { computeTurnRoute, resolveTurnRoute, routeConflict, isConversational, allowsOperator, lookupWantsOperator } = require('../lib/turn_router');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const route = (sig) => computeTurnRoute(sig).route;

// ── THE REGRESSION GUARD: factual entity Q + misfiring deliverableAggQ → a FACTUAL lane, never status ──
ok(route({ factual: true, deliverableAggQ: true, hasDirectedFocus: false }) === 'lookup',
  'factual + misfiring deliverableAggQ (no focus) → lookup (NOT status) — the Trump/Thune bug');
ok(route({ factual: true, deliverableAggQ: true, hasDirectedFocus: true }) === 'lookup',
  'factual OUTRANKS deliverableAggQ even during an active focus (no status dump on a factual Q)');

// ── conversational / answer paths ──
ok(route({ socialTurn: true }) === 'converse', 'social turn → converse');
ok(route({}) === 'converse', 'nothing set → converse (default)');
ok(route({ factual: true }) === 'lookup', 'EXTERNAL factual → lookup (ground from DB + search; never answer-from-memory/training)');
ok(route({ personalFactQ: true }) === 'answer', 'personal-fact (shared history — internal) question → answer');
ok(route({ devQ: true }) === 'answer', 'dev (self-code — internal) question → answer');
ok(route({ stateQ: true }) === 'answer', 'state (program-state — internal) question → answer');
ok(route({ isLiveInfo: true }) === 'lookup', 'live-info question → lookup');
// factual OUTRANKS the self-fact bucket: an external fact never gets diverted to answer-from-memory.
ok(route({ factual: true, personalFactQ: true }) === 'lookup', 'factual+personalFactQ → lookup (external wins; ground+search)');

// ── work / status paths ──
ok(route({ isAssignment: true }) === 'task', 'assignment → task');
ok(route({ isContactsQuery: true }) === 'contacts', 'contacts-query → contacts');
ok(route({ isContactsQuery: true, isAssignment: true }) === 'task',
  'contacts-query YIELDS to a genuine exec/task imperative ("write a python script that counts contacts …") → task (D-contacts, 2026-08-16)');
ok(route({ isContactsQuery: true, isAssignment: false }) === 'contacts',
  'a pure contacts-list ask (no exec/task verb) still → contacts (list-what-we-hold path unchanged)');
ok(route({ socialTurn: true, isContactsQuery: true }) === 'converse', 'social still outranks a contacts-query');
ok(route({ isStatusReq: true }) === 'status', 'explicit status request → status');
ok(route({ activityQ: true }) === 'status', 'activity question ("what are you working on") → status');
ok(route({ deliverableAggQ: true, hasDirectedFocus: true, factual: false }) === 'status',
  'deliverableAggQ + active focus + NOT factual → status (legit deliverable query)');

// ── D-route (2026-08-16 drill): a genuine ASSIGNMENT beats the WEAK deliverable-status tier ──
// "write a python script … run it … paste the output" is aggregate-SHAPED but it is an ORDER, not a
// "how's it going?" — it routed status → the operator never fired → she narrated "I'm on it" (T6/T8).
ok(route({ deliverableAggQ: true, hasDirectedFocus: true, factual: false, isAssignment: true }) === 'task',
  'deliverableAggQ + focus + isAssignment → task (exec order beats the weak status tier — the T6/T8 mis-route)');
ok(route({ deliverableAggQ: true, hasDirectedFocus: true, isStatusReq: true, isAssignment: true }) === 'status',
  'STRONG status tier (isStatusReq) still wins even if the assignment flag also trips');
ok(route({ deliverableAggQ: true, hasDirectedFocus: true, activityQ: true, isAssignment: true }) === 'status',
  'STRONG status tier (activityQ) still wins over a stray assignment flag');

// ── priority: control/correction/docqa win ──
ok(route({ directedStopHandled: true, factual: true }) === 'control', 'stop-handled outranks factual → control');
ok(route({ correctionHandled: true, isAssignment: true }) === 'correction', 'correction outranks assignment');
ok(route({ docQaHandled: true, factual: true }) === 'docqa', 'doc-qa outranks factual');
ok(route({ socialTurn: true, isAssignment: true }) === 'converse', 'social outranks a stray assignment flag');

// ── lookupWantsOperator: a lookup decision is SUFFICIENT to fire ground+search (the needsExternal gap) ──
// The live bug: "who painted the Mona Lisa" / "what is the boiling point of water" routed to lookup but the
// narrower needsExternal regex missed the phrasing → operator never fired → answer FROM TRAINING. The route
// must be sufficient. Carve-outs: awareness-held date/time, and personal/shared-history (memory is source).
ok(lookupWantsOperator({ route: 'lookup', scope: 'general', isDateTimeSelf: false }) === true,
  'lookup + external general ("who painted X") → FIRE operator (was silently answered from training)');
ok(lookupWantsOperator({ route: 'lookup', scope: 'current', isDateTimeSelf: false }) === true,
  'lookup + current ("who is the president now") → FIRE operator');
ok(lookupWantsOperator({ route: 'lookup', scope: 'general', isDateTimeSelf: true }) === false,
  'lookup + date/time self → do NOT fire (awareness block holds it; no pointless web stall)');
ok(lookupWantsOperator({ route: 'lookup', scope: 'personal', isDateTimeSelf: false }) === false,
  'lookup + personal/shared-history → do NOT fire (verified self/personal store is the source, not the web)');
ok(lookupWantsOperator({ route: 'answer', scope: 'general', isDateTimeSelf: false }) === false,
  'non-lookup route → never fires via this predicate (answer/converse stay local)');
ok(lookupWantsOperator({ route: 'converse' }) === false && lookupWantsOperator({}) === false,
  'converse / empty → false (fail-safe default)');

// ── predicates used for the main.js gates ──
ok(isConversational('answer') && isConversational('converse') && isConversational('lookup'), 'answer/converse/lookup are conversational');
ok(!isConversational('task') && !isConversational('status') && !isConversational('control') && !isConversational('contacts'),
  'task/status/control/contacts are NOT conversational (the D-email inbox-suppression set)');
ok(allowsOperator('lookup') && allowsOperator('task') && !allowsOperator('answer') && !allowsOperator('status'),
  'operator allowed on lookup/task, blocked on answer/status');

// ── single-valued: every call returns exactly one route string ──
ok(typeof computeTurnRoute({ factual: true, isAssignment: true, activityQ: true }).route === 'string',
  'always returns exactly one route (never a pile)');

// ── TIER 2: conflict detection + model escalation (2026-08-16, Lucas: "regex has a high fail rate") ──
const conflict = (sig) => routeConflict(sig).ambiguous;
ok(conflict({ isStatusReq: true, factual: true }) === true, 'THE bug: isStatusReq + factual → CONFLICT (status vs lookup)');
ok(conflict({ isAssignment: true, factual: true }) === true, 'isAssignment + factual → CONFLICT (task vs lookup)');
ok(conflict({ factual: true, personalFactQ: true }) === true, 'factual + personalFactQ → CONFLICT (lookup vs answer)');
ok(conflict({ factual: true }) === false, 'a single clear signal → NO conflict (fast-path, no model call)');
ok(conflict({ factual: true, isLiveInfo: true }) === false, 'two signals implying the SAME route (both lookup) → NO conflict');
ok(conflict({ socialTurn: true, factual: true, isStatusReq: true }) === false, 'a social turn is authoritative → NO escalation');
ok(conflict({ docQaHandled: true, factual: true, isAssignment: true }) === false, 'a pre-handled docqa turn → NO escalation');

(async () => {
  const resolve = (sig, opts) => resolveTurnRoute(sig, opts);
  ok((await resolve({ isStatusReq: true, factual: true }, {})).route === 'status',
    'no classifier → cheap cascade decision stands (status by precedence)');
  ok((await resolve({ isStatusReq: true, factual: true }, { escalate: false, classify: () => 'lookup' })).route === 'status',
    'escalate:false → model NOT consulted, cheap decision stands');
  {
    let called = 0;
    const r = await resolve({ isStatusReq: true, factual: true }, { text: 'x', classify: () => { called++; return 'lookup'; } });
    ok(r.route === 'lookup' && /model-arbitrated/.test(r.reason) && called === 1,
      'CONFLICT → model picks lookup → route CORRECTED to lookup (was status)');
  }
  {
    let called = 0;
    const r = await resolve({ factual: true }, { text: 'x', classify: () => { called++; return 'status'; } });
    ok(r.route === 'lookup' && called === 0, 'NO conflict → classifier NEVER called; cheap lookup stands (cost bounded)');
  }
  ok((await resolve({ isStatusReq: true, factual: true }, { text: 'x', classify: () => 'contacts' })).route === 'status',
    'model returns a NON-candidate route → fail-open to cheap (status)');
  ok((await resolve({ isStatusReq: true, factual: true }, { text: 'x', classify: () => null })).route === 'status',
    'model returns null → fail-open to cheap');
  ok((await resolve({ isStatusReq: true, factual: true }, { text: 'x', classify: () => { throw new Error('down'); } })).route === 'status',
    'model throws → fail-open to cheap');
  {
    const r = await resolve({ isStatusReq: true, factual: true }, { text: 'x', classify: () => 'status' });
    ok(r.route === 'status' && /model-confirmed/.test(r.reason), 'model confirms the cheap route → kept (confirmed)');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
