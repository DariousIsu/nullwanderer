'use strict';
/* smoke_roster_refresh.js — the roster-refresh curation organ (lib/roster_refresh.js).
 * Hermetic: temp sq.db (SQ_DB_PATH set BEFORE lib/db loads), fixture feeds, injected fetch.
 * The load-bearing assert: a FULL synthetic feed lands an assignment on every one of the beat's
 * congressional targets in its exact name grammar — naming drift = red gate, never a mis-stamp.
 * Run: node scripts/smoke_roster_refresh.js */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-smoke-'));
process.env.SQ_DB_PATH = path.join(tmp, 'sq.db');
process.env.ZOE_ROSTER_REFRESH = '1';

const db = require(path.join(__dirname, '..', 'lib', 'db'));
db.init();
const rr = require(path.join(__dirname, '..', 'lib', 'roster_refresh'));
const civic = require(path.join(__dirname, '..', 'lib', 'civic_store'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };

// USPS map (test-local copy) to synthesize feeds from the beat's own target list.
const USPS = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico', AS: 'American Samoa', GU: 'Guam', MP: 'Northern Mariana Islands', VI: 'U.S. Virgin Islands' };
const CODE_OF = Object.fromEntries(Object.entries(USPS).map(([c, n]) => [n, c]));

const targets = rr.federalTargetSet();
ok('beat enumerates the federal worklist', targets.length >= 540);

// ── synthesize a FULL feed from the target list itself ──────────────────────────────────────────
let bio = 1000;
const houseRows = [], senateRows = [], crossArr = [];
const mkBio = () => `T${String(bio++).padStart(6, '0')}`;
for (const t of targets) {
  let m;
  if ((m = t.match(/^United States Representative for (.+?)'s (At-Large|\d+)\w{0,2} Congressional District$/))) {
    const code = CODE_OF[m[1]]; if (!code) continue;
    const d = m[2] === 'At-Large' ? 0 : parseInt(m[2], 10);
    const b = mkBio(); const nm = `Rep ${code}${d}`;
    houseRows.push(`<member><statedistrict>${code}${String(d).padStart(2, '0')}</statedistrict><member-info><official-name>${nm}</official-name><bioguideID>${b}</bioguideID><party>X</party><phone>(202) 555-0000</phone></member-info></member>`);
    crossArr.push({ id: { bioguide: b }, name: { official_full: nm, last: `${code}${d}` }, terms: [{ type: 'rep', start: '2025-01-03' }] });
  } else if ((m = t.match(/^(Delegate|Resident Commissioner) to the United States House of Representatives from (.+)$/))) {
    const code = CODE_OF[m[2]] || Object.keys(USPS).find((c) => USPS[c].toLowerCase().includes(m[2].toLowerCase()) || m[2].toLowerCase().includes(USPS[c].toLowerCase()));
    if (!code) continue;
    const b = mkBio(); const nm = `Del ${code}`;
    houseRows.push(`<member><statedistrict>${code}00</statedistrict><member-info><official-name>${nm}</official-name><bioguideID>${b}</bioguideID><party>X</party><phone>(202) 555-0001</phone></member-info></member>`);
    crossArr.push({ id: { bioguide: b }, name: { official_full: nm, last: code }, terms: [{ type: 'rep', start: '2025-01-03' }] });
  } else if ((m = t.match(/^Senior United States Senator from (.+)$/))) {
    const code = CODE_OF[m[1]]; if (!code) continue;
    const b1 = mkBio(), b2 = mkBio();
    senateRows.push(`<member><member_full>Alpha (X-${code})</member_full><last_name>Alpha${code}</last_name><first_name>Sen</first_name><party>X</party><state>${code}</state><phone>(202) 555-0002</phone><website>https://x.senate.gov/</website><bioguide_id>${b1}</bioguide_id></member>`);
    senateRows.push(`<member><member_full>Beta (X-${code})</member_full><last_name>Beta${code}</last_name><first_name>Sen</first_name><party>X</party><state>${code}</state><phone>(202) 555-0003</phone><website>https://x.senate.gov/</website><bioguide_id>${b2}</bioguide_id></member>`);
    crossArr.push({ id: { bioguide: b1 }, name: { official_full: `Sen Alpha${code}`, last: `Alpha${code}` }, terms: [{ type: 'sen', start: '2015-01-03' }] });
    crossArr.push({ id: { bioguide: b2 }, name: { official_full: `Sen Beta${code}`, last: `Beta${code}` }, terms: [{ type: 'sen', start: '2023-01-03' }] });
  }
}
const houseXml = `<?xml version="1.0"?><MemberData><members>${houseRows.join('')}</members></MemberData>`;
const senateXml = `<?xml version="1.0"?><contact_information>${senateRows.join('')}</contact_information>`;
const crossJson = JSON.stringify(crossArr);

// ── parsers ─────────────────────────────────────────────────────────────────────────────────────
const house = rr.parseHouseXml(houseXml);
const senate = rr.parseSenateXml(senateXml);
const cross = rr.parseCross(crossJson);
ok('house parse count matches synth', house.length === houseRows.length && house.length >= 435);
ok('senate parse count is 100', senate.length === 100);
ok('cross map holds everyone', cross.size === crossArr.length);
ok('entity decode is applied', rr.parseHouseXml('<member><statedistrict>OH01</statedistrict><official-name>A &amp; B</official-name></member>')[0].name === 'A & B');
ok('Clerk legacy code AQ normalizes to AS (American Samoa)', rr.parseHouseXml('<member><statedistrict>AQ00</statedistrict><official-name>Del AS</official-name></member>')[0].stateCode === 'AS');

// ── the load-bearing assert: full coverage, exact grammar, senior/junior correct ────────────────
const built = rr.buildAssignments({ house, senate, cross, targets });
const congressional = targets.filter((t) => /Senator|Representative|Delegate|Resident Commissioner/.test(t));
ok('every congressional target assigned', built.assignments.length === congressional.length);
ok('zero name mismatches', !built.discrepancies.some((d) => d.kind === 'name-mismatch'));
ok('zero vacancies on a full feed', built.vacancies.length === 0);
const mnSenior = built.assignments.find((a) => a.target === 'Senior United States Senator from Minnesota');
ok('senior seat goes to the earlier first term', mnSenior && /Alpha/.test(mnSenior.personName));
ok('every assignment cross-checked on a consistent feed', built.assignments.every((a) => a.crossChecked));

// seniority-unknown: drop one senator from cross → both seats flagged, neither assigned
const cross2 = rr.parseCross(crossJson);
cross2.delete(senate.find((s) => s.stateCode === 'WY').bioguide);
const built2 = rr.buildAssignments({ house, senate, cross: cross2, targets });
ok('unknown seniority flags the state', built2.discrepancies.some((d) => d.kind === 'seniority-unknown' && /Wyoming/.test(d.detail)));
ok('unknown seniority assigns neither seat', !built2.assignments.some((a) => /Senator from Wyoming$/.test(a.target)));

// ── apply: writes, idempotence, supersession-as-diff ────────────────────────────────────────────
const applied = rr.apply({ assignments: built.assignments });
ok('all rows write', applied.failures.length === 0 && applied.stored === built.assignments.length);
ok('cardinality stamped official', applied.cardStored === built.assignments.length);
const again = rr.apply({ assignments: built.assignments });
ok('re-apply is idempotent', again.stored === 0 && again.changes.length === 0 && again.unchanged === built.assignments.length);
const flip = built.assignments.map((a) => (a.target === 'Junior United States Senator from Alaska' ? { ...a, personName: 'Sen Gamma' } : a));
const changed = rr.apply({ assignments: flip });
ok('a new holder supersedes and is reported as a CHANGE', changed.changes.length === 1 && changed.changes[0].now === 'Sen Gamma');
const rosterNow = civic.roster('Junior United States Senator from Alaska');
ok('store shows the new holder current', rosterNow.length === 1 && rosterNow[0].person_name === 'Sen Gamma');

// ── covered stamping: only federal-beat focuses, unioned not clobbered ──────────────────────────
db.setMeta('focus.101.beat', 'federal-officials');
db.setMeta('focus.101.covered', JSON.stringify(['President of the United States']));
db.setMeta('focus.202.beat', 'county-commissions-TX');
db.setMeta('focus.202.covered', JSON.stringify(['Commissioners Court of Travis County, Texas']));
const st = rr.stampCovered({ assignments: built.assignments });
const cov101 = JSON.parse(db.getMeta('focus.101.covered'));
const cov202 = JSON.parse(db.getMeta('focus.202.covered'));
ok('federal focus stamped + prior kept', cov101.length === 1 + built.assignments.length && cov101.includes('President of the United States'));
ok('other beats untouched', cov202.length === 1);
ok('stamp report names the focus', st.stamped.some((s) => String(s.focusId) === '101'));

// ── run(): kill switch, cadence, sanity floor, full circuit with injected fetch ─────────────────
(async () => {
  process.env.ZOE_ROSTER_REFRESH = '0';
  ok('kill switch skips', (await rr.run({})).skipped === 'kill-switch');
  process.env.ZOE_ROSTER_REFRESH = '1';

  const feed = { [rr.SOURCES.house]: houseXml, [rr.SOURCES.senate]: senateXml, [rr.SOURCES.cross]: crossJson };
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => feed[url] });

  const tiny = { ...feed, [rr.SOURCES.house]: `<?xml version="1.0"?><members>${houseRows.slice(0, 3).join('')}</members>` };
  const r1 = await rr.run({ fetchImpl: async (u) => ({ ok: true, status: 200, text: async () => tiny[u] }), force: true });
  ok('sanity floor refuses a truncated feed', r1.ok === false && /sanity floor/.test(r1.reason));

  const r2 = await rr.run({ fetchImpl, force: true, deps: { targets } });
  ok('full run ok', !!r2.ok);
  ok('run summary counts seats', r2.counts && r2.counts.seats === congressional.length);
  ok('run stamps last_ts', !!db.getMeta(rr.META_LAST));
  const r3 = await rr.run({ fetchImpl });
  ok('cadence guard: not due right after a run', r3.skipped === 'not due');

  const r4 = await rr.run({ fetchImpl: async () => { throw new Error('net down'); }, force: true });
  ok('fetch failure is fail-open (no throw, no writes)', r4.ok === false && /fetch failed/.test(r4.reason));

  console.log(`smoke_roster_refresh: ${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
