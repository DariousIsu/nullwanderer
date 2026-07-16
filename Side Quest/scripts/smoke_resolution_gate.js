/* Smoke: lib/resolution_gate — the COMPOSED gate (block → match → collective → canonicalize), end-to-end.
 * The acceptance test runs the WHOLE gate on the real failure flows: Howell must MINT (never merge into the
 * wrong person), the LAMP bare-surname must REVIEW (never fan), a strong-id lands a MERGE, an ambiguous org
 * is broken by the collective tie-break, and no candidates → MINT.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_resolution_gate.js
 */
'use strict';
const G = require('../lib/resolution_gate');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// A blocking dep that returns a fixed candidate list from the surname/name/token blockers.
const blockOf = (list) => ({ byBlock: async () => list, byNameKey: async () => list });

(async () => {
  // 1) no candidates → MINT
  const r1 = await G.resolveNode({ name: 'Brand New Person (TX)', type: 'person' }, {});
  ok(r1.action === 'mint' && r1.reason === 'no-candidates', 'gate: nothing blocked → MINT');

  // 2) strong-id → MERGE, canonical form is the tagged one
  const r2 = await G.resolveNode({ name: 'Kevin McCarty [wd:Q6396892]', type: 'person' },
    blockOf([{ id: 1, name: 'Kevin McCarty [wd:Q6396892]', degree: 20 }, { id: 2, name: 'Kevin McCarty (CA)', degree: 3 }]));
  ok(r2.action === 'merge' && r2.target.id === 1 && r2.tier === 'strong-id', 'gate: shared QID → MERGE to the strong-id candidate');
  ok(r2.canonicalName === 'Kevin McCarty [wd:Q6396892]', 'gate: canonical form is the strong-id-tagged name');

  // 3) THE HOWELL FLOW: incoming William blocked against Janet (same surname+state) → MINT, never merge
  const r3 = await G.resolveNode({ name: 'William J. Howell (VA)', type: 'person' },
    blockOf([{ id: 9, name: 'Janet D. Howell (VA)', degree: 900 }]));
  ok(r3.action === 'mint', 'HOWELL end-to-end: William blocked against Janet → MINT (never merged into the wrong person)');

  // 4) THE LAMP FLOW: bare surname against many same-surname candidates → REVIEW, never fan
  const r4 = await G.resolveNode({ name: 'Chang (HI)', type: 'person' },
    blockOf([{ id: 11, name: 'David Chang (HI)' }, { id: 12, name: 'Stanley Chang (HI)' }, { id: 13, name: 'Mel Chang (HI)' }]));
  ok(r4.action === 'review', 'LAMP end-to-end: bare "Chang (HI)" vs many Changs → REVIEW (anti-fan, no auto-merge)');

  // 5) COLLECTIVE breaks an ambiguous org: 3 dup "CITY OF SACRAMENTO" (conflicting lda) → matcher REVIEWs;
  //    context (the resolved mayor) + neighbors resolve it to the one already linked to him.
  const sacCands = [
    { id: 'A', name: 'CITY OF SACRAMENTO [lda_client:1]' },
    { id: 'B', name: 'CITY OF SACRAMENTO [lda_client:2]' },
    { id: 'C', name: 'CITY OF SACRAMENTO [lda_client:3]' },
  ];
  const nb = { A: ['mccarty', 'ca_gov'], B: [], C: [] };
  const r5 = await G.resolveNode({ name: 'City of Sacramento', type: 'organization' },
    { ...blockOf(sacCands), context: ['mccarty', 'ca_gov'], neighborsOf: async (c) => nb[c.id] || [] });
  ok(r5.action === 'merge' && r5.target.id === 'A' && r5.tier === 'collective', 'CITY end-to-end: collective tie-break merges to the candidate linked to the resolved context');

  // 6) same ambiguous org but NO context → stays REVIEW (never guesses without the graph)
  const r6 = await G.resolveNode({ name: 'City of Sacramento', type: 'organization' }, blockOf(sacCands));
  ok(r6.action === 'review', 'CITY: no context → REVIEW (collective can\'t run, matcher won\'t guess)');

  // 7) collective present but no dominant neighbor overlap → REVIEW (precision-first)
  const r7 = await G.resolveNode({ name: 'City of Sacramento', type: 'organization' },
    { ...blockOf(sacCands), context: ['someone_unrelated'], neighborsOf: async () => [] });
  ok(r7.action === 'review', 'CITY: context present but no candidate covers it → REVIEW');

  // 8) exactly one probabilistic match, no competitors → MERGE
  const r8 = await G.resolveNode({ name: 'Patrick McHenry (US-US)', type: 'person' },
    blockOf([{ id: 20, name: 'Patrick T. McHenry (US)', degree: 50 }, { id: 21, name: 'Nancy Pelosi (US)' }]));
  ok(r8.action === 'merge' && r8.target.id === 20, 'gate: a single clean probabilistic match → MERGE');

  // --- resolveEdgeEndpoints: the promote-up bridge policy (BOTH endpoints must resolve to EXISTING) ---
  console.log('== resolveEdgeEndpoints (bridge policy) ==');
  const e1 = await G.resolveEdgeEndpoints({ source: 'Kevin McCarty [wd:Q6396892]', target: 'CITY OF SACRAMENTO [lda_client:5]' },
    { byStrongId: async (_s, id) => (id === 'Q6396892' ? [{ id: 1, name: 'Kevin McCarty [wd:Q6396892]' }] : id === '5' ? [{ id: 2, name: 'CITY OF SACRAMENTO [lda_client:5]' }] : []) });
  ok(e1.ok && e1.sourceName === 'Kevin McCarty [wd:Q6396892]' && e1.targetName === 'CITY OF SACRAMENTO [lda_client:5]', 'edge: both endpoints strong-id resolve → LANDS with canonical names');

  const e2deps = {
    byStrongId: async (_s, id) => (id === 'Q6396892' ? [{ id: 1, name: 'Kevin McCarty [wd:Q6396892]' }] : []),
    byNameKey: async (nk) => (nk === 'city of sacramento' ? [{ id: 10, name: 'CITY OF SACRAMENTO [lda_client:1]' }, { id: 11, name: 'CITY OF SACRAMENTO [lda_client:2]' }] : []),
  };
  const e2 = await G.resolveEdgeEndpoints({ source: 'Kevin McCarty [wd:Q6396892]', target: 'City of Sacramento' }, e2deps);
  ok(!e2.ok && e2.reason === 'target-review', 'edge: source resolves but target ambiguous (no context) → HOLD, never guess');

  const e3 = await G.resolveEdgeEndpoints({ source: 'Kevin McCarty [wd:Q6396892]', target: 'City of Sacramento' },
    { ...e2deps, neighborsOf: async (c) => (c.id === 1 ? ['ca_gov'] : c.id === 10 ? ['ca_gov'] : []) });
  ok(e3.ok && e3.targetName === 'CITY OF SACRAMENTO [lda_client:1]', 'edge: collective context (source neighbors) disambiguates the target → LANDS to the right dup');

  const e4 = await G.resolveEdgeEndpoints({ source: 'Totally New Source', target: 'CITY OF SACRAMENTO [lda_client:5]' }, {});
  ok(!e4.ok && e4.reason === 'source-mint', 'edge: source itself unresolvable → HOLD (source-mint) — no half-formed edge');

  // --- preResolve: the write-path pre-resolver (gate-first, else fallback) --------------------------
  console.log('== preResolve (write path) ==');
  let fbCalls = 0;
  const fallback = async () => { fbCalls++; return { status: 'nil', mention: 'fb' }; };
  // gate MERGES (strong id) → resolved, fallback NOT called
  fbCalls = 0;
  const p1 = await G.preResolve('Kevin McCarty [wd:Q6396892]', {}, { deps: { byStrongId: async () => [{ id: 7, name: 'Kevin McCarty [wd:Q6396892]' }] }, fallback });
  ok(p1.status === 'resolved' && p1.object.id === 7 && p1.via.startsWith('gate:') && fbCalls === 0, 'preResolve: a precision-safe gate MERGE returns the existing entity; fallback NOT called');
  // gate MINTS (no candidates) → fallback runs (existing resolver preserved)
  fbCalls = 0;
  const p2 = await G.preResolve('Nobody Here', {}, { deps: {}, fallback });
  ok(p2.status === 'nil' && p2.mention === 'fb' && fbCalls === 1, 'preResolve: gate mint → falls through to the existing resolver');
  // gate REVIEW (ambiguous org) → fallback runs (never overrides on ambiguity)
  fbCalls = 0;
  await G.preResolve('City of Sacramento', {}, { deps: { byNameKey: async () => [{ id: 1, name: 'CITY OF SACRAMENTO [lda_client:1]' }, { id: 2, name: 'CITY OF SACRAMENTO [lda_client:2]' }] }, fallback });
  ok(fbCalls === 1, 'preResolve: gate REVIEW (ambiguous) → falls through (gate only ever ADDS a confident merge)');
  // no fallback + non-merge → nil (never throws)
  ok((await G.preResolve('X', {}, { deps: {} })).status === 'nil', 'preResolve: no fallback + non-merge → nil');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
