'use strict';
/**
 * lib/report_maps.js — REAL US geometry for report graphics. Zero fabrication.
 *
 * Boundaries come from us-atlas (US Census cartographic boundaries, public domain). The shipped
 * files are RAW WGS84 lon/lat (measured: FL bbox ≈ [-87.6, 24.5, -80, 31]), so _decode projects
 * them through the CANONICAL d3-geo geoAlbersUsa composite fitted to a 975x610 view — standard
 * published projection code, never hand-authored parameters. Keys come from the atlas itself
 * (state ids/names) plus the in-repo census key table lib/geo/us_counties_2023.tsv
 * (USPS ↔ GEOID ↔ county name). Nothing in this module authors a coordinate or a name: an
 * unresolvable OR ambiguous key returns null and the caller REFUSES — a wrong map is a
 * fabricated document.
 *
 * ⚠ Vintage note: the TSV is 2023 (CT = planning regions 09110+), the atlas is the prior county
 * vintage (CT = legacy 09001-09015). A raw 5-digit FIPS is therefore accepted when EITHER table
 * knows it — the atlas is the drawing authority — and a name that resolves to a region the atlas
 * cannot draw fails loudly at render with the vintage hint.
 *
 * All loads are lazy + cached (the TopoJSON is a few MB of JSON; parse once per boot).
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const VIEW = { width: 975, height: 610 }; // us-atlas pre-projected viewport (geoAlbersUsa)

let _statesCache = null, _countiesCache = null, _keysCache = null;

function _atlasFile(name) {
  const p = path.join(ROOT, 'node_modules', 'us-atlas', name);
  if (!fs.existsSync(p)) throw new Error(`us-atlas not installed (${name} missing) — npm install us-atlas`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── key tables (from the in-repo census TSV: USPS \t GEOID \t NAME) ─────────────────────────────
function keys() {
  if (_keysCache) return _keysCache;
  const tsv = fs.readFileSync(path.join(ROOT, 'lib', 'geo', 'us_counties_2023.tsv'), 'utf8');
  const postalToFips = {};   // 'FL' → '12'
  const fipsToPostal = {};   // '12' → 'FL'
  const countyByFips = {};   // '12086' → { name:'Miami-Dade County', postal:'FL' }
  const countyByName = {};   // 'miami-dade|FL' → '12086' (exact, per-state — no cross-state guessing)
  const claim = (key, geoid) => { // ambiguity is refused, never guessed: a re-claimed bare key dies
    if (countyByName[key] && countyByName[key] !== geoid) countyByName[key] = '!ambiguous';
    else if (!countyByName[key]) countyByName[key] = geoid;
  };
  for (const line of tsv.split('\n').slice(1)) {
    const [usps, geoid, name] = line.trim().split('\t');
    if (!usps || !geoid || geoid.length !== 5) continue;
    const st = geoid.slice(0, 2);
    postalToFips[usps] = st; fipsToPostal[st] = usps;
    countyByFips[geoid] = { name, postal: usps };
    // 'city' is in the strip list so 'Richmond County' and 'Richmond city' COLLIDE on the bare key
    // and both become ambiguous — the full name ("Richmond city, VA") still resolves exactly.
    const bare = name.toLowerCase().replace(/\s+(county|parish|borough|census area|municipality|city and borough|municipio|city)$/i, '').trim();
    claim(`${bare}|${usps}`, geoid);
    claim(`${name.toLowerCase()}|${usps}`, geoid);
  }
  _keysCache = { postalToFips, fipsToPostal, countyByFips, countyByName };
  return _keysCache;
}

// ── geometry: decode TopoJSON (raw lon/lat) → project → per-feature SVG path + centroid + bbox ──
// The atlas ships WGS84 coordinates (measured: FL bbox ≈ [-87.6, 24.5, -80, 31]). Projection is the
// CANONICAL d3 geoAlbersUsa composite (lower-48 + AK + HI insets) fitted to the 975×610 view —
// standard published math, never hand-authored parameters (a misplaced inset is fabricated
// geography). Territories outside the composite's three zones (PR/VI/GU/AS/MP) project to null and
// are dropped — the standard Albers-USA frame; use an explicit state scope when they matter.
function _decode(topoName, objectName) {
  const topojson = require('topojson-client');
  const { geoAlbersUsa, geoPath } = require('d3-geo');
  const topo = _atlasFile(topoName);
  const fc = topojson.feature(topo, topo.objects[objectName]);
  const proj = geoAlbersUsa();
  proj.fitSize([VIEW.width, VIEW.height], fc);
  const pathGen = geoPath(proj);
  const out = [];
  for (const f of fc.features) {
    const d = pathGen(f);
    if (!d) continue; // outside the Albers-USA composite (territories) — dropped, never guessed
    const [c0, c1] = pathGen.centroid(f);
    const [[x0, y0], [x1, y1]] = pathGen.bounds(f);
    out.push({
      id: String(f.id),
      name: (f.properties && f.properties.name) || String(f.id),
      path: d.replace(/(\d+\.\d\d)\d+/g, '$1'), // trim precision — smaller SVG, invisible at print
      centroid: Number.isFinite(c0) ? { x: c0, y: c1 } : null,
      bbox: [x0, y0, x1, y1],
    });
  }
  return out;
}

function states() {
  if (!_statesCache) _statesCache = _decode('states-10m.json', 'states');
  return _statesCache;
}
function counties() {
  if (!_countiesCache) _countiesCache = _decode('counties-10m.json', 'counties');
  return _countiesCache;
}

// ── key resolution — exact matches only; unknown OR ambiguous → null (the caller must refuse,
//    never guess). Postal + numeric FIPS resolve from the in-repo TSV (no atlas needed); a full
//    state NAME needs the atlas's name list. ───────────────────────────────────────────────────
function stateFipsForKey(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  const K = keys();
  if (/^\d{2}$/.test(k)) return K.fipsToPostal[k] ? k : null;
  if (K.postalToFips[k.toUpperCase()]) return K.postalToFips[k.toUpperCase()];
  try {
    const byName = states().find(s => s.name.toLowerCase() === k.toLowerCase());
    return byName ? byName.id : null;
  } catch { return null; } // atlas absent → a name cannot be verified → refuse
}
function countyFipsForKey(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  const K = keys();
  if (/^\d{5}$/.test(k)) { // accepted when EITHER vintage knows it — the atlas is the drawing authority
    if (K.countyByFips[k]) return k;
    try { return counties().some(f => f.id === k) ? k : null; } catch { return null; }
  }
  const m = /^(.+?),\s*([A-Za-z]{2})$/.exec(k); // 'Miami-Dade, FL' — state-qualified, exact
  if (m) {
    const hit = K.countyByName[`${m[1].trim().toLowerCase()}|${m[2].toUpperCase()}`];
    return hit && hit !== '!ambiguous' ? hit : null; // ambiguous (e.g. Richmond city vs County) → refuse
  }
  return null; // a bare county name is ambiguous across states — refuse rather than guess
}

// bounding box of a feature set, padded — the zoom viewBox for a single-state county map
function bboxOf(features, padFrac = 0.04) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of features) {
    if (f.bbox[0] < minX) minX = f.bbox[0]; if (f.bbox[2] > maxX) maxX = f.bbox[2];
    if (f.bbox[1] < minY) minY = f.bbox[1]; if (f.bbox[3] > maxY) maxY = f.bbox[3];
  }
  const pw = (maxX - minX) * padFrac, ph = (maxY - minY) * padFrac;
  return { x: minX - pw, y: minY - ph, width: (maxX - minX) + 2 * pw, height: (maxY - minY) + 2 * ph };
}

function available() {
  try { return fs.existsSync(path.join(ROOT, 'node_modules', 'us-atlas', 'states-10m.json')); }
  catch { return false; }
}

module.exports = { states, counties, keys, stateFipsForKey, countyFipsForKey, bboxOf, available, VIEW };
