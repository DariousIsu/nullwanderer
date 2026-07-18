/**
 * lib/beats.js — AUTONOMIC BEATS: the pure worklist substrate (Slice 1).
 *
 * A BEAT is a broad, hardwired coverage mandate (per docs/AUTONOMIC_ARCHITECTURE_DESIGN.md). The system
 * DECOMPOSES a beat into an enumerable WORKLIST of researchable targets; the existing directed-research
 * machinery then EXHAUSTS that bounded list (per-target deepen → mark covered → stop when all covered —
 * main.js runDirectedResearchPass), which fixes the loop-and-wander: a bounded, enumerated checklist can
 * neither loop (it knows what's done) nor wander (targets aren't model-invented). Coverage = covered/N.
 *
 * This module is the PURE half — the universe enumeration + target construction — so it's fully offline
 * testable. The orchestration (seed a directed focus with the worklist, kick the driver) lives in main.js
 * because it needs generateResearchPlan + the driver. Slice 1 ships ONE beat (a state's county commissions,
 * under "elected officials"); Slice 2 generalizes to a registry + scheduler + the other beats.
 *
 * Research runs BROWSER-first and every finding is corroborated (official sources are leads, not facts) —
 * those disciplines live in the directed-research pass, not here. This module only decides WHAT to cover.
 */
'use strict';

// Authoritative static roster — Florida's 67 counties (FIPS-canonical set). Slice 1 uses a static list;
// Slice 2 swaps enumeration to the Census county gazetteer for all states. Kept as data, not logic.
const STATE_COUNTIES = {
  FL: [
    'Alachua', 'Baker', 'Bay', 'Bradford', 'Brevard', 'Broward', 'Calhoun', 'Charlotte', 'Citrus', 'Clay',
    'Collier', 'Columbia', 'DeSoto', 'Dixie', 'Duval', 'Escambia', 'Flagler', 'Franklin', 'Gadsden',
    'Gilchrist', 'Glades', 'Gulf', 'Hamilton', 'Hardee', 'Hendry', 'Hernando', 'Highlands', 'Hillsborough',
    'Holmes', 'Indian River', 'Jackson', 'Jefferson', 'Lafayette', 'Lake', 'Lee', 'Leon', 'Levy', 'Liberty',
    'Madison', 'Manatee', 'Marion', 'Martin', 'Miami-Dade', 'Monroe', 'Nassau', 'Okaloosa', 'Okeechobee',
    'Orange', 'Osceola', 'Palm Beach', 'Pasco', 'Pinellas', 'Polk', 'Putnam', 'St. Johns', 'St. Lucie',
    'Santa Rosa', 'Sarasota', 'Seminole', 'Sumter', 'Suwannee', 'Taylor', 'Union', 'Volusia', 'Wakulla',
    'Walton', 'Washington',
  ],
};

const STATE_NAMES = { FL: 'Florida' };

// Enumerate the county-commission worklist for a state → researchable target strings. Each target names the
// concrete governing body so the directed pass researches THAT (its current members), and the county+state
// tokens keep the browse leash on-domain (lib/focus.domainLeashTokens).
function countyCommissionTargets(stateCode) {
  const code = String(stateCode || '').toUpperCase();
  const counties = STATE_COUNTIES[code];
  if (!counties || !counties.length) return [];
  const stateName = STATE_NAMES[code] || code;
  return counties.map((c) => `Board of County Commissioners of ${c} County, ${stateName}`);
}

// A beat descriptor for Slice 1 — the shape a registry (Slice 2) will hold many of. `enumerate()` returns
// the worklist; `universeSize()` is the coverage denominator (X / N).
function countyCommissionBeat(stateCode) {
  const code = String(stateCode || '').toUpperCase();
  const stateName = STATE_NAMES[code] || code;
  const targets = countyCommissionTargets(code);
  return {
    id: `county-commissions-${code.toLowerCase()}`,
    parentBeat: 'elected-officials',
    kind: 'entity',                          // roster of governing bodies + their members
    goal: `Compile and keep current the Board of County Commissioners for every county in ${stateName} — `
      + `all ${targets.length} counties, with each board's current members. Corroborate against independent `
      + `sources; official rosters are leads, not facts.`,
    enumerate: () => targets,
    universeSize: () => targets.length,
  };
}

// Coverage of a beat given the directed focus's `covered` list (fuzzy-matched to worklist targets so
// "Alachua County Commission" counts against "Board of County Commissioners of Alachua County, Florida").
function coverageOf(targets, covered) {
  const cov = (Array.isArray(covered) ? covered : []).map((c) => String(c || '').toLowerCase());
  let done = 0;
  const remaining = [];
  for (const t of (targets || [])) {
    const tl = String(t).toLowerCase();
    // Key token = the county NAME (the distinctive part). Anchor on "commissioners of" so the "county" inside
    // "county commissioners" doesn't get grabbed, and allow hyphen/period/space (Miami-Dade, St. Johns).
    const county = (tl.match(/commissioners of ([a-z.\- ]+?) county/) || [])[1] || tl;
    const hit = cov.some((c) => c.includes(county) || tl.includes(c) || c.includes(tl));
    if (hit) done += 1; else remaining.push(t);
  }
  return { done, total: (targets || []).length, remaining, pct: (targets && targets.length) ? Math.round((done / targets.length) * 100) : 0 };
}

module.exports = {
  STATE_COUNTIES, STATE_NAMES,
  countyCommissionTargets, countyCommissionBeat, coverageOf,
};
