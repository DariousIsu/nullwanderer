/**
 * lib/forecast_fundamentals.js — the FUNDAMENTALS leg of the machine: the national ECONOMIC ENVIRONMENT →
 * a uniform swing prior. This is the api_stream consumer the suite was missing (Lucas: "nothing consumes
 * api_stream"). It reads econ_feed (which reads api_stream) and scores whether the economy currently HELPS or
 * HURTS the incumbent party, emitting a single national `lean` (points toward party A=Dem) that shifts EVERY
 * race's margin uniformly — the correlated, environment-wide effect, as opposed to forecast_reactor's per-race
 * NEWS shocks. Economy strong → helps the sitting president's party; inflation/unemployment high or rising →
 * hurts it (the standard economic-voting direction).
 *
 * HONESTY GUARD-RAILS (same law as the reactor — this is R&D, no faked precision): every weight/neutral below
 * is a TUNABLE PRIOR, not a validated coefficient — the calibration harness scores whether it helps. The total
 * lean is hard-CAPPED small (`envCap`) because the economy explains only a MODEST slice of a race; each
 * adjustment is `provisional` (a fresh poll overrides it) and fully AUDITED (every component's contribution +
 * the raw reading → the parts→whole transparency the studio renders). PURE `scoreEnvironment`/`applyToSlate`
 * cores → offline-testable; live `assess` injects `getSnapshot`. No data → lean 0 (never a phantom swing).
 */
'use strict';

const econ = require('./econ_feed');

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2 = (x) => Math.round(x * 100) / 100;

// A=Dem, B=Rep (the reactor's convention). incumbentParty = the sitting president's party for the cycle.
const DEFAULTS = {
  gdpNeutral: 4.0, gdpWeight: 0.25,        // nominal-GDP YoY%: each pt above neutral → +incumbent
  cpiNeutral: 2.5, cpiWeight: 0.30,        // CPI YoY% (inflation): each pt above neutral → −incumbent
  unrateNeutral: 4.5, unrateWeight: 0.40,  // unemployment LEVEL: each pt above neutral → −incumbent
  unrateTrendWeight: 0.60,                 // rising unemployment (90-day Δpts) → −incumbent
  yieldTrendWeight: 0.15,                  // rising 10-yr yield (90-day Δpts, tightening) → −incumbent
  perComponentCap: 1.5,                    // max |points| any single indicator can contribute
  envCap: 3.0,                             // max |national environment lean| (points) — economy is a MODEST slice
  neutralBand: 0.2,                        // |lean| below this reads as 'neutral'
  incumbentParty: 'B',                     // 2026 cycle: sitting president is Republican
};

/**
 * PURE — the econ_feed environment ({gdp,cpi,unrate,fedfunds,dgs10}) → the national environment score.
 * Returns { lean (points toward A=Dem, capped, signed), favors:'A'|'B'|'neutral', magnitude, incumbent_score,
 *           components:[{name, points_incumbent, note}], provisional, has_data }.
 */
function scoreEnvironment(env = {}, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const components = [];
  let inc = 0;   // points favoring the INCUMBENT party (pre-sign-to-A)
  const add = (name, raw, note) => {
    const v = clamp(raw, -c.perComponentCap, c.perComponentCap);
    components.push({ name, points_incumbent: r2(v), note });
    inc += v;
  };

  const { gdp, cpi, unrate: un, dgs10: y } = env || {};
  if (gdp && gdp.yoyPct != null) add('gdp_growth', (gdp.yoyPct - c.gdpNeutral) * c.gdpWeight, `GDP YoY ${gdp.yoyPct}% vs ${c.gdpNeutral}% neutral`);
  if (cpi && cpi.yoyPct != null) add('inflation', -(cpi.yoyPct - c.cpiNeutral) * c.cpiWeight, `CPI YoY ${cpi.yoyPct}% vs ${c.cpiNeutral}% neutral`);
  if (un && un.value != null) add('unemployment_level', -(un.value - c.unrateNeutral) * c.unrateWeight, `unrate ${un.value}% vs ${c.unrateNeutral}% neutral`);
  if (un && un.trendAbs != null) add('unemployment_trend', -un.trendAbs * c.unrateTrendWeight, `unrate 90-day Δ ${un.trendAbs}pts`);
  if (y && y.trendAbs != null) add('yield_trend', -y.trendAbs * c.yieldTrendWeight, `10-yr 90-day Δ ${y.trendAbs}pts`);

  const incScore = clamp(inc, -c.envCap, c.envCap);
  const lean = (c.incumbentParty === 'A' ? 1 : -1) * incScore;   // sign to party A (Dem)
  const favors = lean > c.neutralBand ? 'A' : (lean < -c.neutralBand ? 'B' : 'neutral');
  const magnitude = Math.abs(lean) >= 2 ? 'large' : (Math.abs(lean) >= 1 ? 'medium' : 'small');
  return {
    lean: r2(lean), favors, magnitude, incumbentParty: c.incumbentParty,
    incumbent_score: r2(incScore), components,
    provisional: true, has_data: components.length > 0,
  };
}

/**
 * PURE — apply the national lean UNIFORMLY to every race margin (the correlated environment shift). Records
 * `env_delta` + `base_margin_pre_env` on each race for the audit. lean 0 / no score → margins untouched.
 */
function applyToSlate(races, score, _cfg = {}) {
  const lean = score && Number.isFinite(score.lean) ? score.lean : 0;
  return (Array.isArray(races) ? races : []).map((r) => (lean
    ? { ...r, base_margin_pre_env: r.margin, margin: Number((r.margin + lean).toFixed(3)), env_delta: Number(lean.toFixed(3)) }
    : { ...r, env_delta: 0 }));
}

// LIVE — read the environment (via api_stream.getSnapshot) + score it. Fail-soft → no-data score (lean 0).
function assess({ getSnapshot, cfg = {}, incumbentParty } = {}) {
  try {
    const env = econ.environment({ getSnapshot });
    return scoreEnvironment(env, { ...(cfg || {}), ...(incumbentParty ? { incumbentParty } : {}) });
  } catch {
    return { lean: 0, favors: 'neutral', magnitude: 'small', incumbentParty: (cfg && cfg.incumbentParty) || DEFAULTS.incumbentParty, incumbent_score: 0, components: [], provisional: true, has_data: false };
  }
}

module.exports = { DEFAULTS, scoreEnvironment, applyToSlate, assess };
