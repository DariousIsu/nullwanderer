/* smoke_coverage_evidence.js — coverage learns to say what it actually holds (R2).
 *
 * The failure this exists to prevent, verbatim from a live session:
 *
 *   "How much have we covered on Louisiana Parishes?"  → "all 64 of the Louisiana parishes (100%)"
 *   "Can we get those parish rosters completed now?"   → "I couldn't pin down specific leadership
 *                                                        contact information"
 *
 * Both were true. Coverage counted BEATS VISITED and said nothing about what came back. Measured
 * against the encounter log: 64 visited, 40 holding evidence, 24 holding none.
 *
 * Every assertion here defends one rule: VISITED AND HELD ARE DIFFERENT NUMBERS AND MUST BOTH BE SAID.
 * Reporting either alone misleads, in opposite directions.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_coverage_evidence.js
 */
'use strict';
const cg = require('../lib/coverage_gaps');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ── the basic count ──────────────────────────────────────────────────────────────────────────────
{
  const targets = ['Acadia Parish', 'Allen Parish', 'Ascension Parish', 'Assumption Parish'];
  const holds = (t) => (t === 'Acadia Parish' ? { sources: 3 } : t === 'Allen Parish' ? { sources: 1 } : null);
  const ev = cg.evidenceCoverage(targets, holds);
  ok(ev.total === 4 && ev.held === 2 && ev.empty === 2, 'held and empty are counted separately');
  ok(ev.corroborated === 1,
    'CRITICAL: corroboration is its own number — holding something is not the same as holding it twice');
  ok(ev.missing.length === 2 && ev.missing.includes('Ascension Parish'),
    'the empty targets ARE the work list, named rather than counted');
  ok(ev.pct === 50, 'percentage reflects HELD, not visited');
}

// ── the live failure, reproduced ─────────────────────────────────────────────────────────────────
{
  // 64 parishes, every one visited, 40 holding anything.
  const parishes = Array.from({ length: 64 }, (_, i) => `Parish ${i + 1}`);
  const holds = (t) => (Number(String(t).split(' ')[1]) <= 40 ? { sources: 1 } : null);
  const visited = { done: 64, total: 64 };
  const ev = cg.evidenceCoverage(parishes, holds);
  ok(ev.held === 40 && ev.empty === 24, 'the measured live shape: 64 visited, 40 held, 24 empty');

  const line = cg.describeCoverage({ visited, evidence: ev });
  ok(/64 of 64 researched/.test(line) && /40 of 64 hold evidence/.test(line),
    'CRITICAL: BOTH numbers appear — "64 of 64" alone is what produced the wrong answer');
  ok(/0 on more than one independent source/.test(line),
    'CRITICAL: and corroboration is stated, so single-sourced coverage cannot read as settled');
}
{
  // The opposite misreading: reporting only what is HELD hides that 24 places were genuinely looked at
  // and came back empty. That is a finding about the world, not a task still queued.
  const line = cg.describeCoverage({ visited: { done: 64, total: 64 }, evidence: { total: 64, held: 40, corroborated: 5 } });
  ok(/researched/.test(line) && /hold evidence/.test(line),
    'CRITICAL: visited survives in the line — visited-but-empty is information, not an omission');
}

// ── refusals and edges ───────────────────────────────────────────────────────────────────────────
{
  const ev = cg.evidenceCoverage(['A', 'B'], () => { throw new Error('db down'); });
  ok(ev.held === 0 && ev.empty === 2,
    'CRITICAL: a failing lookup counts as NOT held — it must never imply evidence we cannot see');
  ok(cg.evidenceCoverage([], null).total === 0 && cg.evidenceCoverage(null, null).total === 0,
    'empty/null → zeroes, never throws');
  ok(cg.evidenceCoverage(['A'], () => ({ sources: 0 })).corroborated === 0, 'zero sources is not corroboration');
  ok(cg.evidenceCoverage([null, 'A'], () => ({ sources: 2 })).total === 1, 'null targets are dropped, not counted');
}
{
  // An empty universe must not read as complete — the same trap coverageGap already guards.
  ok(cg.evidenceCoverage([], () => ({ sources: 9 })).pct === 0,
    'CRITICAL: no targets is 0%, never 100% — "nothing to do" and "all done" are different');
  ok(cg.describeCoverage({}) === 'no coverage data', 'nothing known → says so');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
