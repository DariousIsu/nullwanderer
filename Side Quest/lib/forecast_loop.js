/**
 * lib/forecast_loop.js — THE RECOMPUTE LOOP (Suite B capstone). Chains the whole machine into one run:
 *
 *   registry slate → per-race poll_average margins → news signals (events + momentum)
 *     → gpt-oss direction pre-assess → reactor (news perturbs margin/σ) → correlated sim
 *     → balance-of-power payload + WORK (the parts→whole transparency the studio renders)
 *
 * Split like every other forecasting lib: a PURE deterministic CORE (`recompute` — react→sim→payload, inject
 * `now`/`assessLookup`, no I/O) that the offline smoke exercises, and a LIVE orchestrator (`runOnce`) that
 * injects the real feeds (VoteHub subjects+polls, news_feed, cloud_logic.ask, echo resolve). Fail-soft
 * throughout — a dead feed degrades to a prior, never a throw. Nothing here writes: it READS the slate,
 * DERIVES a forecast, and RETURNS it; persistence to the 24h memory rail is a later, separately-gated step.
 *
 * HONESTY (R&D law): a race gets a SIGNED margin only when polls exist AND the leader's party can be
 * attributed (`partyOf` — injected Echo/FEC candidate→party map, or a label heuristic). Otherwise it falls
 * back to a neutral PRIOR with wide σ (the sim's national swing + race σ carry the uncertainty), and the run
 * is flagged `illustrative`. No phantom precision. Margins firm up as attribution + calibration land.
 */
'use strict';

const registry = require('./forecast_registry');
const avg = require('./poll_average');
const news = require('./news_feed');
const reactor = require('./forecast_reactor');
const assess = require('./forecast_assess');
const sim = require('./forecast_sim');
const service = require('./forecast_service');

