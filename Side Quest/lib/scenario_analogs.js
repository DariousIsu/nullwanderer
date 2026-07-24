/**
 * lib/scenario_analogs.js — Slice 4 of the Conditional Scenario Engine (docs/SCENARIO_ENGINE_DESIGN.md §6/§10).
 *
 * Estimated shock magnitudes are the WEAKEST link — a model asked "how big is an Iran-war shock?" could assert
 * a 30-point national swing. We can't backtest a hypothetical, but we CAN bound its magnitude against the
 * HISTORICAL ANALOG record: how big real rally / disaster / economic / scandal effects actually run. These are
 * SANITY CAPS, not point estimates — illustrative ceilings drawn from the empirical political-science record,
 * kept as a SMALL, NAMED, AUDITABLE map (each carries its basis in `note`), never model-invented per run (§10).
 *
 * margin_cap = the plausible ceiling on |margin_delta| (points); sigma_cap = the ceiling on added per-seat σ.
 * 'generic' is the fallback for an unclassified shock — the engine-wide provisional ceiling, so a magnitude is
 * NEVER left uncapped. PURE, no deps.
 */
'use strict';

const ANALOGS = {
  'rally-round-flag': { label: 'security rally (incumbent-party boost)', margin_cap: 5, sigma_cap: 4,
    note: 'Rally-round-the-flag effects on VOTE margin are usually small (~2–5 pts) and decay within weeks; post-9/11 approval was an outlier and still faded. Genuinely two-sided vs. war-fatigue.' },
  'war-fatigue': { label: 'protracted/unpopular war (incumbent-party drag)', margin_cap: 5, sigma_cap: 4,
    note: 'A drawn-out or unpopular war erodes the incumbent party by a few points, not a landslide.' },
  'disaster-penalty': { label: 'natural-disaster incumbent penalty', margin_cap: 5, sigma_cap: 3,
    note: 'Retrospective-voting research (drought/flood findings) shows a mostly-localized penalty of a few points for perceived mishandling.' },
  'economic-shock': { label: 'economic downturn (incumbent drag)', margin_cap: 6, sigma_cap: 4,
    note: 'Fundamentals models put a bad economy at ~a few points nationally; a sharp shock somewhat more, still bounded well short of a blowout.' },
  'scandal': { label: 'scandal (implicated-party drag)', margin_cap: 4, sigma_cap: 3,
    note: 'A scandal typically costs the implicated party a few points among persuadables, rarely more.' },
  'generic': { label: 'unclassified shock', margin_cap: 8, sigma_cap: 5,
    note: 'No matching analog — falls back to the engine-wide provisional ceiling.' },
};

// The analog keys a shock may be classified as (excludes the 'generic' fallback) — for the estimator prompt + validation.
function analogKeys() { return Object.keys(ANALOGS).filter((k) => k !== 'generic'); }
function analogOf(key) { return ANALOGS[String(key == null ? '' : key).toLowerCase()] || null; }

// Clamp an effect's magnitudes to its analog's historical ceiling. Unknown/absent analog → 'generic' (the
// engine-wide ceiling), so nothing is EVER left uncapped. Returns { margin_delta, sigma_add, analog, capped }.
function capMagnitude(margin_delta, sigma_add, analogKey) {
  const known = analogOf(analogKey);
  const a = known || ANALOGS.generic;
  const md0 = Number(margin_delta) || 0, sa0 = Math.max(0, Number(sigma_add) || 0);
  const md = Math.max(-a.margin_cap, Math.min(a.margin_cap, md0));
  const sa = Math.min(a.sigma_cap, sa0);
  return { margin_delta: md, sigma_add: sa, analog: known ? String(analogKey).toLowerCase() : 'generic', capped: (md !== md0 || sa !== sa0) };
}

// One-line guidance block for the estimator prompt — the named analogs + their ceilings, so the model estimates
// WITHIN the historical envelope (and tags each effect so validation can enforce the right ceiling).
function promptGuidance() {
  const lines = analogKeys().map((k) => `  • ${k}: |margin| ≤ ${ANALOGS[k].margin_cap} pts, σ+ ≤ ${ANALOGS[k].sigma_cap} — ${ANALOGS[k].label}`);
  return `Bound every magnitude to its HISTORICAL ANALOG (real effects are modest; these are ceilings, not targets). Tag each effect with the closest "analog":\n${lines.join('\n')}\n  • (anything else → generic, |margin| ≤ ${ANALOGS.generic.margin_cap})`;
}

module.exports = { ANALOGS, analogKeys, analogOf, capMagnitude, promptGuidance };
