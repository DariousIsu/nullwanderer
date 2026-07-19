/**
 * lib/swarm.js — SWARM-ON-COMMAND: the SURGE allocator (research-allocation Slice S5).
 *
 * On top of the steady priority allocator (lib/beat_scheduler), a swarm temporarily reallocates BACKGROUND
 * research workers onto ONE thing for a bounded burst, then RELEASES them back to the normal queue. The
 * primary stream always stays on normal breadth (the reserve floor), so a swarm surges depth without ever
 * going blind. Two modes:
 *   ROSTER — K workers converge one beat's roster in PARALLEL, each on a distinct TARGET partition
 *            (e.g. `swarm on florida counties` → 3 workers split the 67 counties). Reuses the per-target
 *            dossier machinery; the win is wall-clock (a big roster converges ~K× faster).
 *   DEEP   — K workers each take a distinct FACET/angle of ONE target, then the returns are cross-verified
 *            and synthesized (the fan-out→verify→synthesize pattern). The win is exhaustiveness on one entity.
 *
 * This module is the PURE decision half (offline-testable): partitioning, slot planning, release conditions.
 * All runtime I/O — seeding partitioned threads, reading coverage, the `swarm on <X>` chat verb, synthesis —
 * lives in main.js, because it needs the focus/thread/db plumbing.
 */
'use strict';

const DEFAULT_SWARM_FLOOR = 1;   // ≥ this many streams (incl. the always-breadth primary) stay on normal
                                 // rotation during a swarm, so on-command depth never kills always-on coverage.

// ROSTER PARTITION — split a roster's targets across k workers ROUND-ROBIN (worker i gets targets[i],
// targets[i+k], targets[i+2k], …). Round-robin rather than contiguous blocks so alphabetical/size skew is
// spread evenly across workers (block 0 = "A…" counties shouldn't all land on one worker). Returns k (or
// fewer, if targets < k) non-empty partitions.
function partitionRoster(targets, k) {
  const K = Math.max(1, k | 0);
  const parts = Array.from({ length: K }, () => []);
  (targets || []).forEach((t, i) => parts[i % K].push(t));
  return parts.filter((p) => p.length);
}

// SLOT PLAN — how many workers commit to the swarm vs stay on breadth. `totalWorkers` = research.workers
// (primary + background). The PRIMARY is always breadth, so a swarm draws only from BACKGROUND workers, and
// even then is capped so ≥ `floor` streams stay on the normal queue. Returns { swarmWorkers, breadthWorkers }.
function planSwarmSlots({ totalWorkers = 2, requestedK = null, floor = DEFAULT_SWARM_FLOOR } = {}) {
  const total = Math.max(1, totalWorkers | 0);
  const bg = Math.max(0, total - 1);                                   // background workers (primary excluded)
  const maxSwarm = Math.max(0, total - Math.max(1, floor | 0));        // keep ≥ floor streams on breadth
  let k = (requestedK == null) ? bg : (requestedK | 0);
  k = Math.max(0, Math.min(k, maxSwarm, bg));                          // never exceed bg or the floor budget
  return { swarmWorkers: k, breadthWorkers: total - k };
}

// ROSTER RELEASE — the swarm is done when every partition's worker has resolved its slice (all targets
// covered). `parts` = { <slot>: { thread, targets, done } }. Empty → release (nothing to do).
function shouldReleaseRoster({ parts = {} } = {}) {
  const vals = Object.values(parts);
  if (!vals.length) return true;
  return vals.every((p) => p && p.done);
}

// DEEP RELEASE — done when every planned facet has been researched, or the time budget is spent (a single
// target is inexhaustible in principle, so DEEP always carries a maxMs stop so it can't grind forever).
function shouldReleaseDeep({ facetsDone = [], facetsPlanned = [], maxMs = null, startedAt = null, now = 0 } = {}) {
  if (maxMs != null && startedAt != null && (now - startedAt) >= maxMs) return true;
  if (!facetsPlanned.length) return true;
  const done = new Set(facetsDone);
  return facetsPlanned.every((f) => done.has(f));
}

// The next uncovered facet for a DEEP swarm worker to claim (distinct-angle assignment). `claimed` = facets
// already handed to other swarm workers this burst. Returns null when every facet is claimed.
function nextDeepFacet({ facetsPlanned = [], claimed = [] } = {}) {
  const taken = new Set(claimed);
  return facetsPlanned.find((f) => !taken.has(f)) || null;
}

module.exports = { DEFAULT_SWARM_FLOOR, partitionRoster, planSwarmSlots, shouldReleaseRoster, shouldReleaseDeep, nextDeepFacet };
