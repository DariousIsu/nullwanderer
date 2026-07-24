/**
 * lib/scenario_catalog.js — a small CURATED catalog of hypothetical shocks the autonomy decider can ELECT
 * to run against the live forecast (the "scenario" work-move — F3's other half). Slice 0 gave the pure
 * engine; this gives the decider a set of HAND-AUTHORED, AUDITABLE what-ifs to run without a cloud estimator
 * (the gpt-oss estimator is Slice 1). Every effect here is hand-written with a rationale + confidence — a
 * NAMED, auditable map, never model-invented (design §10). Genuinely-ambiguous shocks carry
 * `direction_uncertain` so the engine runs BOTH signs and the readout is a RANGE (design §6 honesty).
 *
 * The move is illustrative ONLY: a run lands as a labeled-hypothetical READING, never merged into the
 * baseline forecast and never memorialized as fact.
 *
 * PURE. Deps: scenario_engine (makeScenario + run shape). No I/O.
 */
'use strict';

const engine = require('./scenario_engine');

// The catalog. Keep it SMALL, named, and hand-tuned; add a scenario deliberately, not per run.
const _RAW = [
  {
    id: 'iran-war-hot', name: 'Iran war hot during voting',
    description: 'A national-security shock of genuinely ambiguous partisan direction on election day.',
    intensity: 1,
    effects: [
      // Ambiguous direction (rally-round-flag toward the incumbent party vs. war-fatigue against it) →
      // direction_uncertain forces a two-sided RANGE. Volatility rises everywhere.
      { selector: { scope: 'national' }, margin_delta: 2.5, sigma_add: 2, direction_uncertain: true,
        rationale: 'rally-round-flag vs. war-fatigue — sign genuinely unknown; run both', confidence: 0.3 },
      // Extra volatility concentrated in competitive seats (where a swing actually flips control).
      { selector: { scope: 'national', competitiveOnly: true }, margin_delta: 0, sigma_add: 1.5,
        rationale: 'competitive seats absorb the most uncertainty under a national shock', confidence: 0.4 },
    ],
  },
  {
    id: 'wildfire-brownouts', name: 'Wildfire brownouts break through the heat',
    description: 'A western wildfire + grid-strain event that punishes the incumbent party in competitive western seats.',
    intensity: 1,
    effects: [
      { selector: { scope: 'region', value: 'fire-west', competitiveOnly: true }, margin_delta: -4, sigma_add: 2,
        rationale: 'competence/incumbent penalty concentrated in the affected western footprint', confidence: 0.4 },
    ],
  },
  {
    id: 'rust-belt-plant-closures', name: 'Rust-belt plant closures late in the cycle',
    description: 'A wave of industrial-Midwest layoffs that sours the economic mood across the rust belt.',
    intensity: 1,
    effects: [
      { selector: { scope: 'region', value: 'rust-belt', competitiveOnly: true }, margin_delta: -3, sigma_add: 1.5,
        direction_uncertain: true,
        rationale: 'economic pain punishes the incumbent party, but which party owns the plants is contested → two-sided', confidence: 0.35 },
    ],
  },
];

// Build the frozen Scenario objects once (via the engine's normalizer).
const _CATALOG = _RAW.map((r) => engine.makeScenario({ id: r.id, name: r.name, description: r.description, intensity: r.intensity, effects: r.effects, estimated_by: 'catalog:hand-authored' }));
const _BY_ID = new Map(_CATALOG.map((s) => [s.id, s]));

function list() { return _CATALOG.map((s) => ({ id: s.id, name: s.name, description: s.description, two_sided: s.effects.some((e) => e.direction_uncertain) })); }
function get(id) { return _BY_ID.get(String(id || '').trim()) || null; }
function ids() { return _CATALOG.map((s) => s.id); }

function _pct(p) { return `${Math.round((Number(p) || 0) * 100)}%`; }

// One honest, labeled-hypothetical READING line from a runScenario result. Never asserts fact.
function summarize(scenario, run) {
  const head = `[Hypothetical — illustrative only, NOT a forecast] "${scenario.name}": ${scenario.description}`;
  const chamberLine = (ch, base, scn) => {
    const b = base && base[ch], s = scn && scn[ch];
    if (!b || !s) return null;
    return `P(Dem ${ch}) ${_pct(b.pA_control)} → ${_pct(s.pA_control)} (Δ ${((s.pA_control - b.pA_control) * 100).toFixed(1)} pts)`;
  };
  if (run.two_sided) {
    const parts = [];
    for (const ch of ['house', 'senate']) {
      const b = run.base.chambers && run.base.chambers[ch];
      const p = run.positive.sim.chambers && run.positive.sim.chambers[ch];
      const n = run.negative.sim.chambers && run.negative.sim.chambers[ch];
      if (b && p && n) parts.push(`P(Dem ${ch}) baseline ${_pct(b.pA_control)} → RANGE ${_pct(Math.min(p.pA_control, n.pA_control))}–${_pct(Math.max(p.pA_control, n.pA_control))} (direction ambiguous — shown as a band, not a point)`);
    }
    const flips = (run.positive.delta.flips.length || run.negative.delta.flips.length)
      ? ` Up to ${Math.max(run.positive.delta.flips.length, run.negative.delta.flips.length)} seat(s) could cross depending on which way it breaks.` : '';
    return `${head}\n${parts.join(' · ')}.${flips} (${scenario.effects.length} hand-authored effect(s); two-sided honesty rail active.)`;
  }
  const parts = ['house', 'senate'].map((ch) => chamberLine(ch, run.base.chambers, run.sim.chambers)).filter(Boolean);
  const flips = run.delta.flips.length
    ? ` Seats that flip (point estimate): ${run.delta.flips.map((f) => `${f.id.split(':')[0]} → ${f.toward}`).slice(0, 8).join(', ')}.` : ' No seats cross at the point estimate.';
  return `${head}\n${parts.join(' · ')}.${flips} (${scenario.effects.length} hand-authored effect(s), audited.)`;
}

// A compact one-line outcome for the autonomy history ledger.
function outcomeLine(scenario, run) {
  if (run.two_sided) {
    const h = run.base.chambers && run.base.chambers.house;
    return `ran ${scenario.id} (two-sided) — P(Dem House) baseline ${h ? _pct(h.pA_control) : '?'}, shown as a range`;
  }
  const h = run.delta.chambers && run.delta.chambers.house;
  return `ran ${scenario.id} — Δ P(Dem House) ${h ? (h.dP_control * 100).toFixed(1) + ' pts' : '?'}, ${run.delta.flips.length} flip(s)`;
}

module.exports = { list, get, ids, summarize, outcomeLine };
