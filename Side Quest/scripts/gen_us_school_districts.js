/* One-shot generator: Census national school-district file → lib/us_school_districts.json.
 * Source: https://www2.census.gov/geo/docs/reference/codes2020/national_schdist2020.txt
 * Pipe-delimited: STATE|STATEFP|LEA|SDNAME|SDTYPE  (SDTYPE = Unified | Elementary | Secondary)
 *
 * The SCHOOL-BOARD tier of the elected-officials completeness beat — every public school district (its
 * board of education is elected in the large majority of districts; the dossier research surfaces the few
 * that are appointed). Deduped by LEA within state. Run:
 *   node scripts/gen_us_school_districts.js <national_schdist2020.txt>
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
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC2: 'District of Columbia',
};

const src = process.argv[2];
if (!src) { console.error('usage: node gen_us_school_districts.js <national_schdist2020.txt>'); process.exit(1); }
const raw = fs.readFileSync(src, 'utf8');
const lines = raw.split(/\r?\n/).filter(Boolean);
const header = lines.shift();
if (!/^STATE\|STATEFP\|LEA\|SDNAME\|SDTYPE/.test(header)) { console.error('unexpected header:', header); process.exit(1); }

const out = {};
const seen = {};   // state → Set(LEA)
let kept = 0, skipped = 0;
for (const line of lines) {
  const [st, , lea, name] = line.split('|');
  if (!st || !name) { skipped += 1; continue; }
  if (!STATE_NAMES[st]) { skipped += 1; continue; }
  if (!seen[st]) seen[st] = new Set();
  if (lea && seen[st].has(lea)) { skipped += 1; continue; }
  if (lea) seen[st].add(lea);
  if (!out[st]) out[st] = { name: STATE_NAMES[st], districts: [] };
  out[st].districts.push(name.trim());
  kept += 1;
}
for (const st of Object.keys(out)) out[st].districts.sort((a, b) => a.localeCompare(b));

const outPath = path.join(__dirname, '..', 'lib', 'us_school_districts.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 0) + '\n');
const states = Object.keys(out).sort();
console.log(`wrote ${outPath}`);
console.log(`states=${states.length} kept=${kept} skipped=${skipped}`);
console.log('sample counts:', states.slice(0, 12).map((s) => `${s}:${out[s].districts.length}`).join(' '), '…');
