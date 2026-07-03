/**
 * Offline smoke for lib/poll_average.js — the poll-aggregation model (Suite B, model #1).
 * Fixtures are hand-computable so each weight component + house-effect + trend is verified exactly.
 * Deterministic (now injected). No network.
 *
 * Run: node scripts/smoke_poll_average.js
 */
const M = require('../lib/poll_average');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }
function near(name, got, want, tol = 0.01) { ok(name, Math.abs(got - want) <= tol, `got ${got} want ${want}`); }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }

const NOW = Date.parse('2026-07-03');
const poll = (o) => ({ source_kind: 'test', poll_type: 'approval', subject: 'Donald Trump', is_aggregate: false, answers: [], ...o });

// --- weight components ---
eq('gradeWeight null → 1', M.gradeWeight(null), 1);
eq('gradeWeight 3 → 1.5', M.gradeWeight(3), 1.5);
eq('gradeWeight 0 → 0.5', M.gradeWeight(0), 0.5);
// recency: age 21d @ halfLife 21 → 0.5 ; sample 1500/1500 → 1
near('weight recency 21d = 0.5', M.pollWeight(poll({ end_date: '2026-06-12', sample_size: 1500 }), { now: NOW }), 0.5);
near('weight fresh full-n = 1', M.pollWeight(poll({ end_date: '2026-07-03', sample_size: 1500 }), { now: NOW }), 1);
near('weight sample 375 → 0.5', M.pollWeight(poll({ end_date: '2026-07-03', sample_size: 375 }), { now: NOW }), 0.5);
near('weight no date → recencyDefault·1', M.pollWeight(poll({ sample_size: 1500 }), { now: NOW }), 0.25);
near('weight internal penalty 0.5', M.pollWeight(poll({ end_date: '2026-07-03', sample_size: 1500, internal: true }), { now: NOW }), 0.5);
near('weight partisan penalty 0.7', M.pollWeight(poll({ end_date: '2026-07-03', sample_size: 1500, partisan: 'R' }), { now: NOW }), 0.7);
near('weight quality grade3 = 1.5', M.pollWeight(poll({ pollster: 'X', end_date: '2026-07-03', sample_size: 1500 }), { now: NOW, ratingsByPollster: { X: { grade: 3 } } }), 1.5);

// --- weighted average: A(w=1) Approve50/Disapprove45 + B(w=0.5) Approve40/Disapprove55 ---
const twoPolls = [
  poll({ pollster: 'A', end_date: '2026-07-03', sample_size: 1500, answers: [{ choice: 'Approve', pct: 50 }, { choice: 'Disapprove', pct: 45 }] }),
  poll({ pollster: 'B', end_date: '2026-06-12', sample_size: 1500, answers: [{ choice: 'Approve', pct: 40 }, { choice: 'Disapprove', pct: 55 }] }),
];
const avg = M.average(twoPolls, { now: NOW, subject: 'Donald Trump', poll_type: 'approval' });
near('avg Approve = 46.67', avg.choices.find((c) => c.choice === 'Approve').pct, 46.6667);
near('avg Disapprove = 48.33', avg.choices.find((c) => c.choice === 'Disapprove').pct, 48.3333);
eq('avg leader = Disapprove', avg.leader, 'Disapprove');
near('avg margin = 1.67', avg.margin, 1.67);
eq('avg n_polls/pollsters', [avg.n_polls, avg.n_pollsters], [2, 2]);

// --- filtering: subject/poll_type + is_aggregate excluded ---
const mixed = twoPolls.concat([
  poll({ pollster: 'C', subject: 'Other Race', end_date: '2026-07-03', sample_size: 1500, answers: [{ choice: 'Approve', pct: 99 }] }),
  poll({ pollster: 'RCP Average', is_aggregate: true, end_date: '2026-07-03', sample_size: 1500, answers: [{ choice: 'Approve', pct: 99 }] }),
]);
eq('filter: only matching subject, aggregate excluded', M.average(mixed, { now: NOW, subject: 'Donald Trump', poll_type: 'approval' }).n_polls, 2);

// --- modal choice-set: a stray incompatible answer-set within the group is excluded ---
const heterog = [
  poll({ pollster: 'A', end_date: '2026-07-03', sample_size: 1500, answers: [{ choice: 'Approve', pct: 45 }, { choice: 'Disapprove', pct: 52 }] }),
  poll({ pollster: 'B', end_date: '2026-07-03', sample_size: 1500, answers: [{ choice: 'Approve', pct: 43 }, { choice: 'Disapprove', pct: 54 }] }),
  poll({ pollster: 'Stray', end_date: '2026-07-03', sample_size: 1500, answers: [{ choice: 'Dem', pct: 48 }, { choice: 'Rep', pct: 47 }] }),
];
const modal = M.average(heterog, { now: NOW, subject: 'Donald Trump', poll_type: 'approval' });
eq('modal: keeps 2 Approve/Disapprove polls, drops stray Dem/Rep', modal.n_polls, 2);
ok('modal: choices are only Approve/Disapprove', modal.choices.every((c) => c.choice === 'Approve' || c.choice === 'Disapprove'));
eq('modal: applied.choiceSet reported', modal.applied.choiceSet, 'approve|disapprove');
eq('choiceSet:all keeps everything', M.average(heterog, { now: NOW, subject: 'Donald Trump', poll_type: 'approval', choiceSet: 'all' }).n_polls, 3);

// --- house effects ---
const hePolls = [
  poll({ pollster: 'Lean', end_date: '2026-07-03', sample_size: 1500, answers: [{ choice: 'Approve', pct: 60 }] }),
  poll({ pollster: 'Lean', end_date: '2026-07-03', sample_size: 1500, answers: [{ choice: 'Approve', pct: 60 }] }),
  poll({ pollster: 'Neutral', end_date: '2026-07-03', sample_size: 1500, answers: [{ choice: 'Approve', pct: 40 }] }),
];
const he = M.computeHouseEffects(hePolls);
near('house-effect: Lean +6.67 vs pool', he.Lean.Approve, 6.6667);
ok('house-effect: single-poll pollster skipped', !he.Neutral);
const rawAvg = M.average(hePolls, { now: NOW }).choices[0].pct;
const heAvg = M.average(hePolls, { now: NOW, houseEffect: true }).choices[0].pct;
near('avg without HE = 53.33', rawAvg, 53.3333);
near('avg with HE = 48.89 (lean removed)', heAvg, 48.8889);
ok('HE pulls toward pool (lower)', heAvg < rawAvg);

// --- quality weighting shifts the average toward the graded pollster ---
const q = M.average(twoPolls, { now: NOW, ratings: [{ pollster: 'B', grade: 3 }] });
ok('quality: grading B (older, disapprove-lean) raises Disapprove vs base', q.choices.find((c) => c.choice === 'Disapprove').pct > avg.choices.find((c) => c.choice === 'Disapprove').pct);
ok('quality: applied flag set', q.applied.quality === true);

// --- trend ---
const tr = M.trend(twoPolls, { now: NOW, subject: 'Donald Trump', poll_type: 'approval', stepDays: 7, points: 4 });
ok('trend: returns points', tr.length >= 1 && tr.every((p) => p.date && p.leader), JSON.stringify(tr));
ok('trend: dates ascending', tr.every((p, i) => i === 0 || p.date >= tr[i - 1].date));

// --- fail-soft ---
eq('empty → n_polls 0, leader null', (() => { const a = M.average([], { now: NOW }); return [a.n_polls, a.leader]; })(), [0, null]);
eq('null input → no throw', M.average(null, { now: NOW }).n_polls, 0);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
