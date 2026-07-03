/**
 * Offline smoke for lib/forecast_loop.js — the recompute loop capstone. Drives the WHOLE chain
 * (slate → margins → news signals → gpt-oss pre-assess → reactor → sim → balance payload) with injected
 * fakes, zero network. Run: node scripts/smoke_forecast_loop.js
 */
const L = require('../lib/forecast_loop');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

const NOW = Date.parse('2026-07-03T12:00:00Z');

// ---- pure helpers ----
ok('defaultPartyOf attributes (D)/(R)/word', L.defaultPartyOf('Ruben Gallego (D)') === 'A' && L.defaultPartyOf('Kari Lake (R)') === 'B' && L.defaultPartyOf('Democrat') === 'A' && L.defaultPartyOf('Nobody') === null);

const avgDemAhead = { leader: 'Gallego (D)', runner_up: 'Lake (R)', margin: 5, n_polls: 4 };
const s1 = L.signMargin(avgDemAhead, { entities: [] }, L.defaultPartyOf);
ok('signMargin: Dem leader → +margin, source polls', s1 && s1.margin === 5 && s1.leader_party === 'A' && s1.source === 'polls');
const s2 = L.signMargin({ leader: 'Williams (R)', runner_up: 'Goodlander (D)', margin: 3, n_polls: 2 }, {}, L.defaultPartyOf);
ok('signMargin: Rep leader → -margin', s2 && s2.margin === -3 && s2.leader_party === 'B');
ok('signMargin: unattributable → null', L.signMargin({ leader: 'Smith', runner_up: 'Jones', margin: 2 }, {}, L.defaultPartyOf) === null);
ok('pollSigma tightens with polls, floored', L.pollSigma(0) > L.pollSigma(6) && L.pollSigma(20) >= 3.5);

// ---- pure recompute core: deterministic, payload shape ----
const handRaces = [
  { id: 'AZ:sen', chamber: 'senate', margin: 2, sigma: 5, entities: ['Arizona'] },
  { id: 'NH-02:hou', chamber: 'house', margin: -1, sigma: 5, entities: ['NH-02'] },
];
const rc1 = L.recompute(handRaces, { events: [], momentum: [] }, { now: NOW, config: { iterations: 4000, seed: 5 } });
ok('recompute: ok + balance payload (house+senate control probs)', rc1.ok && rc1.payload.house.pD_control >= 0 && rc1.payload.house.pD_control <= 1 && rc1.payload.senate.pR_control <= 1);
ok('recompute: majority thresholds carried', rc1.payload.house.need === 218 && rc1.payload.senate.need === 51);
ok('recompute: scenarios sum ~1', Math.abs(rc1.payload.scenarios.reduce((s, x) => s + x.prob, 0) - 1) < 0.02);
ok('recompute: WORK carries reacted races + sim + signal counts + timing', Array.isArray(rc1.work.inputs.races) && rc1.work.sim.chambers.house && rc1.work.signals.events === 0 && typeof rc1.work.timing_ms === 'number');
const rc2 = L.recompute(handRaces, { events: [], momentum: [] }, { now: NOW, config: { iterations: 4000, seed: 5 } });
ok('recompute: deterministic under fixed seed', JSON.stringify(rc2.payload) === JSON.stringify(rc1.payload));

// ---- buildAssessPairs: only corroborated events that touch a race ----
const evAZ = { id: 'e1', title: 'Arizona Senate debate reshapes the race', summary: 'A strong debate night.', entities: ['Arizona'], corroboration: 3, last_ts: NOW };
const evWeak = { id: 'e2', title: 'Arizona minor note', entities: ['Arizona'], corroboration: 1, last_ts: NOW };
const evOff = { id: 'e3', title: 'Ohio unrelated', entities: ['Ohio'], corroboration: 4, last_ts: NOW };
const pairRaces = [{ id: 'AZ:sen', chamber: 'senate', subject: '2026 Arizona', office: 'U.S. Senate', margin: 5, sigma: 4, entities: ['Arizona', 'U.S. Senate'] }];
const pairs = L.buildAssessPairs([evAZ, evWeak, evOff], pairRaces);
ok('buildAssessPairs: keeps only corroborated + touching (1 of 3)', pairs.length === 1 && pairs[0].event.id === 'e1', `got ${pairs.length}`);

