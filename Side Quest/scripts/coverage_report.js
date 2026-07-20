/* scripts/coverage_report.js — P4: what is actually UNRESEARCHED, measured against real denominators.
 *
 * This is the honest completeness picture: for every beat, how much of its enumerated universe we
 * have covered. No statistics, no inference — a beat knows its universe and the scheduler records
 * what it covered, so the difference is fact.
 *
 * Read-only. Usage: ELECTRON_RUN_AS_NODE=1 electron scripts/coverage_report.js [--work]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');
const beats = require('../lib/beats');
const cg = require('../lib/coverage_gaps');

db.init();
const SHOW_WORK = process.argv.includes('--work');

// A beat's covered set lives on whichever focus thread ran it. The scheduler's state maps beatId →
// thread, and coverage is stored per-focus, so resolve through that.
const sched = (() => { try { return JSON.parse(db.getMeta('sched.autonomic') || '{}') || {}; } catch { return {}; } })();
function coveredFor(beatId) {
  try {
    const bs = (sched.beats || {})[beatId];
    if (!bs || !bs.thread) return [];
    return JSON.parse(db.getMeta(`focus.${bs.thread}.covered`) || '[]') || [];
  } catch { return []; }
}

const all = (() => { try { return beats.electedOfficialsSubBeats() || []; } catch { return []; } })();
const gaps = cg.coverageGaps(all, coveredFor);
const s = cg.summarize(gaps);

console.log(`\nCOVERAGE — what is researched vs what EXISTS\n${'='.repeat(74)}`);
console.log(`beats: ${s.beats}   all-targets-researched: ${s.completeBeats}   with no worklist: ${s.emptyUniverseBeats}`);
console.log(`bodies/offices RESEARCHED: ${s.done} of ${s.total} (${s.pct}%)   OUTSTANDING: ${s.remaining}`);

// Data gaps first — a beat with no worklist can't be researched at all, and a naive report would
// silently show it as 0/0 = done.
const empties = gaps.filter(g => g.emptyUniverse);
if (empties.length) {
  console.log(`\n${'-'.repeat(74)}\nDATA GAPS — no worklist exists, so these can never be researched:`);
  for (const g of empties) console.log(`  ! ${g.beatId}`);
  console.log(`  ↳ these are NOT "complete" — the targets are missing from our source data.`);
}

const started = gaps.filter(g => !g.emptyUniverse && g.done > 0 && !g.complete)
  .sort((a, b) => b.pct - a.pct);
const untouched = gaps.filter(g => !g.emptyUniverse && g.done === 0);
const complete = gaps.filter(g => g.complete);

console.log(`\n${'-'.repeat(74)}\nIN PROGRESS (${started.length}) — closest to done first`);
for (const g of started.slice(0, 20))
  console.log(`  ${String(g.pct).padStart(3)}%  ${String(g.done).padStart(5)}/${String(g.total).padEnd(6)} ${g.beatId}`);

console.log(`\n${'-'.repeat(74)}\nNOT STARTED (${untouched.length})`);
for (const g of untouched.slice(0, 12)) console.log(`    0%  ${String(0).padStart(5)}/${String(g.total).padEnd(6)} ${g.beatId}`);
if (untouched.length > 12) console.log(`    … and ${untouched.length - 12} more`);

if (complete.length) {
  console.log(`\n${'-'.repeat(74)}\nEVERY TARGET RESEARCHED (${complete.length}) — NOT the same as roster-complete`);
  for (const g of complete.slice(0, 10)) console.log(`  100%  ${g.done}/${g.total} ${g.beatId}`);
}

if (SHOW_WORK) {
  const work = cg.openWork(gaps, { perBeat: 8, limit: 60 });
  console.log(`\n${'-'.repeat(74)}\nSAMPLE OUTSTANDING TARGETS (${work.length} shown, capped per beat)`);
  for (const w of work) console.log(`  ${w.beatId.padEnd(28)} ${w.target}`);
}

// ── FACT GAPS — the other half of the picture (P3). A body can be fully "researched" and still be
// missing its roster; that shows up here, not above.
try {
  const absence = require('../lib/absence');
  const open = absence.openGaps({ limit: 400 });
  console.log(`\n${'-'.repeat(74)}\nFACT GAPS — bodies we DID research where a facet never appeared (${open.length})`);
  if (!open.length) {
    console.log(`  (none recorded yet — these accrue as targets complete with facets outstanding)`);
  } else {
    const byPred = new Map();
    for (const r of open) byPred.set(r.predicate, (byPred.get(r.predicate) || 0) + 1);
    for (const [p, n] of [...byPred.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10))
      console.log(`  ${String(n).padStart(4)}  ${String(p).slice(0, 66)}`);
  }
  console.log(`  ↳ all 'somevalue' — a value exists and we have not found it. NEVER 'novalue'.`);
} catch (e) { console.log(`\n(fact gaps unavailable: ${e.message})`); }

console.log(`\n${'='.repeat(74)}`);
console.log(`WHAT "COVERED" MEANS HERE — read this before quoting the number.`);
console.log(`A target is a BODY or an OFFICE (a chamber, a parish council, a congressional seat), not`);
console.log(`a person. "Covered" means that body was RESEARCHED — it does NOT mean its roster is`);
console.log(`complete. Georgia's legislature is 2 targets (its two chambers), so 2/2 says both were`);
console.log(`worked, not that ~236 legislators are on file.`);
console.log(``);
console.log(`So the two sections above answer different questions, and both are needed:`);
console.log(`  COVERAGE gaps — bodies never visited          → PENDING WORK, for the allocator`);
console.log(`  FACT gaps     — bodies visited, facet missing  → an OBSERVATION, in the absence model`);
console.log(``);
console.log(`Member-level completeness ("do we have all 236?") needs a per-body cardinality — the seat`);
console.log(`count captured as a fact. That is P5 and it is NOT built; the beats ask for "chamber size"`);
console.log(`as a facet, which is where it would come from.`);
process.exit(0);
