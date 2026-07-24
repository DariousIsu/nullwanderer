/**
 * lib/scenario_engine.js — the CONDITIONAL SCENARIO ENGINE core (docs/SCENARIO_ENGINE_DESIGN.md, Slice 0).
 *
 * Turns the forecast machine from a NOWCAST into a WORLD-MODEL: assert a hypothetical shock ("Iran war hot
 * on election day", "wildfire brownouts break through the heat"), propagate it through the race slate with
 * grounded-but-honestly-uncertain magnitudes, replay the election under that assumption, and show the DELTA
 * vs. baseline. This file is the PURE propagation core — the deepest-testable piece, ZERO cloud dependency
 * (§8 Slice 0). The gpt-oss effect ESTIMATOR (description → effects) is Slice 1, separate.
 *
 * A scenario reuses the sim's PERTURBATION primitive: the reactor already perturbs a race's margin/σ from a
 * news event; a scenario is the same op with an ASSERTED shock. Everything here is:
 *   • ISOLATED + ILLUSTRATIVE — never merged into the live baseline, never written to the 24h memory rail
 *     as fact. A what-if lens, labeled as one (status='hypothetical').
 *   • DETERMINISTIC — baseline and scenario sims run on the SAME seed, so the delta is the SHOCK, not sim
 *     noise (§6).
 *   • HONEST — a genuinely ambiguous shock (rally-round-flag vs. war-fatigue) runs BOTH signs and is read as
 *     a RANGE, never one confident number (`direction_uncertain`, §6).
 *
 * SIGN CONVENTION (matches forecast_sim + the design §3): margin is party-A's lead in points, party-A = Dem,
 * so margin > 0 = Dem ahead; an effect's `margin_delta` is signed toward Dem(+) / Rep(−).
 *
 * PURE + offline-smokeable. Deps: forecast_sim (simulate + marginToWinProb), forecast_registry (STATE_ABBR),
 * regions (state→region/zone). No Echo, no cloud, no I/O.
 */
'use strict';

const { simulate, marginToWinProb } = require('./forecast_sim');
const regions = require('./regions');
let STATE_ABBR = {};
try { STATE_ABBR = require('./forecast_registry').STATE_ABBR || {}; } catch { STATE_ABBR = {}; }

const SCENARIO_STATUS = 'hypothetical';
const DEFAULT_COMPETITIVE_PTS = 6;     // a seat is "competitive" when |margin| ≤ this (points)
const DEFAULT_SIGMA = 5;               // the sim's defaultSigma — the base a sigma_add raises from when a race omits sigma

function _clamp01(x) { const n = Number(x); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }
function _slug(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'scenario'; }

// A seat's USPS state abbr, derived from its geo ('AZ-06'|'AZ'|place) or its state (abbr or full name). null if unknown.
function stateAbbrOf(race) {
  if (!race) return null;
  const g = String(race.geo || '').toUpperCase();
  const gm = g.match(/^([A-Z]{2})(?:[-\s]\d+)?$/);
  if (gm && regions.regionOf(gm[1])) return gm[1];
  const st = String(race.state || '').trim();
  if (st.length === 2 && regions.regionOf(st.toUpperCase())) return st.toUpperCase();
  const ab = STATE_ABBR[st.toLowerCase()];
  if (ab) return ab;
  return null;
}

function raceIsCompetitive(race, thr = DEFAULT_COMPETITIVE_PTS) { return Math.abs(Number(race && race.margin) || 0) <= thr; }

// Does a seat match an effect's selector? scope ∈ national | seatType | state | region. `competitiveOnly`
// narrows to close seats. `region` value may name a Census region OR a thematic zone (regions.statesIn).
function matchesSelector(race, selector, opts = {}) {
  if (!race || !selector || !selector.scope) return false;
  const thr = opts.competitiveThreshold != null ? opts.competitiveThreshold : DEFAULT_COMPETITIVE_PTS;
  let base;
  switch (selector.scope) {
    case 'national': base = true; break;
    case 'seatType': base = String(race.chamber) === String(selector.value) || String(race.seatType || '') === String(selector.value); break;
    case 'state': { const a = stateAbbrOf(race); base = !!a && a === String(selector.value || '').toUpperCase(); break; }
    case 'region': { const a = stateAbbrOf(race); base = !!a && regions.statesIn(selector.value).has(a); break; }
    default: base = false;
  }
  if (!base) return false;
  return selector.competitiveOnly ? raceIsCompetitive(race, thr) : true;
}

