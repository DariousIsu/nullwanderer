/* lib/coverage_gaps.js — MEMORY PATH MAPPING slice P4: COVERAGE GAP DETECTION.
 *
 * NAME NOTE: `lib/gaps.js` is already taken by CAPABILITY gaps ("things Zoe cannot do yet"). This is
 * a different animal entirely — COVERAGE gaps are jurisdictions in a known universe we have not
 * researched yet. Two unrelated concepts, kept in two files on purpose.
 *
 * The design ranks gap sources by precision and says to build them in that order. This is #1, and
 * the only one SOUND TODAY, because it needs no statistics and no inference — just a denominator we
 * already hold. A beat enumerates its universe (64 Louisiana parishes, 3,152 counties); `covered`
 * records what we actually did; the difference IS the gap. Nothing is estimated, so nothing can be
 * wrong.
 *
 * TWO GAP KINDS, DELIBERATELY NOT CONFLATED — this distinction is why the module exists separately
 * from the absence model rather than being folded into it:
 *
 *   COVERAGE gap — a target in the universe we have NOT VISITED. This is PENDING WORK. It says
 *                  nothing about the world; we simply have not looked. It belongs to the allocator.
 *   FACT gap     — a target we DID research to exhaustion where a facet never materialised. That IS
 *                  an observation about the world, and it belongs in lib/absence.js as `somevalue`.
 *
 * Recording an unvisited target as an "absence" would be a category error: it would let NOT HAVING
 * STARTED masquerade as HAVING LOOKED AND FOUND NOTHING — and only the second should ever feed a
 * conclusion. Keeping them apart is what stops "we haven't got to it yet" from decaying into
 * "there's nothing there".
 *
 * DELIBERATELY NOT RANKED BY A NEW HEURISTIC. The priority allocator already scores staleness, news,
 * yield and fairness. Gaps contribute a MEASUREMENT — how much of the universe is undone — not a
 * competing ordering. Invent a clever gap ranking here and two schedulers end up fighting.
 *
 * Pure. No db, no engine, no IO — the caller supplies beats and their covered lists.
 */
'use strict';

const beats = require('./beats');

// One beat's coverage. Reuses beats.coverageOf so "covered" means exactly what the scheduler already
// means — fuzzy PLACE-key matching, so "Acadia Parish Police Jury" counts against the enumerated
// "the governing body of Acadia Parish, Louisiana". A second notion of coverage here would silently
// disagree with the scheduler's, and then neither number could be trusted.
//
// Matching on the place rather than the body's title also means this number counts JURISDICTIONS, which
// is the only thing the worklist can honestly enumerate — we know every parish exists, we do not know
// what its governing body is called until we research it.
function coverageGap(beat, covered) {
  if (!beat || typeof beat.enumerate !== 'function') return null;
  let targets = [];
  try { targets = beat.enumerate() || []; } catch { targets = []; }
  const c = beats.coverageOf(targets, covered || []);
  return {
    beatId: beat.id || null,
    kind: beat.kind || null,
    done: c.done,
    total: c.total,
    remaining: c.remaining,            // the actual uncovered target names — the work list
    remainingCount: c.remaining.length,
    pct: c.pct,
    complete: c.total > 0 && c.done >= c.total,
    // A beat with NO universe is a DATA gap, not a coverage gap — the worklist itself is missing
    // (the known CT/RI lower-chamber case). Flagged distinctly because a naive done/total would
    // report 0/0 as "100% covered", which is the most misleading answer available.
    emptyUniverse: c.total === 0,
  };
}

// Across many beats. `coveredFor(beatId)` supplies each beat's covered list (the caller owns the db).
function coverageGaps(beatList, coveredFor) {
  const out = [];
  for (const b of (beatList || [])) {
    const g = coverageGap(b, typeof coveredFor === 'function' ? coveredFor(b && b.id) : []);
    if (g) out.push(g);
  }
  return out;
}

