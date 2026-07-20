/* smoke_coverage_gaps.js — P4 coverage gap detection.
 *
 * The load-bearing case is emptyUniverse: a beat with NO worklist must never read as "100% covered".
 * A naive done/total reports 0/0 as complete, which is the most misleading answer available — it
 * would hide a data gap (the CT/RI lower-chamber case) as a finished job.
 */
'use strict';
const cg = require('../lib/coverage_gaps');
const beats = require('../lib/beats');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const fakeBeat = (id, targets, kind = 'entity') => ({ id, kind, enumerate: () => targets });

// ── a partial beat ─────────────────────────────────────────────────────────────────────────────
{
  const b = fakeBeat('t', ['Acadia Parish', 'Allen Parish', 'Ascension Parish', 'Assumption Parish']);
  const g = cg.coverageGap(b, ['Acadia Parish']);
  ok(g.done === 1 && g.total === 4, 'counts done vs total');
  ok(g.remainingCount === 3 && g.remaining.includes('Allen Parish'), 'lists the actual uncovered targets');
  ok(g.pct === 25, 'pct');
  ok(g.complete === false, 'partial → not complete');
  ok(g.emptyUniverse === false, 'has a universe');
}

// ── fuzzy matching must agree with the scheduler's notion of covered ───────────────────────────
{
  const b = fakeBeat('t', ['Parish Council of Acadia Parish, Louisiana']);
  const g = cg.coverageGap(b, ['Acadia Parish Council']);
  ok(g.done === 1, 'fuzzy place-key match counts as covered (same rule the scheduler uses)');
}

// ── THE LOAD-BEARING CASE: an empty universe is a DATA gap, never "complete" ───────────────────
{
  const g = cg.coverageGap(fakeBeat('state-legislature-ct', []), []);
  ok(g.emptyUniverse === true, 'no worklist → emptyUniverse flagged');
  ok(g.complete === false, 'CRITICAL: 0/0 must NOT read as complete (it is a missing worklist, not a finished job)');
  ok(g.pct === 0, 'empty universe → 0%, not 100%');
}

// ── complete ───────────────────────────────────────────────────────────────────────────────────
{
  const g = cg.coverageGap(fakeBeat('t', ['Acadia Parish', 'Allen Parish']), ['Acadia Parish', 'Allen Parish']);
  ok(g.complete === true && g.remainingCount === 0, 'all covered → complete');
}

// ── bad input ──────────────────────────────────────────────────────────────────────────────────
ok(cg.coverageGap(null, []) === null, 'null beat → null');
ok(cg.coverageGap({ id: 'x' }, []) === null, 'beat without enumerate() → null');
{
  const g = cg.coverageGap({ id: 'x', enumerate: () => { throw new Error('boom'); } }, []);
  ok(g && g.emptyUniverse === true, 'enumerate() that throws → treated as empty universe, never crashes');
}

// ── summarize: sums the UNIVERSE, does not average percentages ─────────────────────────────────
{
  const gaps = [
    cg.coverageGap(fakeBeat('big', Array.from({ length: 100 }, (_, i) => `t${i}`)), []),   // 0/100
    cg.coverageGap(fakeBeat('small', ['Acadia Parish', 'Allen Parish']), ['Acadia Parish', 'Allen Parish']),   // 2/2
    cg.coverageGap(fakeBeat('empty', []), []),                                              // data gap
  ];
  const s = cg.summarize(gaps);
  ok(s.total === 102 && s.done === 2, 'summarize sums over the real universe');
  ok(s.pct === 2, 'CRITICAL: pct is over summed universe (2%), NOT the mean of 0% and 100% (50%)');
  ok(s.emptyUniverseBeats === 1, 'data gaps counted separately');
  ok(s.completeBeats === 1, 'complete beats counted');
  ok(s.remaining === 100, 'remaining work');
}
ok(cg.summarize([]).pct === 0 && cg.summarize(null).total === 0, 'summarize: empty/null safe');

// ── openWork: per-beat cap prevents one huge beat starving the rest ────────────────────────────
{
  const gaps = [
    cg.coverageGap(fakeBeat('huge', Array.from({ length: 3152 }, (_, i) => `c${i}`)), []),
    cg.coverageGap(fakeBeat('other', ['Acadia Parish', 'Allen Parish']), []),
  ];
  const w = cg.openWork(gaps, { perBeat: 5 });
  ok(w.filter(i => i.beatId === 'huge').length === 5, 'per-beat cap honoured (no starvation)');
  ok(w.some(i => i.beatId === 'other'), 'the small beat still gets represented');
  ok(w.every(i => i.target && i.beatId), 'work items carry target + beat');
  ok(cg.openWork(gaps, { perBeat: 100, limit: 7 }).length === 7, 'global limit honoured');
  const done = cg.coverageGap(fakeBeat('d', ['Acadia Parish']), ['Acadia Parish']);
  ok(cg.openWork([done]).length === 0, 'a complete beat contributes no work');
  const empty = cg.coverageGap(fakeBeat('e', []), []);
  ok(cg.openWork([empty]).length === 0, 'an empty-universe beat contributes no work (it is a DATA gap — nothing to research yet)');
}

// ── against the REAL beat data ─────────────────────────────────────────────────────────────────
{
  const la = beats.countyCommissionBeat('LA');
  const g = cg.coverageGap(la, []);
  ok(g.total === 64, `real LA beat universe is 64 (got ${g.total})`);
  ok(g.remainingCount === 64 && !g.complete, 'nothing covered → all 64 outstanding');
  const g2 = cg.coverageGap(la, la.enumerate().slice(0, 9));
  ok(g2.done === 9 && g2.remainingCount === 55, 'THE LIVE CASE: 9 of 64 → 55 outstanding, not "complete"');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
