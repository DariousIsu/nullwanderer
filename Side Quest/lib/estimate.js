/**
 * lib/estimate.js — a grounded time-to-completion estimate for a directed run (Pillar 0).
 *
 * The gap this fills: the intake gate created a run silently — no readback, no ETA — so a misread goal
 * (Lucas's "many"→"money" typo) sailed through with no moment to catch it. The gate should state what it
 * understood AND how long it'll take, so the understanding is visible and correctable before hours of
 * work churn.
 *
 * "Track effort, speak wall-clock": effort = units × measured per-unit rate; the spoken ETA is now+effort
 * (lib/calendar makes it meeting-aware later). Rates are PER-ORG observed defaults (single-lane ~3 min,
 * deep two-lane ~5 min — web∥structured run in parallel + a merge); a measured rate can override once the
 * throughput telemetry lands. PURE, no I/O. Fail-safe: returns a value, never throws.
 */
'use strict';

const DEFAULT_SINGLE_MIN = 3;   // per org, single web-lane pass
const DEFAULT_DEEP_MIN = 5;     // per org, deep two-lane (web ∥ structured → merge)

// Human-readable duration from minutes: "~45 min" / "~1h 35m" / "~2 hours".
function humanizeMin(totalMin) {
  const m = Math.max(1, Math.round(Number(totalMin) || 0));
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60), rem = m % 60;
  if (rem === 0) return h === 1 ? '~1 hour' : `~${h} hours`;
  return `~${h}h ${rem}m`;
}

// Estimate a directed run. opts.perOrgMin overrides the default rate (e.g. a measured throughput).
//   { orgCount, deep, perOrgMin? } → { perOrgMin, totalMin, etaMs?, human, basis }
function estimateRun({ orgCount = 0, deep = false, perOrgMin = null, nowMs = null } = {}) {
  const n = Math.max(0, Math.floor(Number(orgCount) || 0));
  const rate = (perOrgMin && perOrgMin > 0) ? perOrgMin : (deep ? DEFAULT_DEEP_MIN : DEFAULT_SINGLE_MIN);
  const totalMin = n * rate;
  const human = n === 0 ? '(nothing to do)' : humanizeMin(totalMin);
  const etaMs = (nowMs && totalMin) ? nowMs + totalMin * 60 * 1000 : null;
  return { perOrgMin: rate, totalMin, etaMs, human, basis: perOrgMin ? 'measured' : 'default-rate' };
}

// A one-line readback + estimate sentence the gate speaks when it starts a run, so the understood goal +
// scope + ETA are VISIBLE and correctable. Deliberately states the interpretation, not just "started".
function readbackLine({ facet = '', orgCount = 0, deep = false, priority = null, perOrgMin = null } = {}) {
  const est = estimateRun({ orgCount, deep, perOrgMin });
  const tag = priority ? ` [${priority}]` : '';
  const depthWord = deep ? 'deep (two-lane)' : 'standard';
  const facetStr = String(facet || '(unspecified)').slice(0, 120);
  // orgCount 0 = a DISCOVERY run (no org work-list yet) OR a fully-covered run. Either way an
  // "across 0 organizations. Estimated (nothing to do)" line is a meaningless aggregate over an empty
  // set — it reads as a robotic no-op in her voice ("focusing … across 0 organizations (estimated:
  // nothing to do)"). Speak the honest SHAPE instead: the goal, and that the first step is finding
  // who to look at. No fabricated count, no "nothing to do".
  if (orgCount <= 0) {
    return `Understood as${tag}: ${depthWord} research to gather "${facetStr}" — I don't have a target list for that yet, so I'll start by finding who to look at.`;
  }
  return `Understood as${tag}: ${depthWord} research to gather "${facetStr}" across ${orgCount} organization${orgCount === 1 ? '' : 's'}. Estimated ${est.human} (${est.perOrgMin} min/org).`;
}

module.exports = { estimateRun, readbackLine, humanizeMin, DEFAULT_SINGLE_MIN, DEFAULT_DEEP_MIN };
