/* Smoke: lib/identity_dedup — the retrospective contextual identity-dedup SWEEP (F4.3).
 * Proof: the sweep finds a pre-F1 fragment ("Tracy" bound nowhere) and proposes merging it into the strong
 * canonical ("Tracy Bromley") when the match is unique + low-degree; a HIGH-degree attractor with the same
 * unique canonical is FLAGGED for split (not merged — its edges likely span multiple people); an AMBIGUOUS
 * first name (two same-first-name canonicals) is flagged for operator disambiguation; strong/full-name and
 * non-person nodes are never candidates; and a weak node can never bind to another weak node.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_identity_dedup.js
 */
'use strict';
const D = require('../lib/identity_dedup');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

console.log('== the Tracy fix, retrospective: a low-degree fragment merges into its canonical ==');
const pop = [
  { id: 1, name: 'Tracy Bromley', type: 'person', title: 'Finance Director', degree: 12 },  // the real, strong canonical
  { id: 2, name: 'Tracy', type: 'person', degree: 2 },                                        // a bare-first-name fragment
  { id: 3, name: 'Acme Corp', type: 'organization', degree: 40 },                             // non-person — never a candidate
];
const r = D.sweep(pop);
ok(r.merges.length === 1, 'exactly one merge proposed');
ok(r.merges[0].fromId === 2 && r.merges[0].intoId === 1, 'the bare "Tracy" fragment → merged INTO "Tracy Bromley"');
ok(r.merges[0].confidence >= 0.55 && r.merges[0].confidence < 1, 'merge confidence is a bounded proposal, never 1.0 (name coincidence stays possible)');
ok(r.candidates === 1, 'only the weak node counted as a candidate (org + strong canonical excluded)');

console.log('== role hint sharpens the bind ==');
const roled = D.sweep([
  { id: 1, name: 'Tracy Bromley', type: 'person', title: 'Head of Finance', degree: 5 },
  { id: 2, name: 'Tracy Nguyen', type: 'person', title: 'Sales Lead', degree: 5 },
  { id: 3, name: 'Tracy the finance lady', type: 'person', degree: 1 },
]);
ok(roled.merges.length === 1 && roled.merges[0].intoId === 1, 'the finance descriptor routes "Tracy" to the finance Tracy, not the sales Tracy');
ok(roled.merges[0].via === 'first-name+role' && roled.merges[0].confidence >= 0.8, 'role-narrowed match carries higher confidence');

console.log('== HIGH-degree attractor: flagged for SPLIT, never blind-merged ==');
const attractor = D.sweep([
  { id: 1, name: 'Tracy Bromley', type: 'person', title: 'Finance', degree: 10 },
  { id: 2, name: 'Tracy', type: 'person', degree: 25 },   // absorbed many mentions → likely multiple people
]);
ok(attractor.merges.length === 0, 'a degree-25 weak node is NOT auto-merged');
ok(attractor.attractorFlags.length === 1 && attractor.attractorFlags[0].kind === 'suspected-attractor', 'it is FLAGGED as a suspected attractor for operator split');
ok(attractor.attractorFlags[0].canonicalId === 1, 'the flag still records the likely canonical as a hint');

console.log('== AMBIGUOUS first name → operator disambiguation, no merge ==');
const amb = D.sweep([
  { id: 1, name: 'Chris Park', type: 'person', degree: 5 },
  { id: 2, name: 'Chris Doyle', type: 'person', degree: 5 },
  { id: 3, name: 'Chris', type: 'person', degree: 2 },
]);
ok(amb.merges.length === 0, 'no merge when two same-first-name canonicals exist');
ok(amb.attractorFlags.some(f => f.kind === 'ambiguous' && (f.candidates || []).length === 2), 'flagged ambiguous with both candidates surfaced');

console.log('== guards: strong nodes / weak-only populations ==');
ok(D.sweep([{ id: 1, name: 'Jane Smith', type: 'person', degree: 3 }, { id: 2, name: 'John Ray', type: 'person', degree: 3 }]).merges.length === 0, 'two distinct full names → nothing to merge');
const weakOnly = D.sweep([{ id: 1, name: 'Tracy', type: 'person', degree: 2 }, { id: 2, name: 'Tracy', type: 'person', degree: 2 }]);
ok(weakOnly.merges.length === 0, 'a weak node NEVER binds to another weak node (attractor guard holds retrospectively)');
ok(D.isCandidate({ name: 'Tracy', type: 'person' }) === true && D.isCandidate({ name: 'Tracy Bromley', type: 'person' }) === false, 'isCandidate: weak yes, strong no');

console.log('== planMerge emits reversible ops ==');
const plan = D.planMerge(r.merges[0]);
ok(plan && plan.reversible === true && plan.ops.includes('tombstone-source'), 'planMerge → reversible edge-rewire + tombstone plan');

console.log('== PERFORMANCE: first-name blocking keeps a big population sub-second (the freeze fix) ==');
// Before blocking, sweep() built a fresh copy of the ENTIRE population as context for EVERY candidate —
// O(candidates × n). At the live ~67k-target Puller size that pegged the main thread for minutes (the
// freeze). Synthesize a realistic 40k population (many distinct first names + a few bare-first-name
// fragments per name) and assert the sweep completes fast — proof the O(n²) is gone. A regression to the
// per-candidate full-population scan would blow this budget by orders of magnitude.
// letter-only names — _isNameToken rejects any token with a digit, so synthetic names must be pure letters
const toName = (n) => { let s = ''; n++; while (n > 0) { s = String.fromCharCode(97 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s.charAt(0).toUpperCase() + s.slice(1); };
const BIG = [];
let nid = 1;
for (let i = 0; i < 8000; i++) {
  const fn = toName(i);                                                       // 8000 distinct letter-only first names
  BIG.push({ id: nid++, name: `${fn} ${fn}son`, type: 'person', title: 'Director', degree: 6 });   // strong full-name canonical
  BIG.push({ id: nid++, name: fn, type: 'person', degree: 1 });                                     // a weak first-name fragment
  if (i % 50 === 0) { BIG.push({ id: nid++, name: fn, type: 'person', degree: 1 }); }               // a few dup fragments
}
// plus one moderately-large same-first-name block (a "John" cluster) to exercise a real block
for (let i = 0; i < 300; i++) BIG.push({ id: nid++, name: `John ${toName(i)} worth`, type: 'person', title: 'Analyst', degree: 4 });
BIG.push({ id: nid++, name: 'John', type: 'person', degree: 2 });
const t0 = Date.now();
const big = D.sweep(BIG);
const ms = Date.now() - t0;
console.log(`  swept ${BIG.length} rows (${big.candidates} candidates, ${big.merges.length} merges) in ${ms}ms`);
ok(ms < 2000, `sweep of ${BIG.length} rows completes in <2s (was minutes / a main-thread freeze) — actual ${ms}ms`);
ok(big.merges.length >= 8000, 'the weak fragments still merge into their canonicals at scale (correctness holds under blocking)');
// a bare "John" among 300 same-first-name canonicals is ambiguous → flagged, never blind-merged
ok(big.attractorFlags.some(f => f.kind === 'ambiguous'), 'a crowded first-name block still flags ambiguity, not a wrong merge');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
