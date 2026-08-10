'use strict';
/* local_frame.js — Spine 3 R1/R3: the top-down enumeration FRAME (docs/DELIVERY_BINDING_SPINE.md).
 *
 * Local government has no authoritative aggregated roster (unlike federal = House/Senate XML, state =
 * OpenStates). But it is a KNOWN FINITE TREE: state → its counties/parishes (enumerable) → their governing
 * body (a small taxonomy) → the officials (the only true research). This module builds the upper frame — the
 * DENOMINATOR + the governance SCOPING — so the leaf research fills a bounded, measured work-list top-down.
 *
 * GENERIC by construction: the county/parish list is the authoritative national Census county gazetteer
 * (bundled: lib/geo/us_counties_2023.tsv, all ~3,222 counties, 50 states + DC + territories). buildFrame(code)
 * works for ANY state; Louisiana is the validation target (exactly 64 parishes), not a hardcode.
 *
 * HONEST about governance: the frame gives the scoping RULE (which body kinds count as the governing body,
 * which row offices to exclude) + a per-locality HYPOTHESIS (the state default, plus a small curated set of
 * well-established consolidated-government exceptions). It never ASSERTS a governance fact — govSource labels
 * each as 'default-hypothesis' or 'known-exception', and the leaf research confirms or corrects it.
 * Run: node scripts/smoke_local_frame.js */

const fs = require('fs');
const path = require('path');
const FRAME_FILE = path.join(__dirname, 'geo', 'us_counties_2023.tsv');

// ── the frame data (pure parse of the slimmed gazetteer: USPS \t GEOID \t NAME) ─────────────────────────────
function parseCounties(text) {
  const rows = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {            // skip header
    const l = lines[i];
    if (!l.trim()) continue;
    const [state, fips, name] = l.split('\t');
    if (state && name) rows.push({ state: state.trim().toUpperCase(), fips: (fips || '').trim(), name: name.trim() });
  }
  return rows;
}
function loadFrame(source) {
  if (source != null) return parseCounties(source);           // injected fixture (tests)
  return parseCounties(fs.readFileSync(FRAME_FILE, 'utf-8')); // the bundled national frame
}

// ── governance scoping (R3) ─────────────────────────────────────────────────────────────────────────────
// The governing body is the county/parish's LEGISLATIVE/deliberative body — NOT the independently-elected
// row offices (sheriff/clerk/DA/assessor/coroner: constitutional offices, not the governing authority). This
// exclusion list is generic across US local government.
const ROW_OFFICES_EXCLUDE = ['Sheriff', 'Clerk of Court', 'District Attorney', 'Assessor', 'Coroner', 'Tax Collector', 'Registrar of Voters', 'Marshal', 'Justice of the Peace'];

// Per-state governance: the body-kind taxonomy + the default hypothesis + a small curated exceptions set
// (well-established consolidated governments — labeled hypotheses, still research-verified). Extend per state
// as tiers are proven; an unlisted state falls back to the generic US county form.
const STATE_GOV = {
  LA: {
    bodyKinds: ['Police Jury', 'Parish Council', 'Parish Commission', 'Metropolitan Council', 'City-Parish Council', 'Parish Governing Authority'],
    defaultBody: 'Police Jury', defaultPresiding: 'President',
    exceptions: {
      // consolidated / home-rule governments (body is well-established; the presiding TITLE is left for
      // research to confirm, so the frame never asserts a title it isn't sure of).
      'Orleans Parish': { body: 'New Orleans City Council', presiding: null },
      'East Baton Rouge Parish': { body: 'Metropolitan Council', presiding: null },
      'Lafayette Parish': { body: 'Lafayette Parish Council', presiding: null },
    },
  },
};
const GENERIC_GOV = {
  bodyKinds: ['County Commission', 'Board of Supervisors', 'County Council', 'Board of County Commissioners', 'County Board'],
  defaultBody: 'County Commission', defaultPresiding: 'Chair', exceptions: {},
};

// The governance HYPOTHESIS + scoping for one locality. Never asserted — govSource says which kind.
function governanceFor(stateCode, countyName) {
  const g = STATE_GOV[String(stateCode).toUpperCase()] || GENERIC_GOV;
  const exc = (g.exceptions || {})[countyName];
  if (exc) return { body: exc.body, presiding: exc.presiding, govSource: 'known-exception', bodyKinds: g.bodyKinds, exclude: ROW_OFFICES_EXCLUDE };
  return { body: g.defaultBody, presiding: g.defaultPresiding, govSource: 'default-hypothesis', bodyKinds: g.bodyKinds, exclude: ROW_OFFICES_EXCLUDE };
}

// buildFrame(code) → the top-down work-list for a state. `count` is the INDEPENDENT DENOMINATOR (R2): coverage
// is measured as filled/`count`, not against whatever the research happened to find.
// { state, count, localities:[{ state, fips, name, county, body, presiding, govSource, bodyKinds, exclude }] }
function buildFrame(stateCode, { source = null } = {}) {
  const code = String(stateCode || '').toUpperCase();
  if (!code) return { state: '', count: 0, localities: [] };
  const rows = loadFrame(source).filter((r) => r.state === code);
  const localities = rows.map((r) => ({ state: r.state, fips: r.fips, name: r.name, county: r.name, ...governanceFor(code, r.name) }));
  return { state: code, count: localities.length, localities };
}

module.exports = { buildFrame, parseCounties, governanceFor, loadFrame, ROW_OFFICES_EXCLUDE, STATE_GOV, GENERIC_GOV, FRAME_FILE };
