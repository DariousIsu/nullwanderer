/* Smoke: lib/run_closure — RUNS ARE MORTAL, THE DOCUMENT IS ETERNAL (Lucas 2026-07-30: "I do not
 * want this to spin forever… find new concepts in the research not from the original prompt…
 * without never-ending loops"). Pins: question-ledger fuzzy novelty, the three closure doors
 * (pass budget / discovery dry / frontier closed), deadline-scaled budgets, and spawn discipline
 * (depth cap 1, research-shaped wording, cap 3).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_run_closure.js
 */
'use strict';
const rc = require('../lib/run_closure');
const uw = require('../lib/user_work');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- question identity ---
ok(rc.normalizeQuestion('How does PJM manage its queue backlogs?').join(',') === rc.normalizeQuestion("how PJM's queue backlog is managed!").join(','),
  'a rephrased question collapses to the same identity');
ok(rc.normalizeQuestion('').length === 0, 'empty question → empty identity');

// --- novelty: rephrasings are not new directions ---
{
  const { ledger } = rc.filterNovel(['How does PJM manage interconnection queue backlogs?'], []);
  ok(!rc.isNovelQuestion('how are interconnection queue backlogs managed by PJM', ledger), 'a rephrasing is already-asked');
  ok(rc.isNovelQuestion('What role does FERC Order 2023 play in cost allocation disputes?', ledger), 'a genuinely new direction is novel');
  ok(!rc.isNovelQuestion('why?', ledger), 'a stub is never a research direction');
}

// --- filterNovel records EVERYTHING, steers only the novel ---
{
  const r1 = rc.filterNovel(['How does MISO plan transmission?', 'How does MISO plan transmission expansion?'], []);
  ok(r1.novel.length === 1, 'the second near-duplicate in one batch does not double-steer');
  ok(r1.ledger.length === 2, 'both questions are RECORDED — the ledger is what was asked, not what was new');
  const r2 = rc.filterNovel(['How does MISO plan transmission?'], r1.ledger);
  ok(r2.novel.length === 0, 'asking again later is not novel');
  const big = []; for (let i = 0; i < 80; i++) big.push(`unique question about topic ${i} alpha${i} beta${i} gamma${i}`);
  ok(rc.filterNovel(big, []).ledger.length === 60, 'ledger caps at 60');
}

// --- deadline-scaled budgets (anchored at thread birth, user_work semantics) ---
ok(rc.passBudgetFor({ content: 'I need this report within an hour', createdTs: 1000 }) === 12, 'rush → 12-pass budget (assemble, do not wander)');
ok(rc.passBudgetFor({ content: 'you have the next 6 hours to work on this', createdTs: 1000 }) === 24, 'a day-scale window → 24');
ok(rc.passBudgetFor({ content: 'substantiate that the grid was destined to fail', createdTs: 1000 }) === 40, 'open-ended → the full 40');
ok(rc.passBudgetFor({}) === 40, 'missing thread never throws');

// --- the three doors ---
ok(rc.shouldConclude({ passesUsed: 40, budget: 40 }).conclude && /pass budget/.test(rc.shouldConclude({ passesUsed: 40, budget: 40 }).reason), 'budget spent → conclude, door named');
ok(rc.shouldConclude({ passesUsed: 5, budget: 40, dryStreak: 3 }).conclude, 'three dry discovery ticks → conclude');
ok(rc.shouldConclude({ passesUsed: 5, budget: 40, dryStreak: 1, noNovelStreak: 2 }).conclude, 'no novel questions twice + one dry tick = frontier closed');
ok(!rc.shouldConclude({ passesUsed: 5, budget: 40, dryStreak: 1, noNovelStreak: 1 }).conclude, 'a narrowing frontier alone does not end the run');
ok(!rc.shouldConclude({ passesUsed: 39, budget: 40, dryStreak: 0, noNovelStreak: 0 }).conclude, 'a productive run under budget continues');
ok(!rc.shouldConclude({}).conclude, 'empty counters never conclude (and never throw)');

// --- spawn discipline ---
{
  const qs = ['What drives FERC Order 2023 cost allocation disputes between states?',
    'How do co-located data center interconnection rules differ across RTOs?',
    'Which watchdog reports predicted the 2021 ERCOT failure?', 'a fourth question that exceeds the cap entirely'];
  const spawns = rc.buildSpawns({ questions: qs, spawnedFrom: null });
  ok(spawns.length === 3, 'spawn cap is 3');
  ok(spawns.every((s) => /^Investigate: /.test(s)), 'spawns carry the Investigate: frame');
  ok(spawns.every((s) => uw.isResearchShaped(s)), 'every spawn is research-shaped — the driver WILL pick it up');
  ok(rc.buildSpawns({ questions: qs, spawnedFrom: '3617' }).length === 0, 'DEPTH CAP 1: a spawned run never spawns again');
  ok(rc.buildSpawns({ questions: ['too short'], spawnedFrom: null }).length === 0, 'a stub never becomes a thread');
  ok(rc.buildSpawns({}).length === 0, 'empty input never throws');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
