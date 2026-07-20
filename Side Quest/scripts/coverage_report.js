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
  // openGaps returns gaps DUE for another attempt — ones inside their TTL are deliberately withheld
  // so we don't re-research the same miss every tick. Report both, because printing only the due
  // count reads as "no fact gaps exist" when the real state is "recorded, not yet due".
  let total = 0;
  try { total = require('../lib/db').getDb().prepare(`SELECT COUNT(*) c FROM absence WHERE kind='somevalue'`).get().c; } catch {}
  console.log(`\n${'-'.repeat(74)}\nFACT GAPS — bodies we DID research where a facet never appeared`);
  console.log(`  ${total} recorded, ${open.length} due for another attempt (${total - open.length} still inside their re-try TTL)`);
  if (!open.length) {
    console.log(total
      ? `  (nothing due right now — recorded gaps wait out their TTL before we spend another pass on them)`
      : `  (none recorded yet — these accrue as targets complete with facets outstanding)`);
  } else {
    const byPred = new Map();
    for (const r of open) byPred.set(r.predicate, (byPred.get(r.predicate) || 0) + 1);
    for (const [p, n] of [...byPred.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10))
      console.log(`  ${String(n).padStart(4)}  ${String(p).slice(0, 66)}`);
  }
  console.log(`  ↳ all 'somevalue' — a value exists and we have not found it. NEVER 'novalue'.`);
} catch (e) { console.log(`\n(fact gaps unavailable: ${e.message})`); }

// ROSTER SIZE — the seat counts captured so far. This is what turns "probably incomplete" into a
// countable gap, so it is worth seeing how MANY bodies actually yielded one: the capture refuses
// anything it cannot trace to a page the run opened, and a low count here means the refusals are
// firing, not that the wiring is dead.
try {
  const cardinality = require('../lib/cardinality');
  const db = require('../lib/db').getDb();
  const all = db.prepare(`SELECT * FROM cardinality ORDER BY observed_ts DESC`).all();
  console.log(`\n${'-'.repeat(74)}\nROSTER SIZE — bodies with a CITED seat count (${all.length})`);
  if (!all.length) {
    console.log(`  (none yet — captured once per dossier body as it completes, and only from a URL`);
    console.log(`   the run actually opened; an uncited number is refused rather than guessed)`);
  } else {
    for (const r of all.slice(0, 20))
      console.log(`  ${String(r.seats).padStart(4)}  ${String(r.body).slice(0, 46).padEnd(46)} ${r.source_kind}`);
    const conf = cardinality.conflicts({ limit: 20 });
    if (conf.length) {
      console.log(`\n  CONFLICTS (${conf.length}) — sources disagree; surfaced for a human, never auto-resolved:`);
      for (const c of conf) console.log(`    ${c.body}: holding ${c.seats}, also seen ${c.conflict_seats}`);
    }
  }
  console.log(`  ↳ seats + how many members we hold = a countable roster gap (cardinality.gapFor).`);
} catch (e) { console.log(`\n(roster sizes unavailable: ${e.message})`); }

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
console.log(`count captured as a fact. That is the ROSTER SIZE section: captured once per dossier body,`);
console.log(`only from a page the run actually opened. A body with no seat count makes NO completeness`);
console.log(`claim at all — that is the honest answer, not a defect.`);
process.exit(0);
