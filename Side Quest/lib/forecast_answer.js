'use strict';
// ── THE FORECAST ANSWER (catch #6 cure, 2026-08-24) ─────────────────────────────────────────────
// Sprint-2 catch #6: "whats our forecast on the midterms" drew two stacked "let me…" says and NO
// numbers — while the balance-of-power suite sat COMPUTED in main's lastForecast. The disease is
// the say-do gap's forecast face: the held work exists, the reply lane just never reads it.
// Cure = the proven injection pattern (dataset counts / project status): a forecast-shaped ask
// injects the suite's CURRENT code-authored numbers into the reply context, so the say answers
// from held data — never promises to "get it going". Pure + deps-injected → hermetic smoke.

// Fast-path detector (detectors-vs-comprehension: regex first). Three legs, all required:
// a forecast TERM · an election CONTEXT token · and NOT a weather ask ("forecast for Tampa
// tomorrow" is openweather's, never this door's).
const _TERM_RE = /\b(?:forecasts?|odds|chances|probabilit\w*|projections?|predictions?|who(?:'s| is)?\s+(?:going to|gonna|likely to)\s+win|balance of power)\b/i;
const _CTX_RE = /\b(?:midterms?|elections?|senate|house|congress(?:ional)?|governor|races?|seats?|control of|electoral)\b/i;
const _WEATHER_RE = /\b(?:weather|rain|snow|storms?|temperature|hurricane|wind|humidity|tomorrow'?s forecast)\b/i;

function isForecastAsk(text) {
  const t = String(text || '');
  if (!t || t.length > 600) return false;
  return _TERM_RE.test(t) && _CTX_RE.test(t) && !_WEATHER_RE.test(t);
}

// Code-authored digest of a forecast_loop.runOnce() result — the model NEVER authors these
// numbers. Null when there is nothing computed to serve (the caller injects the honest state).
function digest(res, { tz = 'America/New_York' } = {}) {
  if (!res || !res.ok || !res.payload) return null;
  const p = res.payload;
  const ch = (name, c) => {
    if (!c || c.pD_control == null) return null;
    const bits = [`${name}: P(D control) ${(c.pD_control * 100).toFixed(0)}% / P(R control) ${(c.pR_control * 100).toFixed(0)}%`];
    if (c.dSeats_mean != null) bits.push(`mean D seats ${Math.round(c.dSeats_mean)}${c.dSeats_p10 != null && c.dSeats_p90 != null ? ` (p10 ${Math.round(c.dSeats_p10)} – p90 ${Math.round(c.dSeats_p90)})` : ''}`);
    if (c.need) bits.push(`${c.need} of ${c.total} for the majority`);
    return bits.join(' · ');
  };
  const L = [ch('House', p.house), ch('Senate', p.senate)].filter(Boolean);
  if (!L.length) return null;
  if (Array.isArray(p.scenarios) && p.scenarios.length) {
    L.push(`Scenarios: ${p.scenarios.slice(0, 4).map((s) => `${s.label} ${(Number(s.prob) * 100).toFixed(0)}%`).join(' · ')}`);
  }
  const w = res.work || {};
  const basis = [];
  if (w.margins) basis.push(`${w.margins.polled}/${w.margins.total} races polled`);
  if (w.coverage && w.coverage.races) basis.push(`${w.coverage.races} seats covered`);
  if (res.live) basis.push('LIVE polls riding');
  if (basis.length) L.push(`Basis: ${basis.join(' · ')}`);
  if (res.computedTs) L.push(`Computed: ${new Date(res.computedTs).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`);
  return L.join('\n');
}

module.exports = { isForecastAsk, digest };
