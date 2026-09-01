/* Smoke: lib/swarm — swarm-on-command surge allocator (Slice S5). Pure, offline.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_swarm.js
 */
'use strict';
const s = require('../lib/swarm');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- partitionRoster: round-robin split, balanced, drops empties ---
ok(eq(s.partitionRoster(['a', 'b', 'c', 'd', 'e'], 2), [['a', 'c', 'e'], ['b', 'd']]), 'roster split across 2 (round-robin)');
ok(eq(s.partitionRoster(['a', 'b', 'c'], 3), [['a'], ['b'], ['c']]), 'exactly k targets → one each');
ok(s.partitionRoster(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3).map((p) => p.length).join(',') === '3,2,2', 'balanced sizes (7 across 3 → 3,2,2)');
ok(s.partitionRoster(['a', 'b'], 5).length === 2, 'fewer targets than workers → only non-empty partitions');
ok(eq(s.partitionRoster([], 3), []), 'no targets → no partitions');
ok(s.partitionRoster(['a', 'b', 'c'], 1).length === 1 && s.partitionRoster(['a', 'b', 'c'], 1)[0].length === 3, 'k=1 → single partition holds all');
ok(s.partitionRoster(['a', 'b'], 0)[0].length === 2, 'k floored at 1 (never zero partitions)');
// every target lands exactly once, none duplicated
{
  const tg = Array.from({ length: 67 }, (_, i) => `county-${i}`);
  const parts = s.partitionRoster(tg, 3);
  const flat = parts.flat();
  ok(flat.length === 67 && new Set(flat).size === 67, 'partition is a clean cover — every target once, no dupes (67/3)');
}

// --- ⭐ AUTO-SWARM (2026-09-01, Lucas: "there should be a swarm on everything now"): the pure
// decision behind partitioning HIS bounded runs by default ---
ok(s.shouldAutoSwarm({ remaining: 8, totalWorkers: 4 }).swarm === true, '⭐ a bounded run with 8 remaining targets and 4 workers swarms by default');
ok(s.shouldAutoSwarm({ remaining: 8, totalWorkers: 4 }).k === 3, 'k respects the slot plan (4 workers → the primary IS the floor stream → 3 swarm)');
ok(s.shouldAutoSwarm({ remaining: 3, totalWorkers: 4 }).reason === 'below-threshold', `fewer than ${s.AUTO_SWARM_MIN_TARGETS} remaining → overhead, not speed — no swarm`);
ok(s.shouldAutoSwarm({ remaining: 8, totalWorkers: 1 }).reason === 'no-workers', 'research.workers=1 → nothing to surge, honest refusal');
ok(s.shouldAutoSwarm({ remaining: 8, totalWorkers: 4, swarmLive: true }).reason === 'swarm-live', 'one swarm at a time machine-wide — a live swarm blocks a second');
ok(s.shouldAutoSwarm({}).swarm === false, 'empty input → no swarm, no throw');

// --- planSwarmSlots: primary always breadth, ≥floor stays normal, capped by bg ---
ok(eq(s.planSwarmSlots({ totalWorkers: 2 }), { swarmWorkers: 1, breadthWorkers: 1 }), '2 workers → 1 swarms, primary stays breadth');
ok(eq(s.planSwarmSlots({ totalWorkers: 4 }), { swarmWorkers: 3, breadthWorkers: 1 }), '4 workers → 3 bg swarm, primary breadth');
ok(eq(s.planSwarmSlots({ totalWorkers: 4, requestedK: 2 }), { swarmWorkers: 2, breadthWorkers: 2 }), 'requestedK honored (2 of 3 bg)');
ok(eq(s.planSwarmSlots({ totalWorkers: 4, requestedK: 9 }), { swarmWorkers: 3, breadthWorkers: 1 }), 'requestedK capped at available bg (3)');
ok(eq(s.planSwarmSlots({ totalWorkers: 1 }), { swarmWorkers: 0, breadthWorkers: 1 }), 'no bg workers → swarm degenerates (primary only, 0 swarm)');
ok(s.planSwarmSlots({ totalWorkers: 4, floor: 4 }).swarmWorkers === 0, 'floor==total → nothing to swarm (all breadth)');
ok(s.planSwarmSlots({ totalWorkers: 5, floor: 2 }).swarmWorkers === 3, 'floor 2 of 5 → 3 swarm, 2 breadth');
ok(s.planSwarmSlots({ totalWorkers: 3 }).breadthWorkers >= s.DEFAULT_SWARM_FLOOR, 'breadth never drops below the floor');

// --- shouldReleaseRoster: all partitions done ---
ok(s.shouldReleaseRoster({ parts: {} }) === true, 'no partitions → release');
ok(s.shouldReleaseRoster({ parts: { 1: { done: true }, 2: { done: true } } }) === true, 'all partitions done → release');
ok(s.shouldReleaseRoster({ parts: { 1: { done: true }, 2: { done: false } } }) === false, 'one partition still running → hold');

// --- shouldReleaseDeep: all facets done OR time budget ---
ok(s.shouldReleaseDeep({ facetsPlanned: ['a', 'b'], facetsDone: ['a', 'b'] }) === true, 'all facets done → release');
ok(s.shouldReleaseDeep({ facetsPlanned: ['a', 'b'], facetsDone: ['a'] }) === false, 'facet still open → hold');
ok(s.shouldReleaseDeep({ facetsPlanned: ['a', 'b'], facetsDone: [], maxMs: 1000, startedAt: 0, now: 2000 }) === true, 'time budget spent → release even if facets open (inexhaustible guard)');
ok(s.shouldReleaseDeep({ facetsPlanned: ['a', 'b'], facetsDone: [], maxMs: 1000, startedAt: 0, now: 500 }) === false, 'within time budget + facets open → hold');
ok(s.shouldReleaseDeep({ facetsPlanned: [] }) === true, 'no facets planned → release');

// --- nextDeepFacet: distinct-angle assignment, no duplicate claims ---
ok(s.nextDeepFacet({ facetsPlanned: ['a', 'b', 'c'], claimed: ['a'] }) === 'b', 'next unclaimed facet');
ok(s.nextDeepFacet({ facetsPlanned: ['a', 'b'], claimed: ['a', 'b'] }) === null, 'all facets claimed → null');
ok(s.nextDeepFacet({ facetsPlanned: ['a', 'b', 'c'], claimed: [] }) === 'a', 'first facet when none claimed');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