// Portfolio view. `pct` is computed over the SUMMED universe, not as a mean of per-beat percentages
// — averaging percentages would let a 3-target beat outweigh a 3,152-target one.
function summarize(gapList) {
  const gaps = (gapList || []).filter(Boolean);
  const withUniverse = gaps.filter((g) => !g.emptyUniverse);
  const total = withUniverse.reduce((a, g) => a + g.total, 0);
  const done = withUniverse.reduce((a, g) => a + g.done, 0);
  return {
    beats: gaps.length,
    completeBeats: gaps.filter((g) => g.complete).length,
    emptyUniverseBeats: gaps.filter((g) => g.emptyUniverse).length,   // data gaps, not coverage gaps
    done,
    total,
    remaining: total - done,
    pct: total ? Math.round((done / total) * 100) : 0,
  };
}

// The uncovered targets themselves, flattened into work items. `perBeat` caps how many any single
// beat contributes so one 3,152-target beat cannot crowd out every other jurisdiction — the same
// starvation concern the allocator's fairness term exists for.
function openWork(gapList, { perBeat = 25, limit = 500 } = {}) {
  const out = [];
  for (const g of (gapList || [])) {
    if (!g || g.emptyUniverse || g.complete) continue;
    for (const t of g.remaining.slice(0, perBeat)) {
      if (out.length >= limit) return out;
      out.push({ beatId: g.beatId, kind: g.kind, target: t, beatPct: g.pct });
    }
  }
  return out;
}

// ── EVIDENCE COVERAGE (R2) — a THIRD measurement, and the one that was missing ──────────────────
//
// The two above answer "did we go there". Neither answers "do we hold anything", and the difference is
// not academic — it is the exact failure Lucas hit:
//
//   "How much have we covered on Louisiana Parishes?"  → "all 64 of the Louisiana parishes (100%)"
//   "Can we get those parish rosters completed now?"   → "I couldn't pin down specific leadership
//                                                        contact information"
//
// Both statements were true. Coverage counts BEATS VISITED; it says nothing about what came back.
// Measured against the encounter log today: 64 parishes visited, 40 with any evidence held, 24 with
// none at all.
//
// So this is deliberately a SEPARATE number that must be reported ALONGSIDE the visited count, never
// instead of it and never averaged with it. Visited-but-empty is real information — it means a place
// was researched and yielded nothing, which is a different state from never having looked, and the
// module header's whole thesis is that those two must not be conflated.
//
// `holds(target)` is injected: it returns falsy for nothing held, or { sources } for evidence found.
// The caller owns the db; this stays pure.
function evidenceCoverage(targets, holds) {
  const list = (Array.isArray(targets) ? targets : []).filter(Boolean);
  const fn = typeof holds === 'function' ? holds : () => null;
  const held = [], empty = [], corroborated = [];
  for (const t of list) {
    let ev = null;
    try { ev = fn(t) || null; } catch { ev = null; }
    if (!ev) { empty.push(t); continue; }
    held.push(t);
    if ((Number(ev.sources) || 0) > 1) corroborated.push(t);
  }
  return {
    total: list.length,
    held: held.length,
    empty: empty.length,
    // The work list: visited or not, these are the targets we hold nothing about.
    missing: empty,
    corroborated: corroborated.length,
    pct: list.length ? Math.round((held.length / list.length) * 100) : 0,
  };
}

// One line that reports BOTH numbers, because either alone misleads in a different direction.
//
// "64 of 64 covered" invites the reading that the work is done. "40 of 64 hold evidence" alone hides
// that the other 24 were actually looked at and came back empty — which is a finding, not a to-do.
function describeCoverage({ visited = null, evidence = null } = {}) {
  const parts = [];
  if (visited && visited.total) parts.push(`${visited.done} of ${visited.total} researched`);
  if (evidence && evidence.total) {
    parts.push(`${evidence.held} of ${evidence.total} hold evidence`);
    if (evidence.total) parts.push(`${evidence.corroborated} on more than one independent source`);
  }
  return parts.join(' · ') || 'no coverage data';
}

module.exports = { coverageGap, coverageGaps, summarize, openWork, evidenceCoverage, describeCoverage };
