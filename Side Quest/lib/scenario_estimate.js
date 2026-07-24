/**
 * lib/scenario_estimate.js — Slice 1 of the Conditional Scenario Engine (docs/SCENARIO_ENGINE_DESIGN.md §4a).
 *
 * Turns a plain-English SHOCK ("Iran war hot on election day") into a race-level Effect[] the Slice-0 engine
 * can propagate. This is the ONE model-dependent piece: gpt-oss:120b judges DIRECTION/MAGNITUDE/breadth
 * (STRUCTURE), the engine computes the numbers. It lets the decider author NEW what-ifs beyond the fixed
 * lib/scenario_catalog — the catalog stays for canned, audited runs; this fills in effects on demand.
 *
 * Modeled on lib/forecast_assess: a PURE input builder + a PURE validator, an injected `ask` (cloud_logic.ask)
 * → fully offline-smokeable with a mocked ask. Fail-soft: no ask / bad output → { effects: [], error } → the
 * caller falls back (the catalog, or declines the run) — never a phantom scenario.
 *
 * HONESTY (design §6/§10): estimated numbers are WIDE-σ PRIORS, so magnitudes are CAPPED here (a model can't
 * assert a 30-point national swing); genuinely-ambiguous shocks must set direction_uncertain (the engine then
 * runs BOTH signs → a RANGE); the model may only name REAL geography (a Census region, a known zone, a valid
 * state, a chamber) — it cannot invent a region. Party A = Dem (margin +), B = Rep.
 */
'use strict';

const engine = require('./scenario_engine');
const regions = require('./regions');
const analogs = require('./scenario_analogs');

const MODEL = 'gpt-oss:120b-cloud';   // the reasoning model (forecast_assess convention)
const NUM_PREDICT = 1500;             // gpt-oss reliability floor — never the default 400
const MARGIN_CAP = 8;                 // |margin_delta| ceiling (points) — estimates are wide priors, not precise
const SIGMA_CAP = 5;                  // sigma_add ceiling (points)
const MAX_EFFECTS = 6;                // a shock decomposes into a handful of effects, not dozens

const CENSUS = ['Northeast', 'Midwest', 'South', 'West'];
const KNOWN_GROUPS = regions.knownGroups();                              // census regions + named zones
const ZONES = KNOWN_GROUPS.filter((g) => !CENSUS.includes(g));

// PURE — a compact seat-universe summary for the prompt: chamber sizes + competitive counts, per-region mix.
function summarizeUniverse(races, { competitiveThreshold = engine.DEFAULT_COMPETITIVE_PTS } = {}) {
  const chambers = {}; const regionMix = {}; let competitiveTotal = 0;
  for (const r of (races || [])) {
    const ch = r.chamber || 'unknown';
    (chambers[ch] = chambers[ch] || { total: 0, competitive: 0 }).total++;
    const isComp = engine.raceIsCompetitive(r, competitiveThreshold);
    if (isComp) { chambers[ch].competitive++; competitiveTotal++; }
    const ab = engine.stateAbbrOf(r); const reg = ab ? regions.regionOf(ab) : null;
    if (reg) { (regionMix[reg] = regionMix[reg] || { total: 0, competitive: 0 }).total++; if (isComp) regionMix[reg].competitive++; }
  }
  return { chambers, regions: regionMix, competitiveTotal, competitiveThreshold };
}

// PURE — render the universe as prompt text.
function universeText(u) {
  const chs = Object.entries(u.chambers).map(([ch, c]) => `${ch} ${c.total} seats (${c.competitive} competitive)`).join('; ');
  const regs = Object.entries(u.regions).map(([r, c]) => `${r} ${c.competitive}/${c.total}`).join(', ');
  return `Chambers — ${chs}. Competitive (|margin|≤${u.competitiveThreshold} pts) by Census region — ${regs || 'n/a'}. Named thematic zones you may target: ${ZONES.join(', ')}.`;
}

const ESTIMATE_WANT = `You translate a hypothetical political SHOCK into its estimated effects on the 2026 U.S. races.
Party A = Democrats, Party B = Republicans. margin > 0 = Party A (Dem) ahead.

Given the SHOCK and the SEAT UNIVERSE, output the race-level effects it would have. Each effect targets a GROUP
of seats and gives a margin shift (points, signed toward Dem + / Rep −) plus ADDED volatility (uncertainty rises
under any shock). Be HONEST and UNCERTAIN: if the partisan DIRECTION is genuinely ambiguous (rally-round-flag vs.
backlash), set "direction_uncertain":true and keep magnitude modest — do NOT pick a confident side.

Respond with ONLY a JSON ARRAY of 1..${MAX_EFFECTS} effects, nothing else:
[{"scope":"national|region|state|seatType","value":"<region/zone name, 2-letter state, or chamber; omit for national>",
  "competitiveOnly":true|false,"margin_delta":<points, signed toward Dem+ / Rep−>,"sigma_add":<added σ, ≥0>,
  "analog":"<the closest historical-analog category>","direction_uncertain":true|false,"rationale":"<one clause>","confidence":<0..1>}]
- Prefer competitiveOnly:true — a shock changes control through the CLOSE seats.
- A "region" value MUST be one of: __GROUPS__. A "state" value is a 2-letter USPS code. "seatType" is house|senate.
__ANALOGS__
- Magnitudes are WIDE-UNCERTAINTY PRIORS — modest, provisional, and bounded by the analog above; never precise.`;