// Normalize one raw effect to the frozen schema shape. Returns null if it has no usable selector.
function normalizeEffect(e) {
  if (!e || !e.selector || !e.selector.scope) return null;
  return {
    selector: {
      scope: e.selector.scope,
      value: e.selector.value != null ? e.selector.value : null,
      competitiveOnly: !!e.selector.competitiveOnly,
    },
    margin_delta: Number(e.margin_delta) || 0,
    sigma_add: Math.max(0, Number(e.sigma_add) || 0),
    correlation: e.correlation || null,          // carried through; the correlated-swing wiring is Slice 2
    direction_uncertain: !!e.direction_uncertain,
    rationale: e.rationale || '',
    confidence: e.confidence != null ? _clamp01(e.confidence) : null,
  };
}

// Build a well-formed Scenario object (schema §3). Effects are normalized + frozen-in for audit/reproducibility.
function makeScenario({ id, name, description, intensity = 1, direction_hint = 'auto', effects = [], estimated_by = null, estimated_at = null, notes = null } = {}) {
  return {
    id: id || _slug(name || 'scenario'),
    name: name || id || 'scenario',
    description: description || '',
    status: SCENARIO_STATUS,
    assumptions: { intensity: _clamp01(intensity), direction_hint },
    effects: (Array.isArray(effects) ? effects : []).map(normalizeEffect).filter(Boolean),
    estimated_by, estimated_at, notes,
  };
}

/**
 * applyScenario(races, scenario, opts) → a NEW race slate with each matching effect's margin_delta / sigma_add
 * applied (pure — the baseline slate is never mutated). intensity scales every magnitude. `signFlip` inverts
 * the margin_delta sign (used by runScenario's two-sided honesty pass). A seat touched by ≥1 effect carries a
 * `_scenario` audit stamp. opts: { competitiveThreshold, defaultSigma, signFlip }.
 */
function applyScenario(races, scenario, opts = {}) {
  const competitiveThreshold = opts.competitiveThreshold != null ? opts.competitiveThreshold : DEFAULT_COMPETITIVE_PTS;
  const defaultSigma = opts.defaultSigma != null ? opts.defaultSigma : DEFAULT_SIGMA;
  const intensity = _clamp01(scenario && scenario.assumptions && scenario.assumptions.intensity != null ? scenario.assumptions.intensity : 1);
  const sign = opts.signFlip ? -1 : 1;
  const effects = (scenario && Array.isArray(scenario.effects)) ? scenario.effects : [];
  return (races || []).map((r0) => {
    const r = { ...r0 };
    let mDelta = 0, sAdd = 0, hit = 0;
    for (const e of effects) {
      if (!matchesSelector(r0, e.selector, { competitiveThreshold })) continue;
      mDelta += (Number(e.margin_delta) || 0) * intensity * sign;
      sAdd += Math.max(0, Number(e.sigma_add) || 0) * intensity;
      hit++;
    }
    if (hit) {
      if (mDelta !== 0) r.margin = Number(((Number(r0.margin) || 0) + mDelta).toFixed(3));
      if (sAdd > 0) r.sigma = Number((((r0.sigma != null ? Number(r0.sigma) : defaultSigma)) + sAdd).toFixed(3));
      r._scenario = { margin_delta: Number(mDelta.toFixed(3)), sigma_add: Number(sAdd.toFixed(3)), effects: hit };
    }
    return r;
  });
}

/**
 * buildScenarioDelta(baseSim, scnSim, { baseRaces, appliedRaces }) → the comparative payload (§6):
 *  chambers[ch]: Δ P(A control), Δ seat mean, Δ seat p10/p90 · flips[]: seats whose POINT-ESTIMATE winner
 *  changed (with before/after margin + win-prob) · scenarioDeltas[]: Δ probability of each joint-control label.
 * PURE — two sim outputs (+ the two race slates for the flip list) in, a delta out.
 */
