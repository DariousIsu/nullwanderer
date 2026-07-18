/* One-shot generator: Census national county-subdivision file → lib/us_subdivisions.json.
 * Source: https://www2.census.gov/geo/docs/reference/codes2020/national_cousub2020.txt
 * Pipe-delimited: STATE|STATEFP|COUNTYFP|COUNTYNAME|COUSUBFP|COUSUBNS|COUSUBNAME|CLASSFP|FUNCSTAT
 *
 * The TOWN/TOWNSHIP tier of the elected-officials completeness beat — the sub-county governments the place
 * (municipal) tier MISSES: New England towns (CT/RI/MA/NH/VT/ME), New York/Wisconsin towns, and Midwest
 * townships (MI/OH/PA/NJ/IL/IN/KS/MO/MN/ND/SD…). We keep only CLASSFP=T1 (a minor-civil-division with an
 * elected government) + FUNCSTAT=A (active), so we DON'T double-count incorporated places (those are C-class
 * MCDs, already the municipal tier) and DON'T pick up CCDs (Z-class, statistical, no government). Dedup a
 * town spanning counties by its stable COUSUBNS within state. Run:
 *   node scripts/gen_us_subdivisions.js <national_cousub2020.txt>
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
};

const src = process.argv[2];
if (!src) { console.error('usage: node gen_us_subdivisions.js <national_cousub2020.txt>'); process.exit(1); }
const raw = fs.readFileSync(src, 'utf8');
const lines = raw.split(/\r?\n/).filter(Boolean);
const header = lines.shift();
if (!/^STATE\|STATEFP\|COUNTYFP\|COUNTYNAME\|COUSUBFP\|COUSUBNS\|COUSUBNAME\|CLASSFP\|FUNCSTAT/.test(header)) {
  console.error('unexpected header:', header); process.exit(1);
}

const out = {};
const seen = {};   // state → Set(cousubNS) to dedup a town spanning counties
let kept = 0, skipped = 0;
for (const line of lines) {
  const [st, , , , , cousubNS, name, classfp, funcstat] = line.split('|');
  if (!st || !name) { skipped += 1; continue; }
  if (classfp !== 'T1') { skipped += 1; continue; }   // T1 = MCD with an elected government (town/township)
  if (funcstat !== 'A') { skipped += 1; continue; }    // active
  if (!STATE_NAMES[st]) { skipped += 1; continue; }
  if (!seen[st]) seen[st] = new Set();
  if (seen[st].has(cousubNS)) { skipped += 1; continue; }
  seen[st].add(cousubNS);
  if (!out[st]) out[st] = { name: STATE_NAMES[st], subdivisions: [] };
  out[st].subdivisions.push(name);
  kept += 1;
}
for (const st of Object.keys(out)) out[st].subdivisions.sort((a, b) => a.localeCompare(b));

const outPath = path.join(__dirname, '..', 'lib', 'us_subdivisions.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 0) + '\n');
const states = Object.keys(out).sort();
console.log(`wrote ${outPath}`);
console.log(`states=${states.length} kept=${kept} skipped=${skipped}`);
console.log('per-state counts:', states.map((s) => `${s}:${out[s].subdivisions.length}`).join(' '));