// PURE — parse/validate the model output → { valid, value: Effect[] } (cloud_logic.ask contract). Drops any
// malformed/invalid effect (bad scope, invented region, no-op); caps magnitudes; fails if nothing survives.
function validateEffects(raw) {
  try {
    const m = String(raw == null ? '' : raw).match(/\[[\s\S]*\]/);
    if (!m) return { valid: false, error: 'no json array' };
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr) || !arr.length) return { valid: false, error: 'empty array' };
    const effects = [];
    for (const e of arr.slice(0, MAX_EFFECTS)) {
      if (!e || typeof e !== 'object') continue;
      const scope = ['national', 'region', 'state', 'seatType'].includes(e.scope) ? e.scope : null;
      if (!scope) continue;
      const value = e.value != null ? String(e.value).trim() : null;
      if (scope === 'region' && !regions.statesIn(value).size) continue;            // must name a REAL region/zone
      if (scope === 'state' && !regions.regionOf(value)) continue;                  // must be a valid USPS abbr
      if (scope === 'seatType' && !['house', 'senate', 'governor'].includes(String(value).toLowerCase())) continue;
      // Slice 4: cap magnitudes to the effect's HISTORICAL ANALOG ceiling (unknown/absent → 'generic'
      // fallback), so the model can't assert an implausible swing. capMagnitude never leaves one uncapped.
      const cap = analogs.capMagnitude(e.margin_delta, e.sigma_add, e.analog);
      if (cap.margin_delta === 0 && cap.sigma_add === 0) continue;                   // a no-op effect
      const norm = engine.normalizeEffect({
        selector: { scope, value: scope === 'national' ? null : value, competitiveOnly: !!e.competitiveOnly },
        margin_delta: cap.margin_delta, sigma_add: cap.sigma_add, direction_uncertain: !!e.direction_uncertain,
        rationale: String(e.rationale || '').slice(0, 200), confidence: e.confidence,
      });
      if (norm) { norm.analog = cap.analog; norm.capped = cap.capped; effects.push(norm); }
    }
    if (!effects.length) return { valid: false, error: 'no usable effects after validation' };
    return { valid: true, value: effects };
  } catch (e) { return { valid: false, error: e.message }; }
}

// Estimate a shock's Effect[] via the injected `ask`. → { effects, error }. Fail-soft (never throws).
async function estimateEffects({ description, races = [], ask, competitiveThreshold } = {}) {
  if (typeof ask !== 'function') return { effects: [], error: 'no ask (cloud unavailable)' };
  const desc = String(description == null ? '' : description).trim();
  if (!desc) return { effects: [], error: 'no description' };
  const want = ESTIMATE_WANT.replace('__GROUPS__', KNOWN_GROUPS.join(', ')).replace('__ANALOGS__', analogs.promptGuidance());
  try {
    const v = await ask({
      task: 'scenario_estimate_effects', v: 1,
      input: { shock: desc, universe: universeText(summarizeUniverse(races, { competitiveThreshold })) },
      want, validate: validateEffects, model: MODEL, numPredict: NUM_PREDICT,
    });
    if (!v || !v.length) return { effects: [], error: 'estimator returned no usable effects' };
    return { effects: v, error: null };
  } catch (e) { return { effects: [], error: e.message }; }
}

// Estimate + wrap into a runnable Scenario (via the engine's schema). → { scenario, error }. null scenario on failure.
async function buildScenarioFromDescription({ description, races = [], ask, competitiveThreshold, id } = {}) {
  const { effects, error } = await estimateEffects({ description, races, ask, competitiveThreshold });
  if (!effects.length) return { scenario: null, error };
  const scenario = engine.makeScenario({
    id: id || undefined, name: String(description).slice(0, 80), description: String(description),
    effects, estimated_by: MODEL,
  });
  return { scenario, error: null };
}

module.exports = { MODEL, NUM_PREDICT, MARGIN_CAP, SIGMA_CAP, MAX_EFFECTS, summarizeUniverse, universeText, ESTIMATE_WANT, validateEffects, estimateEffects, buildScenarioFromDescription };
