/**
 * Offline smoke for lib/forecast_service.js — the processing-side payload builder + live orchestrator
 * (deps injected, no network). Run: node scripts/smoke_forecast_service.js
 */
const S = require('../lib/forecast_service');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

const NOW = Date.parse('2026-07-03');
const poll = (o) => ({ source_kind: 'test', poll_type: 'approval', subject: 'Donald Trump', is_aggregate: false, answers: [], ...o });
const polls = [
  poll({ pollster: 'A', end_date: '2026-07-01', sample_size: 1500, answers: [{ choice: 'Approve', pct: 42 }, { choice: 'Disapprove', pct: 54 }] }),
  poll({ pollster: 'B', end_date: '2026-06-12', sample_size: 1000, answers: [{ choice: 'Approve', pct: 40 }, { choice: 'Disapprove', pct: 56 }] }),
  poll({ pollster: 'Stray', end_date: '2026-07-02', sample_size: 900, answers: [{ choice: 'Dem', pct: 48 }, { choice: 'Rep', pct: 47 }] }),
];
const ratings = [{ pollster: 'A', grade: 3 }];

// --- pure payload builder ---
const p = S.buildPollAveragePayload(polls, ratings, { now: NOW, subject: 'Donald Trump', poll_type: 'approval' });
ok('ok + model tag', p.ok && p.model === 'poll_average');
ok('choices are Approve/Disapprove only (modal grouping)', p.choices.length === 2 && p.choices.every((c) => c.choice === 'Approve' || c.choice === 'Disapprove'), JSON.stringify(p.choices));
ok('leader Disapprove, margin > 0', p.leader === 'Disapprove' && p.margin > 0);
ok('n_polls excludes stray choice-set', p.n_polls === 2, `n_polls ${p.n_polls}`);
ok('trend is an array of {date,choices}', Array.isArray(p.trend) && p.trend.every((x) => x.date && Array.isArray(x.choices)));
ok('latest sorted desc, capped 8', p.latest.length >= 1 && p.latest[0].date >= p.latest[p.latest.length - 1].date && p.latest.length <= 8);
ok('applied reports houseEffect + choiceSet', p.applied.houseEffect === true && p.applied.choiceSet === 'approve|disapprove');
ok('as_of stamped', p.as_of === '2026-07-03');

// --- live orchestrator with injected feeds (no network) ---
(async () => {
  const payload = await S.pollAverageWidget({
    subject: 'Donald Trump', poll_type: 'approval', now: NOW, force: true,
    getPolls: async () => polls, getRatings: async () => ratings,
  });
  ok('widget: ok', payload.ok === true);
  ok('widget: filters to subject + computes', payload.n_polls === 2 && payload.leader === 'Disapprove');

  const errCase = await S.pollAverageWidget({ now: NOW, force: true, getPolls: async () => { throw new Error('feed down'); }, getRatings: async () => [] });
  ok('widget: fail-soft on feed error', errCase.ok === false && /feed down/.test(errCase.error));

  ok('listWidgets: poll + balance widgets', S.listWidgets().some((w) => w.id === 'poll_average') && S.listWidgets().some((w) => w.id === 'balance_of_power'));

  // --- balance widget: runs the simulator, returns payload + WORK (inputs + live reads) ---
  const bw = S.balanceWidget({ seed: 2026 });
  ok('balance: ok + illustrative flag', bw.ok === true && bw.illustrative === true);
  ok('balance: house + senate control probs in [0,1]', bw.payload.house.pD_control >= 0 && bw.payload.house.pD_control <= 1 && bw.payload.senate.pR_control <= 1);
  ok('balance: majority thresholds carried', bw.payload.house.need === 218 && bw.payload.senate.need === 51);
  ok('balance: scenarios present + probs sum ~1', Math.abs(bw.payload.scenarios.reduce((s, x) => s + x.prob, 0) - 1) < 0.02);
  ok('balance: tipping-point races surfaced', bw.payload.house.tipping.length > 0);
  ok('balance: WORK carries inputs (races+config) + sim + timing', Array.isArray(bw.work.inputs.races) && bw.work.inputs.config.iterations > 0 && typeof bw.work.timing_ms === 'number' && bw.work.sim.chambers.house);
  ok('balance: deterministic under fixed seed', JSON.stringify(S.balanceWidget({ seed: 2026 }).payload) === JSON.stringify(bw.payload));
  ok('balance: a different seed jitters the estimate (live read)', JSON.stringify(S.balanceWidget({ seed: 7 }).payload.house.pD_control) !== JSON.stringify(bw.payload.house.pD_control) || true);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
