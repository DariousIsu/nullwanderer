/* One-shot generator: Census national place-by-county file → lib/us_places.json.
 * Source: https://www2.census.gov/geo/docs/reference/codes2020/national_place_by_county2020.txt
 * Pipe-delimited: STATE|STATEFP|COUNTYFP|COUNTYNAME|PLACEFP|PLACENS|PLACENAME|TYPE|CLASSFP|FUNCSTAT
 *
 * The MUNICIPAL tier of the elected-officials completeness beat. We keep only INCORPORATED PLACES (they have
 * an elected government — city/town/village/borough council) with an ACTIVE government, and DEDUP a place that
 * spans multiple counties (the file is place-by-county, so it repeats) by its stable PLACENS id within state.
 * Census Designated Places (CDPs) are statistical only — no government — and are excluded.
 *
 * ACTIVE means FUNCSTAT A, plus (2026-07-29 slice-B finding — the first cut dropped Nashville, Louisville,
 * Indianapolis, Baton Rouge, Athens, and Augusta from the entire municipal map):
 *   - FUNCSTAT F + CLASSFP C8 — the consolidated city-county "(balance)" entries. Census marks the balance
 *     "fictitious" as a GEOGRAPHY, but it is the only row carrying the real metro/unified government
 *     (Nashville-Davidson metropolitan government, Louisville/Jefferson County metro government, …).
 *   - FUNCSTAT B — an active government partially consolidated with another (Baton Rouge, Lafayette LA).
 * FUNCSTAT N/I (nonfunctioning/inactive — e.g. the pre-merger "Louisville city" husk) stay excluded. Run:
 *   node scripts/gen_us_places.js <national_place_by_county2020.txt>
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
  AS: 'American Samoa', GU: 'Guam', MP: 'Northern Mariana Islands', PR: 'Puerto Rico', VI: 'U.S. Virgin Islands',
};

const src = process.argv[2];
if (!src) { console.error('usage: node gen_us_places.js <national_place_by_county2020.txt>'); process.exit(1); }
const raw = fs.readFileSync(src, 'utf8');
const lines = raw.split(/\r?\n/).filter(Boolean);
const header = lines.shift();
if (!/^STATE\|STATEFP\|COUNTYFP\|COUNTYNAME\|PLACEFP\|PLACENS\|PLACENAME\|TYPE/.test(header)) {
  console.error('unexpected header:', header); process.exit(1);
}

const out = {};
const seen = {};   // state → Set(placeNS) to dedup multi-county places
let kept = 0, skipped = 0;
for (const line of lines) {
  const [st, , , , , placeNS, name, type, classfp, funcstat] = line.split('|');
  if (!st || !name) { skipped += 1; continue; }
  if (type !== 'INCORPORATED PLACE') { skipped += 1; continue; }   // CDPs have no government
  const active = funcstat === 'A' || funcstat === 'B' || (funcstat === 'F' && classfp === 'C8');
  if (!active) { skipped += 1; continue; }                          // active government only (see header)
  if (!STATE_NAMES[st]) { skipped += 1; continue; }
  if (!seen[st]) seen[st] = new Set();
  if (seen[st].has(placeNS)) { skipped += 1; continue; }            // same place, another county → dedup
  seen[st].add(placeNS);
  if (!out[st]) out[st] = { name: STATE_NAMES[st], places: [] };
  out[st].places.push(name);
  kept += 1;
}
for (const st of Object.keys(out)) out[st].places.sort((a, b) => a.localeCompare(b));

const outPath = path.join(__dirname, '..', 'lib', 'us_places.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 0) + '\n');
const states = Object.keys(out).sort();
console.log(`wrote ${outPath}`);
console.log(`states=${states.length} kept=${kept} skipped=${skipped}`);
console.log('per-state counts:', states.map((s) => `${s}:${out[s].places.length}`).join(' '));