(async () => {
  // ---- preAssess with a fake gpt-oss `ask` (returns the validated value directly) ----
  const ask = async () => ({ favors: 'A', magnitude: 'medium', confidence: 0.8 });
  const pa = await L.preAssess({ events: [evAZ], races: pairRaces, ask });
  ok('preAssess: assessed the eligible pair', pa.n_pairs === 1 && pa.assessed === 1 && pa.lookup(evAZ, pairRaces[0]).favors === 'A');
  const paNoAsk = await L.preAssess({ events: [evAZ], races: pairRaces });
  ok('preAssess: no ask → empty lookup (volatility-only path)', paNoAsk.assessed === 0 && paNoAsk.lookup(evAZ, pairRaces[0]) === null);

  // ---- computeMargins with injected race polls ----
  const racePoll = (subject, poll_type, answers) => ({ source_kind: 'test', poll_type, subject, is_aggregate: false, pollster: 'P', end_date: '2026-07-01', sample_size: 1200, answers });
  const getRacePolls = async (race) => {
    if (race.subject === '2026 Arizona') return [racePoll('2026 Arizona', 'us-senator', [{ choice: 'Gallego (D)', pct: 51 }, { choice: 'Lake (R)', pct: 46 }])];
    if (race.subject === '2026 NH-02') return [racePoll('2026 NH-02', 'us-representative', [{ choice: 'Williams (R)', pct: 50 }, { choice: 'Goodlander (D)', pct: 47 }])];
    return [];   // Nevada: unpolled → prior
  };
  const slate = [
    { id: 'AZ:sen', chamber: 'senate', subject: '2026 Arizona', poll_type: 'us-senator', office: 'U.S. Senate', entities: ['Arizona', 'U.S. Senate'] },
    { id: 'NH-02:hou', chamber: 'house', subject: '2026 NH-02', poll_type: 'us-representative', office: 'U.S. House', entities: ['NH-02', 'U.S. House'] },
    { id: 'NV:sen', chamber: 'senate', subject: '2026 Nevada', poll_type: 'us-senator', office: 'U.S. Senate', entities: ['Nevada', 'U.S. Senate'] },
  ];
  const withMargins = await L.computeMargins({ races: slate, getRacePolls, now: NOW });
  const az = withMargins.find((r) => r.id === 'AZ:sen'), nh = withMargins.find((r) => r.id === 'NH-02:hou'), nv = withMargins.find((r) => r.id === 'NV:sen');
  ok('computeMargins: AZ signed +5 from polls', az.margin === 5 && az.margin_source === 'polls' && az.n_polls === 1);
  ok('computeMargins: NH-02 signed -3 from polls', nh.margin === -3 && nh.margin_source === 'polls');
  ok('computeMargins: unpolled Nevada → neutral prior, wide σ', nv.margin === 0 && nv.margin_source === 'prior' && nv.sigma === L.PRIOR_SIGMA);

  // ---- full runOnce: slate build (year+chamber filter) → margins → news → assess → react → sim → payload ----
  const fetchSubjects = async () => ({ ok: true, subjects: [
    { subject: '2026 Arizona', poll_types: ['us-senator'] },
    { subject: '2026 NH-02', poll_types: ['us-representative'] },
    { subject: '2024 Ohio', poll_types: ['us-senator'] },        // wrong year → filtered
    { subject: 'Donald Trump', poll_types: ['approval'] },        // not a race → dropped
  ] });
  const newsEvents = () => [evAZ];
  const newsMomentum = () => [{ entity: 'Arizona', mentions: 30, video_mentions: 12, by_source_kind: { video: 12, rss: 18 } }];

  const res = await L.runOnce({ now: NOW, fetchSubjects, getRacePolls, newsEvents, newsMomentum, ask, config: { iterations: 6000, seed: 9 } });
  ok('runOnce: ok + as_of + not illustrative (has polled margins)', res.ok && res.as_of === '2026-07-03' && res.illustrative === false);
  ok('runOnce: slate filtered to 2 target-year races', res.work.margins.total === 2 && res.work.margins.polled === 2, JSON.stringify(res.work.margins));
  ok('runOnce: balance payload present (house+senate)', res.payload.house && res.payload.senate && res.payload.house.need === 218);
  ok('runOnce: gpt-oss assessed the AZ pair', res.work.assess.pairs >= 1 && res.work.assess.assessed >= 1);
  ok('runOnce: news moved a race (reactor applied signal)', Array.isArray(res.moved) && res.moved.length >= 1);
  const azReacted = res.work.inputs.races.find((r) => r.subject === '2026 Arizona');
  ok('runOnce: AZ margin shifted by attributed news (base 5 → >5) + live', azReacted.base_margin === 5 && azReacted.margin > 5 && azReacted.live === true, `margin ${azReacted && azReacted.margin}`);
  ok('runOnce: live-entity detector flags Arizona spike', res.live_entities.some((e) => e.entity === 'Arizona'));

  const empty = await L.runOnce({ now: NOW, fetchSubjects: async () => ({ subjects: [] }) });
  ok('runOnce: empty slate → fail-soft (no throw)', empty.ok === false && /empty slate/.test(empty.error));

  // FUNDAMENTALS tie-in end-to-end: api_stream econ snapshots (weak economy → national lean toward A) shift
  // every race margin via runOnce. Proves the econ_feed → forecast_fundamentals → loop wiring is live.
  const econBodies = {
    'fred:gdp': { observations: [{ date: '2025-06-01', value: '100' }, { date: '2026-06-01', value: '100' }] },   // 0% growth
    'fred:cpi': { observations: [{ date: '2025-06-01', value: '100' }, { date: '2026-06-01', value: '107' }] },   // +7% inflation
    'fred:unrate': { observations: [{ date: '2025-06-01', value: '6.5' }, { date: '2026-06-01', value: '7.0' }] },
  };
  const resF = await L.runOnce({ now: NOW, fetchSubjects, getRacePolls, ask, getSnapshot: (id) => (econBodies[id] ? { body: econBodies[id] } : null), config: { iterations: 4000, seed: 3 } });
  ok('runOnce: fundamentals leg present + has_data (api_stream consumed)', resF.work.fundamentals && resF.work.fundamentals.has_data && resF.work.fundamentals.favors === 'A', JSON.stringify(resF.work.fundamentals && { lean: resF.work.fundamentals.lean, favors: resF.work.fundamentals.favors }));
  const azF = resF.work.inputs.races.find((r) => r.subject === '2026 Arizona');
  ok('runOnce: national env lean applied to race margins (env_delta + base_margin_pre_env set)', azF.env_delta > 0 && azF.base_margin_pre_env === 5);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
