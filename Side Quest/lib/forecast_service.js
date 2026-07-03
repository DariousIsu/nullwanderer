/**
 * lib/forecast_service.js — the PROCESSING side (Suite B, main-process orchestration for the UI).
 *
 * The forecasting system PROCESSES incoming data into forecasting objects for the widgets. Data sources
 * split two ways (Lucas, 2026-07-03):
 *   • Poll connectors (poll_wikipedia/votehub/538legacy) are ORIGIN here — polling data is forecasting-
 *     specific and only useful once processed, so it lives with the forecasting system. This service reads
 *     them directly.
 *   • Generic raw API data (fundamentals / markets / GDELT) is MULTI-CONSUMER, so it's ingested UPSTREAM
 *     (the shared API feed lane) and READ here — never ingested in this project. Future model builders take
 *     that data as an injected feed, not a local adapter.
 *
 * `buildPollAveragePayload` is PURE + deterministic (inject `now`) → offline-testable
 * (scripts/smoke_forecast_service.js). No prod DB is touched; an isolated forecast DB lands only when we
 * persist forecasting objects (separate-DB directive). A small in-memory cache avoids refetch on reopen.
 * Each MODEL gets one builder here + one widget in the renderer — so we nail each model's visual on its own.
 */
'use strict';

const votehub = require('./poll_votehub');
const legacy = require('./poll_538legacy');
const avg = require('./poll_average');

// PURE: normalized polls + 538 ratings → the poll-average WIDGET payload (current + trend + latest).
function buildPollAveragePayload(polls, ratings, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const list = Array.isArray(polls) ? polls : [];
  const subject = opts.subject || (list[0] && list[0].subject) || '';
  const poll_type = opts.poll_type || 'approval';
  const base = { now, subject, poll_type, ratings: ratings || [], houseEffect: true };

  const cur = avg.average(list, base);
  const trend = avg.trend(list, { ...base, stepDays: opts.stepDays || 7, points: opts.points || 26 })
    .map((p) => ({ date: p.date, choices: p.choices }));
  const latest = list
    .filter((p) => p.end_date && Array.isArray(p.answers) && p.answers.length)
    .slice().sort((a, b) => String(b.end_date).localeCompare(String(a.end_date)))
    .slice(0, 8)
    .map((p) => ({ pollster: p.pollster, date: p.end_date, n: p.sample_size, pop: p.population, answers: p.answers }));

  return {
    ok: true,
    model: 'poll_average',
    as_of: new Date(now).toISOString().slice(0, 10),
    subject, poll_type,
    choices: cur.choices.map((c) => ({ choice: c.choice, pct: Number(c.pct.toFixed(1)) })),
    leader: cur.leader, runner_up: cur.runner_up, margin: cur.margin,
    n_polls: cur.n_polls, n_pollsters: cur.n_pollsters, applied: cur.applied,
    trend, latest,
  };
}

// LIVE: read the poll connectors + compute, cached in-memory (TTL). deps injected for tests.
const _cache = {};
const TTL_MS = 10 * 60 * 1000;
async function pollAverageWidget({ subject = 'Donald Trump', poll_type = 'approval', getPolls, getRatings, now, force } = {}) {
  const t = now || Date.now();
  const key = poll_type + '|' + subject.toLowerCase();
  const hit = _cache[key];
  if (!force && hit && t - hit.t < TTL_MS) return hit.payload;

  const pollsFeed = getPolls || (async () => (await votehub.fetchPolls({ fetchJson: votehub.defaultFetchJson, poll_type })).polls);
  const ratingsFeed = getRatings || (async () => (await legacy.fetchRatings({ fetchText: legacy.defaultFetchText })).ratings);

  let payload;
  try {
    const [allPolls, ratings] = await Promise.all([pollsFeed(), ratingsFeed()]);
    const polls = (allPolls || []).filter((p) => String(p.subject || '').toLowerCase() === subject.toLowerCase());
    payload = buildPollAveragePayload(polls, ratings, { now: t, subject, poll_type });
  } catch (e) {
    return { ok: false, model: 'poll_average', error: e.message };
  }
  _cache[key] = { t, payload };
  return payload;
}

// ---- BALANCE OF POWER (forecast_sim) — the machine's headline widget ----
// ILLUSTRATIVE synthetic slate until the recompute loop wires per-race poll_average margins in. Deterministic.
function illustrativeSlate() {
  const seeded = (n, base, spread, ch) => Array.from({ length: n }, (_, i) => ({ id: `${ch}-${i}`, chamber: ch, margin: Number((base + (i - (n - 1) / 2) / n * spread).toFixed(2)), sigma: 6 }));
  const races = seeded(37, -0.6, 14, 'house').concat(seeded(11, -1.4, 10, 'senate'));
  const config = { nationalSigma: 3.4, iterations: 40000, seed: 2026, holdovers: { house: { A: 198, B: 200 }, senate: { A: 44, B: 45 } }, majority: { house: 218, senate: 51 } };
  return { races, config };
}

// PURE — forecast_sim output + slate → the balance-of-power payload (A=Democrats, B=Republicans).
function buildBalancePayload(sim, races, config) {
  const tip = (ch) => races.filter((r) => r.chamber === ch).map((r) => ({ id: r.id, margin: Number(r.margin.toFixed(1)) }))
    .sort((a, b) => Math.abs(a.margin) - Math.abs(b.margin)).slice(0, 5);
  const chamber = (name) => {
    const c = sim.chambers[name] || {};
    return { need: (config.majority || {})[name] || null, total: c.total_seats || null,
      pD_control: Number((c.pA_control || 0).toFixed(3)), pR_control: Number((1 - (c.pA_control || 0)).toFixed(3)),
      dSeats_mean: c.seatsA_mean, dSeats_p10: c.seatsA_p10, dSeats_p90: c.seatsA_p90,
      competitive: races.filter((r) => r.chamber === name).length, tipping: tip(name) };
  };
  const relabel = (s) => s.replace('house:A', 'House D').replace('house:B', 'House R').replace('senate:A', 'Senate D').replace('senate:B', 'Senate R');
  return {
    house: chamber('house'), senate: chamber('senate'),
    scenarios: (sim.scenarios || []).map((s) => ({ label: relabel(s.label), prob: s.prob })),
  };
}

// LIVE-ish: run the simulator on the (illustrative) slate → payload + WORK (inputs + live reads) for the inspector.
function balanceWidget({ seed = null } = {}) {
  try {
    const { races, config } = illustrativeSlate();
    const cfg = { ...config, seed: seed != null ? seed : config.seed };
    const t0 = Date.now();
    const sim = require('./forecast_sim').simulate(races, cfg);
    const timing_ms = Date.now() - t0;
    return {
      ok: true, illustrative: true, as_of: 'illustrative', model: 'balance_of_power',
      payload: buildBalancePayload(sim, races, cfg),
      work: { inputs: { config: cfg, races }, sim: { chambers: sim.chambers, iterations: sim.iterations }, timing_ms },
    };
  } catch (e) { return { ok: false, model: 'balance_of_power', error: e.message }; }
}

// what the renderer lists as available widgets (each maps to a model). Grows one entry per model.
function listWidgets() {
  return [
    { id: 'balance_of_power', title: 'Balance of Power', status: 'illustrative' },
    { id: 'poll_average', title: 'Poll Average', subject: 'Donald Trump', poll_type: 'approval', status: 'live' },
  ];
}

module.exports = { buildPollAveragePayload, pollAverageWidget, illustrativeSlate, buildBalancePayload, balanceWidget, listWidgets };
