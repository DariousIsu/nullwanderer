/* Smoke: lib/identity_gate — F1 identity trust (offline, pure).
 * THE ACID TEST: the "Tracy the finance lady" scenario — a weak person reference must bind to the real
 * contact via context (or hold), and must NEVER mint a durable node that then attracts every bare "Tracy".
 * Plus: reference-strength classification, contextual match (unique/ambiguous/role), the mint gate for all
 * resolver states, and the attractor guard.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_identity_gate.js
 */
'use strict';
const G = require('../lib/identity_gate');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- 1. referenceStrength ---------------------------------------------------------------------------
console.log('== referenceStrength ==');
ok(G.referenceStrength('Tracy Bromley', 'person') === 'strong', 'a full name is STRONG (may mint)');
ok(G.referenceStrength('Tracy the finance lady', 'person') === 'weak-descriptor', 'first name + descriptor is WEAK-descriptor');
ok(G.referenceStrength('Tracy', 'person') === 'weak-first', 'a bare first name is WEAK-first');
ok(G.referenceStrength('the finance lady', 'person') === 'weak-generic', 'a pure descriptor (no name) is WEAK-generic');
ok(G.referenceStrength('Tracy Bromley [wd:Q123]', 'person') === 'strong', 'a strong-id marker → STRONG regardless of shape');
ok(G.referenceStrength('Acme Corporation', 'organization') === 'strong-nonperson', 'a non-person type is not person-reluctance-gated');
ok(G.referenceStrength("O'Neil-Vance", 'person') === 'weak-first', 'a single (hyphen/apostrophe) surname alone is still weak');
ok(G.referenceStrength('Mary Jane Watson', 'person') === 'strong', 'a 3-token full name is STRONG');
ok(G.isWeak('weak-first') && G.isWeak('weak-descriptor') && !G.isWeak('strong'), 'isWeak() classifies the weak tiers');

// --- 2. contextualMatch -----------------------------------------------------------------------------
console.log('== contextualMatch ==');
const room = [
  { name: 'Tracy Bromley', title: 'Finance Director', type: 'contact' },
  { name: 'Mark Chen', title: 'Staff Engineer', type: 'contact' },
];
ok(G.contextualMatch('Tracy the finance lady', room).match === 'Tracy Bromley', 'descriptor "Tracy the finance lady" → Tracy Bromley (first-name + role)');
ok(G.contextualMatch('Tracy', room).match === 'Tracy Bromley', 'bare "Tracy" → the only Tracy in the room');
ok(G.contextualMatch('Dave', room).match === null && G.contextualMatch('Dave', room).ambiguous === false, 'a first name not in the room → no match (not ambiguous)');
const twoTracys = [...room, { name: 'Tracy Nguyen', title: 'Legal Counsel', type: 'contact' }];
const amb = G.contextualMatch('Tracy', twoTracys);
ok(amb.match === null && amb.ambiguous === true && amb.candidates.length === 2, 'two Tracys, no role hint → AMBIGUOUS (bias-to-clarify, never guess)');
// doc/meeting reality: the context set also contains the weak mention itself + other weak refs — those
// must be excluded so "Tracy" binds to the full-name "Tracy Bromley", not to a sibling weak node.
const mixedCtx = ['Tracy', 'Tracy the finance lady', { name: 'Tracy Bromley', title: 'Finance Director' }];
ok(G.contextualMatch('Tracy', mixedCtx).match === 'Tracy Bromley', 'weak siblings + self are excluded; the bare "Tracy" binds to the full-name Tracy Bromley');
ok(G.contextualMatch('Tracy', ['Tracy', 'Tracy the intern']).match === null, 'a context of ONLY weak refs offers no bind target (nothing to attract to)');
ok(G.contextualMatch('Tracy the finance lady', twoTracys).match === 'Tracy Bromley', 'the role hint disambiguates the two Tracys → Bromley (finance)');
ok(G.contextualMatch('Tracy the counsel', twoTracys).match === 'Tracy Nguyen', 'a different role hint (counsel) → Nguyen (Legal Counsel) — role narrows within the same first name');

// --- 3. mintDecision (the gate) ---------------------------------------------------------------------
console.log('== mintDecision ==');
ok(G.mintDecision('resolved', 'Tracy Bromley', 'person').action === 'reuse', 'resolved → reuse');
ok(G.mintDecision('ambiguous', 'John Smith', 'person').action === 'hold', 'ambiguous → hold');
ok(G.mintDecision('nil', 'Tracy Bromley', 'person', { context: [] }).action === 'mint', 'nil + STRONG full name → MINT (durable entity allowed)');
ok(G.mintDecision('nil', 'Acme Corp LLC', 'organization', {}).action === 'mint', 'nil + non-person → MINT (orgs keep their own path)');

console.log('== THE TRACY ACID TEST ==');
const d1 = G.mintDecision('nil', 'Tracy the finance lady', 'person', { context: room });
ok(d1.action === 'bind-context' && d1.canonical === 'Tracy Bromley', 'THE FIX: "Tracy the finance lady" BINDS to Tracy Bromley — does NOT mint a new object');
ok(d1.action !== 'mint', 'THE FIX: the weak descriptor NEVER mints a durable node (no attractor is created)');
const d2 = G.mintDecision('nil', 'Tracy', 'person', { context: room });
ok(d2.action === 'bind-context' && d2.canonical === 'Tracy Bromley', 'a later bare "Tracy" also binds to the real contact, not a spurious node');
const d3 = G.mintDecision('nil', 'Tracy', 'person', { context: [] });
ok(d3.action === 'hold' && d3.provisional === true, 'a bare "Tracy" with NO context is HELD provisional — never minted (so no attractor can ever form)');
const d4 = G.mintDecision('nil', 'Tracy', 'person', { context: twoTracys });
ok(d4.action === 'hold' && d4.reason === 'weak-ref-context-ambiguous', 'a bare "Tracy" with TWO Tracys present → hold (ambiguous), still no mint');

// --- 4. attractor guard -----------------------------------------------------------------------------
console.log('== attractor guard ==');
const cands = [
  { name: 'Tracy Bromley', type: 'person', confirmed: true },
  { name: 'Tracy', type: 'person', provisional: true },        // the bad spurious node, if one ever existed
  { name: 'Tracy the finance lady', type: 'person' },           // weak-by-name → provisional
];
const kept = G.filterAttractors(cands);
ok(kept.length === 1 && kept[0].name === 'Tracy Bromley', 'filterAttractors: only the CONFIRMED full-name node survives as a bind target');
ok(G.isProvisional({ name: 'Tracy', type: 'person' }) === true, 'a weak-by-name node is treated as provisional (never a target)');
ok(G.isProvisional({ name: 'Tracy Bromley', type: 'person', confirmed: true }) === false, 'a confirmed full-name node is a valid target');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
