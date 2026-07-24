/**
 * lib/regions.js — state→region + named thematic zones for the CONDITIONAL SCENARIO ENGINE
 * (docs/SCENARIO_ENGINE_DESIGN.md §4b/§5, Slice 0).
 *
 * A scenario's effect selectors resolve against a seat's geography — "national" needs nothing, but
 * "region" / "state" / a thematic "zone" (e.g. `fire-west`) need a map from a seat's state to the group
 * it belongs to. Two taxonomies, deliberately separate (§10 open-question — "region taxonomy"):
 *   • CENSUS_REGION — the 4 U.S. Census regions. CLEAN geography, not editorial.
 *   • NAMED_ZONES  — small, hand-authored THEMATIC groups (a wildfire west, a rust belt). EDITORIAL by
 *     nature, so they live here as a NAMED, AUDITABLE map — never model-invented per run (§10).
 *
 * PURE + no deps. State keys are USPS 2-letter abbreviations (uppercase). `statesIn(name)` resolves EITHER
 * a census region name OR a zone key to the set of member abbreviations, so a selector can name either.
 */
'use strict';

// The 4 U.S. Census regions → member states (USPS abbr). DC folded into South (Census "South Atlantic").
const CENSUS_REGION = {
  Northeast: ['CT', 'ME', 'MA', 'NH', 'RI', 'VT', 'NJ', 'NY', 'PA'],
  Midwest: ['IL', 'IN', 'MI', 'OH', 'WI', 'IA', 'KS', 'MN', 'MO', 'NE', 'ND', 'SD'],
  South: ['DE', 'FL', 'GA', 'MD', 'NC', 'SC', 'VA', 'WV', 'DC', 'AL', 'KY', 'MS', 'TN', 'AR', 'LA', 'OK', 'TX'],
  West: ['AZ', 'CO', 'ID', 'MT', 'NV', 'NM', 'UT', 'WY', 'AK', 'CA', 'HI', 'OR', 'WA'],
};

// Named THEMATIC zones — small + editorial + auditable. Add deliberately; these are NOT model-invented.
// `fire-west` is the design's worked example (§9): the western wildfire/brownout footprint.
const NAMED_ZONES = {
  'fire-west': ['CA', 'OR', 'WA', 'AZ', 'NV'],                 // wildfire / grid-strain west (§9)
  'rust-belt': ['PA', 'OH', 'MI', 'WI', 'IN', 'IL'],          // industrial midwest/NE
  'oil-patch': ['TX', 'OK', 'ND', 'NM', 'LA', 'AK'],         // energy-producing states
  'sun-belt': ['AZ', 'NV', 'GA', 'NC', 'FL', 'TX'],          // fast-growing south/southwest battlegrounds
};

// reverse index: abbr → census region name (built once).
const _REGION_OF = (() => {
  const m = {};
  for (const [region, states] of Object.entries(CENSUS_REGION)) for (const s of states) m[s] = region;
  return m;
})();

function _norm(abbr) { return String(abbr == null ? '' : abbr).trim().toUpperCase(); }

// abbr → its census region name, or null if unknown.
function regionOf(abbr) { return _REGION_OF[_norm(abbr)] || null; }

// zone key → member abbrs (array), or null if not a known zone.
function zoneMembers(key) { const z = NAMED_ZONES[String(key || '').toLowerCase()]; return z ? z.slice() : null; }

// is `abbr` in the named zone `key`?
function inZone(abbr, key) { const z = NAMED_ZONES[String(key || '').toLowerCase()]; return !!z && z.includes(_norm(abbr)); }

// Resolve a group NAME to the Set of member abbrs. Accepts a census region ("West", case-insensitive),
// a zone key ("fire-west"), or a bare state abbr ("CA" → {CA}). Returns an empty Set for an unknown name.
function statesIn(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return new Set();
  // census region (case-insensitive match on the 4 names)
  const regKey = Object.keys(CENSUS_REGION).find((r) => r.toLowerCase() === raw.toLowerCase());
  if (regKey) return new Set(CENSUS_REGION[regKey]);
  // named zone
  const zone = NAMED_ZONES[raw.toLowerCase()];
  if (zone) return new Set(zone);
  // bare state abbr
  const ab = _norm(raw);
  if (_REGION_OF[ab]) return new Set([ab]);
  return new Set();
}

// Every group name the engine can select on (the 4 regions + the named zones) — for validation/UX.
function knownGroups() { return [...Object.keys(CENSUS_REGION), ...Object.keys(NAMED_ZONES)]; }

module.exports = { CENSUS_REGION, NAMED_ZONES, regionOf, zoneMembers, inZone, statesIn, knownGroups };
