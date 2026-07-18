/* One-shot generator: Census national county file → lib/us_counties.json.
 * Source: https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt
 * Pipe-delimited: STATE|STATEFP|COUNTYFP|COUNTYNS|COUNTYNAME|CLASSFP|FUNCSTAT
 *
 * We keep FUNCSTAT=A (active, functioning government) rows and bundle the OFFICIAL county-equivalent
 * name verbatim (e.g. "Alachua County", "Orleans Parish", "St. Louis city", "Denali Borough"). The beat
 * builder derives per-state governing-body target phrasing from these; enumeration stays authoritative
 * and offline. Run: node scripts/gen_us_counties.js <path-to-national_county2020.txt>
 */
'use strict';
const fs = require('fs');
const path = require('path');

const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  // Territories (functioning local governments; in scope for "every elected official in this country").
  AS: 'American Samoa', GU: 'Guam', MP: 'Northern Mariana Islands', PR: 'Puerto Rico', VI: 'U.S. Virgin Islands',
};

// The county-equivalent noun per state (Louisiana=parish, Alaska=borough/census area, Puerto Rico=municipio,
// Louisiana etc.). Most states use "county"; the governing-body phrasing is decided in lib/beats.js.
const COUNTY_NOUN = { LA: 'parish', AK: 'borough', PR: 'municipio' };

const src = process.argv[2];
if (!src) { console.error('usage: node gen_us_counties.js <national_county2020.txt>'); process.exit(1); }
const raw = fs.readFileSync(src, 'utf8');
const lines = raw.split(/\r?\n/).filter(Boolean);
const header = lines.shift();
if (!/^STATE\|STATEFP\|COUNTYFP/.test(header)) { console.error('unexpected header:', header); process.exit(1); }

// FUNCSTAT of a county-equivalent with REAL elected officials: A (active), B (partially consolidated,
// separate officials), C (consolidated, single set of officials — Duval/Jacksonville, NYC boroughs, SF).
// Excluded: F (fictitious), G (subordinate special-purpose), N (nonfunctioning — CT/RI counties), S
// (statistical). CT & RI thus have zero rows here, correctly: they have no county-level government.
const KEEP_FUNCSTAT = new Set(['A', 'B', 'C']);

const out = {};
let kept = 0, skipped = 0;
for (const line of lines) {
  const [st, , , , name, classfp, funcstat] = line.split('|');
  if (!st || !name) { skipped += 1; continue; }
  if (!KEEP_FUNCSTAT.has(funcstat)) { skipped += 1; continue; }
  if (!STATE_NAMES[st]) { skipped += 1; continue; }         // 50 states + DC + territories
  if (!out[st]) out[st] = { name: STATE_NAMES[st], noun: COUNTY_NOUN[st] || 'county', counties: [] };
  out[st].counties.push(name);
  kept += 1;
}
for (const st of Object.keys(out)) out[st].counties.sort((a, b) => a.localeCompare(b));

const outPath = path.join(__dirname, '..', 'lib', 'us_counties.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 0) + '\n');
const states = Object.keys(out).sort();
console.log(`wrote ${outPath}`);
console.log(`states=${states.length} kept=${kept} skipped=${skipped}`);
console.log('per-state counts:', states.map((s) => `${s}:${out[s].counties.length}`).join(' '));
