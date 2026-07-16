/* Smoke: lib/entity_collective — Step 3, COLLECTIVE / RELATIONAL tie-break (Bhattacharya-Getoor).
 * Heavy coverage: the resolved-id precision guard (ids, never name-strings), the dominance rule, the
 * ambiguous → REVIEW cases, no-context / no-overlap, fail-soft neighborsOf, and the City-of-Sacramento
 * disambiguation the whole step exists for.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_entity_collective.js
 */
'use strict';
const C = require('../lib/entity_collective');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- relationalSim ---------------------------------------------------------------------------------
ok(C.relationalSim(['a', 'b', 'c'], ['b', 'z']).shared === 1, 'relationalSim: counts shared resolved ids');
ok(Math.abs(C.relationalSim(['a', 'b', 'c'], ['b', 'c']).simR - 2 / 3) < 1e-9, 'relationalSim: simR = fraction of context the candidate covers');
ok(C.relationalSim([], ['a']).simR === 0 && C.relationalSim(['a'], []).simR === 0, 'relationalSim: empty either side → 0');
ok(C.relationalSim(new Set(['a', 'b']), new Set(['a'])).shared === 1, 'relationalSim: accepts Sets');

(async () => {
  const NB = (map) => async (cand) => map[cand.id] || [];

  // --- THE City-of-Sacramento disambiguation ------------------------------------------------------
  // incoming "City of Sacramento" co-occurs with a resolved mayor + CA gov entities; only the real city
  // already connects to them → tie broken to it.
  const ctx = ['mccarty', 'ca_gov', 'sac_council'];
  const cands = [{ id: 'sac_real' }, { id: 'west_sac' }, { id: 'sac_stale' }];
  const nb1 = NB({ sac_real: ['mccarty', 'ca_gov', 'sac_council', 'other'], west_sac: ['yolo_county'], sac_stale: [] });
  const r1 = await C.collectiveTieBreak(ctx, cands, { neighborsOf: nb1 });
  ok(r1.decision === 'match' && r1.target.id === 'sac_real', 'city: the candidate whose EXISTING neighbors cover the context wins the tie');
  ok(r1.simR === 1 && r1.scored.length === 3, 'city: winner covers the whole context; all candidates scored');

  // --- precision guard: overlap is on IDS, not name-strings ---------------------------------------
  // Two "C. Chen" neighbors that are DIFFERENT resolved entities must NOT count as shared.
  const g = await C.collectiveTieBreak(['chen_1'], [{ id: 'A' }, { id: 'B' }], { neighborsOf: NB({ A: ['chen_1'], B: ['chen_2'] }) });
  ok(g.decision === 'match' && g.target.id === 'A', 'precision guard: only the SAME resolved neighbor id counts (chen_1 ≠ chen_2)');
  ok(g.scored.find((s) => s.cand.id === 'B').shared === 0, 'precision guard: a same-NAME but different-ID neighbor scores 0 shared');

  // --- ambiguous → REVIEW (no clear winner) -------------------------------------------------------
  const amb = await C.collectiveTieBreak(['x', 'y'], [{ id: 'A' }, { id: 'B' }], { neighborsOf: NB({ A: ['x'], B: ['y'] }) });
  ok(amb.decision === 'review' && /ambiguous/.test(amb.reason), 'ambiguous: two candidates with equal overlap → REVIEW (never guess)');

  // --- dominance rule -----------------------------------------------------------------------------
  const dom = await C.collectiveTieBreak(['x', 'y', 'z'], [{ id: 'A' }, { id: 'B' }], { neighborsOf: NB({ A: ['x', 'y', 'z'], B: ['x'] }) });
  ok(dom.decision === 'match' && dom.target.id === 'A', 'dominance: top (3/3) clearly beats 2nd (1/3) → MATCH');
  const notDom = await C.collectiveTieBreak(['x', 'y', 'z', 'w'], [{ id: 'A' }, { id: 'B' }], { neighborsOf: NB({ A: ['x', 'y'], B: ['z', 'w'] }) });
  ok(notDom.decision === 'review', 'dominance: two candidates each covering half → no clear winner → REVIEW');

  // --- no overlap / no context / single candidate -------------------------------------------------
  const noov = await C.collectiveTieBreak(['x', 'y'], [{ id: 'A' }, { id: 'B' }], { neighborsOf: NB({ A: ['p'], B: ['q'] }) });
  ok(noov.decision === 'review' && noov.reason === 'no-dominant-neighbor-overlap', 'no overlap at all → REVIEW (absence of overlap ≠ evidence of difference)');
  ok((await C.collectiveTieBreak([], cands, { neighborsOf: nb1 })).reason === 'no-context', 'no context → REVIEW (can\'t use the graph)');
  const solo = await C.collectiveTieBreak(['x'], [{ id: 'A' }], { neighborsOf: NB({ A: ['x'] }) });
  ok(solo.decision === 'match' && solo.target.id === 'A', 'single candidate with a shared resolved neighbor → MATCH');

  // --- fail-soft ----------------------------------------------------------------------------------
  const soft = await C.collectiveTieBreak(['x'], [{ id: 'A' }, { id: 'B' }], { neighborsOf: async (c) => { if (c.id === 'B') throw new Error('graph read failed'); return ['x']; } });
  ok(soft.decision === 'match' && soft.target.id === 'A', 'fail-soft: a throwing neighborsOf for one candidate → it scores 0, the others still resolve');
  ok((await C.collectiveTieBreak(['x'], [{ id: 'A' }], {})).decision === 'review', 'fail-soft: no neighborsOf dep → REVIEW (never throws)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