// Sim defaults for the 2026 midterm balance target. holdovers = safe/unpolled seats folded in (the slate is
// only the POLLED universe); majority = control threshold per chamber. Overridable per run + by calibration.
const DEFAULT_CONFIG = {
  nationalSigma: 3.4, iterations: 40000, seed: 2026,
  holdovers: { house: { A: 198, B: 200 }, senate: { A: 44, B: 45 } },
  majority: { house: 218, senate: 51 },
};
const DEFAULT_TARGET_YEAR = 2026;
const PRIOR_SIGMA = 7;         // wide race σ for an un-polled / un-attributable race
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// PURE — cheap party heuristic from a choice LABEL: parenthetical "(D)"/"(R)" or a party word. Returns
// 'A'(=Dem) | 'B'(=Rep) | null. A real candidate→party map (Echo/FEC) is injected as `partyOf` to override.
function defaultPartyOf(choice) {
  const s = String(choice == null ? '' : choice);
  if (/\((?:d|dem)\b|\bdemocrat/i.test(s)) return 'A';
  if (/\((?:r|gop|rep)\b|\brepublican/i.test(s)) return 'B';
  return null;
}

// PURE — turn an unsigned poll_average result into a SIGNED party-A margin (+ = Dem ahead). null when the
// leader's party can't be attributed (→ caller uses a prior). partyOf(choice, race) → 'A'|'B'|null.
function signMargin(avgResult, race, partyOf) {
  if (!avgResult || avgResult.margin == null || !avgResult.leader) return null;
  const pf = typeof partyOf === 'function' ? partyOf : defaultPartyOf;
  const lp = pf(avgResult.leader, race);
  if (lp !== 'A' && lp !== 'B') return null;
  const sign = lp === 'A' ? 1 : -1;
  return { margin: Number((sign * Math.abs(avgResult.margin)).toFixed(2)), leader_party: lp, leader: avgResult.leader, n_polls: avgResult.n_polls, source: 'polls' };
}

// race σ from poll support: more polls → tighter, floored so a single poll never claims false certainty.
function pollSigma(nPolls, priorSigma = PRIOR_SIGMA) { return Number(clamp(priorSigma - Math.min(nPolls, 6) * 0.5, 3.5, priorSigma).toFixed(2)); }

/**
 * LIVE — attach { margin, sigma, margin_source, n_polls } to each slate race.
 * getRacePolls(race) → normalized polls for that race (injected; e.g. votehub.fetchPolls by subject+poll_type).
 * Falls back to a neutral prior (cfg.priorMargin ?? 0, wide σ) when polls are absent or unattributable.
 */
async function computeMargins({ races, getRacePolls, ratings = [], partyOf = null, now = Date.now(), cfg = {}, priorSigma = PRIOR_SIGMA } = {}) {
  const out = [];
  for (const race of (Array.isArray(races) ? races : [])) {
    let margin = null, sigma = priorSigma, margin_source = 'prior', n_polls = 0;
    try {
      const polls = typeof getRacePolls === 'function' ? await getRacePolls(race) : [];
      if (polls && polls.length) {
        const a = avg.average(polls, { now, subject: race.subject, poll_type: race.poll_type, ratings, houseEffect: true, cfg });
        const signed = signMargin(a, race, partyOf);
        if (signed) { margin = signed.margin; n_polls = signed.n_polls; sigma = pollSigma(n_polls, priorSigma); margin_source = 'polls'; }
      }
    } catch { /* fail-soft → prior */ }
    if (margin == null) margin = cfg.priorMargin != null ? cfg.priorMargin : 0;
    out.push({ ...race, margin, sigma, margin_source, n_polls });
  }
  return out;
}

// PURE — the (event, race) pairs worth a gpt-oss direction call: only CORROBORATED events that TOUCH a race
// (mirrors the reactor's own shift gate, so we never spend a cloud call the reactor would ignore).
function buildAssessPairs(events, races, cfg = {}) {
  const c = { ...reactor.DEFAULTS, ...cfg };
  const pairs = [];
  for (const race of (Array.isArray(races) ? races : [])) {
    const ents = race.entities || [];
    for (const e of (Array.isArray(events) ? events : [])) {
      if ((e.corroboration || 0) >= c.minCorroborationForShift && reactor.eventTouchesRace(e, ents)) pairs.push({ event: e, race });
    }
  }
  return pairs;
}

// LIVE — pre-run the gpt-oss judgments (assessBatch) for the shift-eligible pairs → a SYNC lookup the reactor
// uses on its hot path. No `ask`/no pairs → an empty lookup (reactor falls back to volatility-only). Fail-safe.
async function preAssess({ events, races, ask, cfg = {}, concurrency = 4 } = {}) {
  const pairs = buildAssessPairs(events, races, cfg);
  if (!pairs.length || typeof ask !== 'function') return { lookup: () => null, map: {}, n_pairs: pairs.length, assessed: 0 };
  const { map, lookup } = await assess.assessBatch(pairs, { ask, concurrency });
  return { lookup, map, n_pairs: pairs.length, assessed: Object.keys(map).length };
}

// dedup + bound the entity set we scan news against (slate can be large; keep the news pass cheap).
function slateEntities(races, cap = 600) {
  const seen = new Set(), out = [];
  for (const r of (races || [])) for (const e of (r.entities || [])) { const k = String(e).toLowerCase(); if (e && !seen.has(k)) { seen.add(k); out.push(e); if (out.length >= cap) return out; } }
  return out;
}

/**
 * PURE + deterministic CORE — races(with margins) + news signals → the balance widget result.
 * react (news perturbs margin/σ) → correlated sim → balance payload + WORK. Inject `now`, `assessLookup`.
 * opts: { now, config, assessLookup, reactorCfg }
 */
function recompute(races, signals = {}, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const config = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
  const assessLookup = typeof opts.assessLookup === 'function' ? opts.assessLookup : null;
  const t0 = Date.now();
  const reacted = reactor.react(races, signals, { now, assess: assessLookup, cfg: opts.reactorCfg });
  const s = sim.simulate(reacted.races, config);
  const payload = service.buildBalancePayload(s, reacted.races, config);
  const timing_ms = Date.now() - t0;
  return {
    ok: true, model: 'balance_of_power',
    payload,
    live: (reacted.races || []).some((r) => r.live),
    moved: reacted.moved,
    work: {
      inputs: { config, races: reacted.races },
      sim: { chambers: s.chambers, iterations: s.iterations },
      signals: { events: (signals.events || []).length, momentum: (signals.momentum || []).length },
      timing_ms,
    },
  };
}

/**
 * LIVE — one full pass of the machine. Everything external is injected so this is the single call main.js's
 * cadence fires (and the smoke drives with fakes):
 *   fetchSubjects, getRacePolls, ratings, partyOf, resolve  — slate + margins
 *   newsEvents({startMs,entities,minCorroboration}), newsMomentum({sinceMs,entities})  — signals (default news_feed)
 *   ask  — cloud_logic.ask for gpt-oss direction judgments
 *   config, targetYear, pollTypes, reactorCfg, now
 * Returns the recompute() result + as_of + margins/assess/live-entity provenance for the inspector.
 */
async function runOnce(opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const config = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
  const targetYear = opts.targetYear !== undefined ? opts.targetYear : DEFAULT_TARGET_YEAR;

  // 1. SLATE — forecasting-local, built from its own connectors; chamber + (target) year filtered.
  let races = opts.races || await registry.fetchSlate({ fetchSubjects: opts.fetchSubjects, pollTypes: opts.pollTypes || ['us-senator', 'us-representative'] });
  races = (races || []).filter((r) => r && (r.chamber === 'house' || r.chamber === 'senate'));
  if (targetYear != null) races = races.filter((r) => { const y = registry.parseSubject(r.subject).year; return y == null || y === targetYear; });
  if (opts.resolve) races = await Promise.all(races.map((r) => registry.enrich(r, { resolve: opts.resolve })));   // read-only Echo enrichment
  if (!races.length) return { ok: false, model: 'balance_of_power', error: 'empty slate', payload: null };

  // 2. MARGINS — signed per-race poll averages (prior fallback).
  races = await computeMargins({ races, getRacePolls: opts.getRacePolls, ratings: opts.ratings, partyOf: opts.partyOf, now, cfg: opts.avgCfg || {}, priorSigma: opts.priorSigma });

  // 3. SIGNALS — the news_feed contract (compressed events + raw/CC momentum), scoped to the slate's entities.
  const entities = slateEntities(races);
  const events = opts.events || (typeof opts.newsEvents === 'function'
    ? opts.newsEvents({ startMs: opts.startMs || 0, entities, minCorroboration: 2 })
    : news.events({ startMs: opts.startMs || 0, entities, minCorroboration: 2 }));
  const momentum = opts.momentum || (typeof opts.newsMomentum === 'function'
    ? opts.newsMomentum({ sinceMs: opts.sinceMs || 0, entities })
    : news.momentum({ sinceMs: opts.sinceMs || 0, entities }));
  const signals = { events, momentum };

  // 4. PRE-ASSESS — gpt-oss direction for shift-eligible (event,race) pairs → sync lookup.
  const pa = await preAssess({ events, races, ask: opts.ask, cfg: opts.reactorCfg, concurrency: opts.concurrency });

  // 5. RECOMPUTE — react → sim → payload.
  const res = recompute(races, signals, { now, config, assessLookup: pa.lookup, reactorCfg: opts.reactorCfg });
  const polled = races.filter((r) => r.margin_source === 'polls').length;
  res.as_of = new Date(now).toISOString().slice(0, 10);
  res.illustrative = polled === 0;                 // no real signed margin anywhere → the run is illustrative
  res.work.margins = { total: races.length, polled, prior: races.length - polled };
  res.work.assess = { pairs: pa.n_pairs, assessed: pa.assessed };
  res.live_entities = reactor.detectLive(momentum, { cfg: opts.reactorCfg });
  return res;
}

module.exports = {
  DEFAULT_CONFIG, DEFAULT_TARGET_YEAR, PRIOR_SIGMA,
  defaultPartyOf, signMargin, pollSigma, computeMargins,
  buildAssessPairs, preAssess, slateEntities, recompute, runOnce,
  detectLive: reactor.detectLive,
};