function buildScenarioDelta(baseSim, scnSim, { baseRaces = [], appliedRaces = [] } = {}) {
  const bch = (baseSim && baseSim.chambers) || {};
  const sch = (scnSim && scnSim.chambers) || {};
  const chambers = {};
  for (const ch of new Set([...Object.keys(bch), ...Object.keys(sch)])) {
    const b = bch[ch] || {}, s = sch[ch] || {};
    chambers[ch] = {
      dP_control: Number(((s.pA_control || 0) - (b.pA_control || 0)).toFixed(4)),
      base_pA_control: b.pA_control != null ? b.pA_control : null,
      scn_pA_control: s.pA_control != null ? s.pA_control : null,
      dSeats_mean: Number(((s.seatsA_mean || 0) - (b.seatsA_mean || 0)).toFixed(2)),
      dSeats_p10: (s.seatsA_p10 || 0) - (b.seatsA_p10 || 0),
      dSeats_p90: (s.seatsA_p90 || 0) - (b.seatsA_p90 || 0),
    };
  }
  // FLIP list — seats whose point-estimate winner changed sign, baseline → scenario.
  const appliedById = new Map((appliedRaces || []).map((r) => [r.id, r]));
  const flips = [];
  for (const b of (baseRaces || [])) {
    const a = appliedById.get(b.id);
    if (!a) continue;
    const bm = Number(b.margin) || 0, am = Number(a.margin) || 0;
    if ((bm > 0) !== (am > 0) && bm !== am) {
      flips.push({
        id: b.id, chamber: b.chamber, state: b.state || null,
        before_margin: Number(bm.toFixed(2)), after_margin: Number(am.toFixed(2)),
        before_pA: Number(marginToWinProb(bm, b.sigma != null ? Number(b.sigma) : DEFAULT_SIGMA).toFixed(3)),
        after_pA: Number(marginToWinProb(am, a.sigma != null ? Number(a.sigma) : DEFAULT_SIGMA).toFixed(3)),
        toward: am > bm ? 'A/Dem' : 'B/Rep',
      });
    }
  }
  // joint-control label deltas (e.g. "house:A | senate:B")
  const probMap = (sim) => { const m = {}; for (const s of (sim && sim.scenarios) || []) m[s.label] = s.prob; return m; };
  const bl = probMap(baseSim), sl = probMap(scnSim);
  const scenarioDeltas = [...new Set([...Object.keys(bl), ...Object.keys(sl)])]
    .map((label) => ({ label, base_prob: bl[label] || 0, scn_prob: sl[label] || 0, dProb: Number(((sl[label] || 0) - (bl[label] || 0)).toFixed(4)) }))
    .sort((x, y) => Math.abs(y.dProb) - Math.abs(x.dProb));
  return { chambers, flips, scenarioDeltas };
}

/**
 * runScenario(races, scenario, opts) → the full COMPARATIVE run. Baseline sim + scenario sim on the SAME seed
 * (so the delta is the shock, not noise). If ANY effect is `direction_uncertain`, runs BOTH signs and returns
 * a two-sided result to be read as a RANGE (§6 honesty). opts is passed straight to simulate (seed, iterations,
 * nationalSigma, holdovers, majority, defaultSigma) plus competitiveThreshold for selector resolution.
 */
function runScenario(races, scenario, opts = {}) {
  const simOpts = { ...opts };
  const applyOpts = {
    competitiveThreshold: opts.competitiveThreshold != null ? opts.competitiveThreshold : DEFAULT_COMPETITIVE_PTS,
    defaultSigma: opts.defaultSigma != null ? opts.defaultSigma : DEFAULT_SIGMA,
  };
  const base = simulate(races, simOpts);
  const twoSided = !!(scenario && Array.isArray(scenario.effects) && scenario.effects.some((e) => e && e.direction_uncertain));
  if (twoSided) {
    const posRaces = applyScenario(races, scenario, { ...applyOpts, signFlip: false });
    const negRaces = applyScenario(races, scenario, { ...applyOpts, signFlip: true });
    const posSim = simulate(posRaces, simOpts);
    const negSim = simulate(negRaces, simOpts);
    return {
      status: SCENARIO_STATUS, scenario_id: scenario.id, two_sided: true, base,
      positive: { applied: posRaces, sim: posSim, delta: buildScenarioDelta(base, posSim, { baseRaces: races, appliedRaces: posRaces }) },
      negative: { applied: negRaces, sim: negSim, delta: buildScenarioDelta(base, negSim, { baseRaces: races, appliedRaces: negRaces }) },
      note: 'direction genuinely ambiguous → BOTH signs run; read the two deltas as a RANGE, never a point',
    };
  }
  const applied = applyScenario(races, scenario, applyOpts);
  const sim = simulate(applied, simOpts);
  return { status: SCENARIO_STATUS, scenario_id: scenario.id, two_sided: false, base, applied, sim, delta: buildScenarioDelta(base, sim, { baseRaces: races, appliedRaces: applied }) };
}

module.exports = {
  SCENARIO_STATUS, DEFAULT_COMPETITIVE_PTS,
  stateAbbrOf, raceIsCompetitive, matchesSelector, normalizeEffect, makeScenario,
  applyScenario, buildScenarioDelta, runScenario,
};
