/* lib/roster_refresh.js — the ROSTER-REFRESH curation organ.
 *
 * Why this exists (2026-08-07): "keep the elected-officials data clean and current" is CURATION,
 * but the only engine a validate-depth beat had was the directed RESEARCH loop — 543 federal seats
 * × multi-step LLM passes each, at research-lane pace. Under quota deferral that loop degenerated
 * into a false-coverage grinder (267/270 covered targets validated-by-nothing, repaired 08-07).
 * Roster validation of a finite elected body with an AUTHORITATIVE MACHINE-READABLE source is a
 * fetch → diff → update → flag pass, not a research project. The LLM stays for what it is good at:
 * the flagged discrepancies.
 *
 * v1 scope: the FEDERAL beat (100 senators + 435 representatives + 6 delegates). The executive
 * (President/VP) is out of feed scope and stays with the research sweep. State legislatures etc.
 * keep their research path until this organ grows per-state sources.
 *
 * The validation contract (lib/beats.js validationGoal) is satisfied structurally:
 *   - officeholder vs the OFFICIAL government source (House Clerk XML / Senate XML),
 *   - cross-checked ONCE against an independent source (the @unitedstates legislators dataset),
 *   - vacancies / changes / discrepancies FLAGGED, never silently resolved.
 * Writes ride the EXISTING stores and their own doctrine: civic_store supersession IS the change
 * diff (a new holder supersedes the old row and reports it); cardinality 'official' outranks every
 * researched count. Seat-grain bodies (1 seat each) mirror the beat's target grain.
 *
 * Fail-open everywhere: any fetch/parse failure, or a feed that fails the sanity floor, means NO
 * writes and no covered stamping — a truncated feed must never supersede good rows. Kill switch
 * ZOE_ROSTER_REFRESH=0. Cadence: weekly (rosters churn on elections and deaths, not daily).
 */
'use strict';

const SOURCES = {
  house: 'https://clerk.house.gov/xml/lists/MemberData.xml',
  senate: 'https://www.senate.gov/general/contact_information/senators_cfm.xml',
  cross: 'https://unitedstates.github.io/congress-legislators/legislators-current.json',
};
// STATE TIER (2026-08-07): Openstates current-people bulk CSVs — a maintained aggregation of each
// legislature's official site, keyless, one fetch per state. Recorded as sourceKind 'aggregator'
// (honest: one aggregator, not the official page itself); each member row carries its own official
// source URL from the feed's `sources` column when present.
const OS_STATE_URL = (code) => `https://data.openstates.org/people/current/${String(code).toLowerCase()}.csv`;
const CADENCE_MS = 6.5 * 24 * 3600 * 1000;   // "weekly" with slack so a daily tick lands it
const META_LAST = 'roster_refresh.last_ts';
const BEAT_ID = 'federal-officials';

// Territory delegates (mirror of lib/beats.js HOUSE_DELEGATES — the produced names are VERIFIED
// against the beat's own enumerate() below, so drift becomes a flagged discrepancy, never a silent
// mis-stamp).
const DELEGATE_CODES = new Set(['DC', 'PR', 'AS', 'GU', 'MP', 'VI']);

function _db(deps) { return (deps && deps.db) || require('./db'); }

// ── tolerant flat-XML field extraction (both feeds are flat known shapes; no XML dep) ────────────
function _decode(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
}
function _tag(block, name) {
  const m = String(block).match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? _decode(m[1]) : '';
}
function _blocks(xml, name) {
  return String(xml).match(new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`, 'gi')) || [];
}

// House Clerk MemberData.xml → one row per seat. A seat listed with no member name is a VACANCY
// signal, kept (not dropped) so the diff can flag it.
function parseHouseXml(xml) {
  const out = [];
  for (const b of _blocks(xml, 'member')) {
    const sd = _tag(b, 'statedistrict');                       // e.g. "AK00", "CA12", "DC00"
    if (!/^[A-Z]{2}\d{2}$/.test(sd)) continue;
    // The Clerk's XML uses legacy codes for one territory: AQ = American Samoa (measured live
    // 2026-08-07 — the only non-USPS code in the feed). Normalize to USPS so the name join lands.
    const code = sd.slice(0, 2) === 'AQ' ? 'AS' : sd.slice(0, 2);
    out.push({
      stateCode: code,
      districtNum: parseInt(sd.slice(2), 10),                  // 0 = At-Large or territory delegate
      name: _tag(b, 'official-name') || _tag(b, 'namelist'),
      firstName: _tag(b, 'firstname'),                         // clean split fields for CRM matching
      lastName: _tag(b, 'lastname'),                           // (official-name carries middles/suffixes)
      party: _tag(b, 'party'),
      phone: _tag(b, 'phone'),
      bioguide: _tag(b, 'bioguideID'),
    });
  }
  return out;
}

// Senate contact XML → one row per sitting senator.
function parseSenateXml(xml) {
  const out = [];
  for (const b of _blocks(xml, 'member')) {
    const state = _tag(b, 'state');
    if (!/^[A-Z]{2}$/.test(state)) continue;
    out.push({
      stateCode: state,
      name: `${_tag(b, 'first_name')} ${_tag(b, 'last_name')}`.replace(/\s+/g, ' ').trim(),
      firstName: _tag(b, 'first_name'),
      lastName: _tag(b, 'last_name'),
      party: _tag(b, 'party'),
      phone: _tag(b, 'phone'),
      website: _tag(b, 'website'),
      bioguide: _tag(b, 'bioguide_id'),
    });
  }
  return out;
}

// legislators-current.json → bioguide → { officialFull, firstSenStartTs } (the independent
// cross-check + the senior/junior clock: seniority = earlier FIRST senate term start).
function parseCross(json) {
  const map = new Map();
  const arr = typeof json === 'string' ? JSON.parse(json) : json;
  for (const p of arr || []) {
    const bio = p && p.id && p.id.bioguide;
    if (!bio) continue;
    let firstSen = null;
    for (const t of p.terms || []) {
      if (t.type !== 'sen' || !t.start) continue;
      const ts = Date.parse(t.start);
      if (isFinite(ts) && (firstSen == null || ts < firstSen)) firstSen = ts;
    }
    map.set(bio, {
      officialFull: (p.name && (p.name.official_full || `${p.name.first} ${p.name.last}`)) || '',
      lastName: (p.name && p.name.last) || '',
      firstSenStartTs: firstSen,
    });
  }
  return map;
}

const _ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`; };

// The beat's own target list is the naming ground truth. Passed in for tests; defaults to the
// live beat so the organ can never drift from what the sweep enumerates.
function federalTargetSet() {
  const beats = require('./beats');
  const fed = (beats.electedOfficialsSubBeats() || []).find((b) => b.id === BEAT_ID);
  return fed ? fed.enumerate() : [];
}

// The state-legislature beats (one per state; id `state-legislature-<code>`, 1-2 chamber targets).
function stateLegBeats() {
  const beats = require('./beats');
  return (beats.electedOfficialsSubBeats() || []).filter((b) => /^state-legislature-/.test(b.id));
}

// ── minimal correct CSV (RFC-4180 quoting: quoted fields, doubled quotes, commas/newlines inside) ─
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map((r) => { const o = {}; head.forEach((h, i) => { o[h] = r[i] == null ? '' : r[i]; }); return o; });
}

// Openstates rows → the beat's chamber targets. Unicameral (one target) takes every member as a
// State Senator (Nebraska's members are senators). The member's own official page (first non-
// aggregator URL in `sources`) rides as sourceUrl when present.
function buildStateRosters({ rows = [], beat } = {}) {
  const targets = beat.enumerate();
  const uni = targets.length === 1;
  const chambers = new Map(targets.map((t) => [t, []]));
  const discrepancies = [];
  const officialUrl = (r) => {
    const first = String(r.sources || '').split(';').map((x) => x.trim())
      .find((u) => /^https?:/.test(u) && !/openstates|ballotpedia|wikipedia|votesmart|justfacts/i.test(u));
    return first || OS_STATE_URL(beat.stateCode);
  };
  for (const r of rows) {
    if (!r.name) continue;
    const ch = String(r.current_chamber || '').toLowerCase();
    const target = uni ? targets[0] : (ch === 'upper' ? targets[0] : ch === 'lower' ? targets[1] : null);
    if (!target) { discrepancies.push({ kind: 'chamber-unknown', detail: `${beat.stateCode}: ${r.name} chamber="${r.current_chamber}"` }); continue; }
    chambers.get(target).push({
      personName: r.name,
      firstName: r.given_name || String(r.name).split(/\s+/)[0] || null,
      lastName: r.family_name || String(r.name).split(/\s+/).pop() || null,
      role: (uni || ch === 'upper') ? 'State Senator' : 'State Representative',
      party: r.current_party || null,
      district: r.current_district || null,
      email: r.email || null,
      phone: r.capitol_voice || r.district_voice || null,
      sourceUrl: officialUrl(r),
      ocdId: r.id || null,
    });
  }
  for (const [t, list] of chambers) if (!list.length) discrepancies.push({ kind: 'empty-chamber', detail: `${t}: feed produced no members` });
  return { chambers: [...chambers].map(([target, members]) => ({ target, members })), discrepancies };
}

// One state's pass: fetch → build → upsert chamber bodies → recordRoster (departures = the change
// flag) → stamp the state's beat coverage. Per-state fail-soft; a broken state never blocks the rest.
async function runStatePass({ deps = {}, fetchGet, beats = null } = {}) {
  const civic = (deps && deps.civic) || require('./civic_store');
  const list = beats || stateLegBeats();
  const out = { states: 0, members: 0, departed: [], skipped: [], discrepancies: [], people: [] };
  for (const beat of list) {
    try {
      const rows = parseCsv(await fetchGet(OS_STATE_URL(beat.stateCode)));
      // sanity floor: the smallest legislature (Alaska) seats 60; half a feed writes nothing.
      if (rows.length < 40) { out.skipped.push(`${beat.stateCode}: ${rows.length} rows (floor)`); continue; }
      const built = buildStateRosters({ rows, beat });
      out.discrepancies.push(...built.discrepancies);
      const stamped = [];
      for (const { target, members } of built.chambers) {
        if (!members.length) continue;
        const ub = civic.upsertBody({ title: target, level: 'state', function: 'governing', state: beat.stateCode, officialUrl: OS_STATE_URL(beat.stateCode) }, { deps });
        if (!ub.ok) { out.discrepancies.push({ kind: 'body-write', detail: `${target}: ${ub.reason || 'failed'}` }); continue; }
        const rr = civic.recordRoster({ bodyKey: ub.bodyKey, members, sourceKind: 'aggregator' }, { deps });
        out.members += members.length;
        for (const dep of rr.departed) out.departed.push({ target, person: dep });
        if (rr.failures.length) out.discrepancies.push({ kind: 'member-write', detail: `${target}: ${rr.failures.length} failure(s)` });
        stamped.push({ target });
        for (const m of members) out.people.push({ ...m, kind: 'state', stateCode: beat.stateCode, chamber: target });
      }
      if (stamped.length) stampCovered({ assignments: stamped, beatId: beat.id, deps });
      out.states++;
    } catch (e) { out.skipped.push(`${beat.stateCode}: ${e.message}`); }
  }
  return out;
}

// Compose seat assignments in the beat's exact target-name grammar, verified against `targets`.
// Anything that does not land on a real target name becomes a DISCREPANCY — never a silent stamp.
function buildAssignments({ house = [], senate = [], cross = new Map(), targets = [] } = {}) {
  const tset = new Set(targets);
  const stateNameOf = new Map();          // "Senior United States Senator from Alaska" → code map
  for (const t of targets) {
    let m = t.match(/^(?:Senior|Junior) United States Senator from (.+)$/);
    if (m) { stateNameOf.set(`SEN:${m[1]}`, m[1]); continue; }
  }
  // full state name lookup: derive from the target strings themselves (they embed the names the
  // beat used), keyed by trying each senate/house state code against the gazetteer-free approach
  // below — we reconstruct names via the targets, so we need code→name. Build it from beats' own
  // helper data indirectly: the senate feed gives codes; targets give names; match by trying the
  // representative targets ("…for <Name>'s …") and senator targets. A code with no name match is a
  // discrepancy downstream.
  const codeToName = _codeToNameFromTargets(targets);

  const assignments = [];      // { target, personName, role, party, phone, sourceUrl, crossChecked, bioguide }
  const discrepancies = [];    // { kind, detail }
  const senBySt = new Map();
  for (const s of senate) { if (!senBySt.has(s.stateCode)) senBySt.set(s.stateCode, []); senBySt.get(s.stateCode).push(s); }

  // SENATE: rank the pair by first senate-term start (earlier = Senior). Unknown seniority for
  // either member → both seats flagged, neither stamped (assigning ranks by guess would be the
  // exact fabrication this organ exists to end).
  for (const [code, pair] of senBySt) {
    const stateName = codeToName.get(code);
    if (!stateName) { discrepancies.push({ kind: 'state-name', detail: `senate feed state ${code} matches no target name` }); continue; }
    if (pair.length !== 2) {
      discrepancies.push({ kind: 'senate-count', detail: `${stateName}: feed lists ${pair.length} senator(s) — vacancy or feed anomaly` });
      continue;
    }
    const ranked = pair.map((s) => ({ ...s, senStart: (cross.get(s.bioguide) || {}).firstSenStartTs ?? null }));
    if (ranked.some((r) => r.senStart == null)) {
      discrepancies.push({ kind: 'seniority-unknown', detail: `${stateName}: ${ranked.filter((r) => r.senStart == null).map((r) => r.name).join(', ')} missing from the cross-check dataset — cannot rank senior/junior` });
      continue;
    }
    ranked.sort((a, b) => a.senStart - b.senStart || String(a.lastName).localeCompare(String(b.lastName)));
    const roles = ['Senior', 'Junior'];
    ranked.forEach((s, i) => {
      const target = `${roles[i]} United States Senator from ${stateName}`;
      if (!tset.has(target)) { discrepancies.push({ kind: 'name-mismatch', detail: `built "${target}" — not a beat target` }); return; }
      assignments.push({
        target, personName: s.name, firstName: s.firstName || null, lastName: s.lastName || null,
        role: `${roles[i]} United States Senator`, party: s.party || null,
        phone: s.phone || null, sourceUrl: SOURCES.senate, bioguide: s.bioguide || null,
        crossChecked: _nameAgrees(cross.get(s.bioguide), s.lastName),
      });
    });
  }

  // HOUSE: numbered districts, At-Large single-district states, and territory delegates.
  for (const h of house) {
    const stateName = codeToName.get(h.stateCode);
    if (!stateName) { discrepancies.push({ kind: 'state-name', detail: `house feed state ${h.stateCode} matches no target name` }); continue; }
    if (!h.name) { discrepancies.push({ kind: 'vacant-listed', detail: `${stateName} ${h.districtNum || 'At-Large'}: seat listed with no member` }); continue; }
    let target, role;
    if (DELEGATE_CODES.has(h.stateCode)) {
      role = h.stateCode === 'PR' ? 'Resident Commissioner' : 'Delegate';
      target = `${role} to the United States House of Representatives from ${stateName}`;
    } else if (h.districtNum === 0) {
      role = 'United States Representative';
      target = `United States Representative for ${stateName}'s At-Large Congressional District`;
    } else {
      role = 'United States Representative';
      target = `United States Representative for ${stateName}'s ${_ord(h.districtNum)} Congressional District`;
    }
    if (!tset.has(target)) { discrepancies.push({ kind: 'name-mismatch', detail: `built "${target}" — not a beat target` }); continue; }
    assignments.push({
      target, personName: h.name, firstName: h.firstName || null, lastName: h.lastName || null,
      role, party: h.party || null, phone: h.phone || null,
      sourceUrl: SOURCES.house, bioguide: h.bioguide || null,
      crossChecked: _nameAgrees(cross.get(h.bioguide), h.lastName || h.name.split(/\s+/).pop()),
    });
  }

  // VACANCIES: congressional targets no feed row landed on. Flagged for follow-up, never stamped —
  // "not in the feed" is a somevalue-class observation, not proof of vacancy.
  const assigned = new Set(assignments.map((a) => a.target));
  const vacancies = targets.filter((t) => !assigned.has(t) && /Senator|Representative|Delegate|Resident Commissioner/.test(t));
  return { assignments, discrepancies, vacancies };
}

function _nameAgrees(crossRec, lastName) {
  if (!crossRec) return false;
  const a = String(crossRec.lastName || crossRec.officialFull || '').toLowerCase();
  return !!lastName && a.includes(String(lastName).toLowerCase());
}

// code → full state name, recovered from the target strings themselves via the senate pairs and
// house feed states — the beat targets embed every name we are allowed to use. Static 50-state
// tables exist in beats.js but are not exported; deriving from targets keeps ONE naming authority.
function _codeToNameFromTargets(targets) {
  const names = new Set();
  for (const t of targets) {
    let m = t.match(/^(?:Senior|Junior) United States Senator from (.+)$/)
      || t.match(/^United States Representative for (.+?)'s (?:At-Large|\d+\w{2}) Congressional District$/)
      || t.match(/^(?:Delegate|Resident Commissioner) to the United States House of Representatives from (.+)$/);
    if (m) names.add(m[1]);
  }
  // USPS code ↔ name (static, uncontroversial; only used to join feed codes to target names)
  const USPS = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico', AS: 'American Samoa', GU: 'Guam', MP: 'Northern Mariana Islands', VI: 'U.S. Virgin Islands' };
  const out = new Map();
  for (const [code, name] of Object.entries(USPS)) {
    if (names.has(name)) { out.set(code, name); continue; }
    // the beat may spell a territory differently (e.g. "Virgin Islands") — take the unique
    // target name that CONTAINS the USPS name's distinctive tail, else leave unmapped (→ flagged).
    const loose = [...names].filter((n) => n.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(n.toLowerCase()));
    if (loose.length === 1) out.set(code, loose[0]);
  }
  return out;
}

// ── write-through: the existing stores, their own doctrine ───────────────────────────────────────
function apply({ assignments = [], deps = {} } = {}) {
  const civic = (deps && deps.civic) || require('./civic_store');
  const cardinality = (deps && deps.cardinality) || require('./cardinality');
  const res = { stored: 0, unchanged: 0, changes: [], cardStored: 0, failures: [] };
  for (const a of assignments) {
    try {
      const ub = civic.upsertBody({ title: a.target, level: 'other', function: 'governing', officialUrl: a.sourceUrl }, { deps });
      if (!ub.ok) { res.failures.push(`${a.target}: body ${ub.reason || 'failed'}`); continue; }
      // Seat-grain door: one live holder per seat-body; a new officeholder REPLACES the old row
      // (that replacement is the validation finding this organ exists to surface).
      const r = civic.recordSeatHolder({
        bodyKey: ub.bodyKey, personName: a.personName, role: a.role, party: a.party,
        phone: a.phone, sourceUrl: a.sourceUrl, sourceKind: 'official',
        confidence: a.crossChecked ? 0.95 : 0.85,
      }, { deps });
      if (!r.ok) { res.failures.push(`${a.target}: membership ${r.reason || 'failed'}`); continue; }
      if (r.replaced && r.replaced.length) res.changes.push({ target: a.target, now: a.personName, was: r.replaced });
      else if (r.unchanged || r.regraded) res.unchanged++;
      else res.stored++;
      const c = cardinality.record(a.target, { seats: 1, sourceKind: 'official', sourceRef: a.sourceUrl });
      if (c && c.stored) res.cardStored++;
    } catch (e) { res.failures.push(`${a.target}: ${e.message}`); }
  }
  return res;
}

// Stamp validated targets as covered on every focus running the given beat — honest coverage
// this time: each stamped name carries a store membership row written above.
function stampCovered({ assignments = [], beatId = BEAT_ID, deps = {} } = {}) {
  const db = _db(deps);
  const stamped = [];
  try {
    for (const key of db.getMetaKeysLike('focus.%.covered')) {
      const focusId = key.split('.')[1];
      if (db.getMeta(`focus.${focusId}.beat`) !== beatId) continue;
      let covered = []; try { covered = JSON.parse(db.getMeta(key) || '[]') || []; } catch { covered = []; }
      const have = new Set(covered.map((c) => String(c).toLowerCase()));
      let added = 0;
      for (const a of assignments) {
        if (!have.has(a.target.toLowerCase())) { covered.push(a.target); have.add(a.target.toLowerCase()); added++; }
      }
      if (added) { db.setMeta(key, JSON.stringify(covered)); stamped.push({ focusId, added, total: covered.length }); }
    }
  } catch (e) { return { stamped, error: e.message }; }
  return { stamped };
}

// ── CRM WRITE-THROUGH (2026-08-07, Lucas: "not all dbs were integrated") ─────────────────────────
// The CRM (electoral.contact, the ultimate person store) has dedicated join keys for exactly what
// the feeds carry: Bioguide_Id__c (federal) and OCD_Person_Id__c (Openstates). Batch probes (two
// set-queries per run, never per-person scans) → per-person resolution → update_contact with
// FILL-ONLY-EMPTY discipline: an existing CRM value is never overwritten; the one exception is
// stamping the empty ID column on a confident name match — that stamp IS the durable integration,
// making every future run an O(1) ID join. Bounded per run with a resumable cursor (weekly wrap).
// All writes go through Echo's update_contact door (whitelist + per-field provenance findings).
const CRM_CURSOR = 'roster_refresh.crm_cursor';
const _PARTY_CODE = { democratic: 'D', democrat: 'D', republican: 'R', independent: 'I', libertarian: 'L', green: 'G' };
const _esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");

async function crmPass({ deps = {}, dispatch, people = [], limit = 250, now = Date.now() } = {}) {
  if (String(process.env.ZOE_ROSTER_CRM || '1') === '0') return { skipped: 'kill-switch' };
  if (typeof dispatch !== 'function') return { skipped: 'no echo dispatch' };
  const db = _db(deps);
  const ordered = [...people].sort((a, b) => String(a.personName).localeCompare(String(b.personName)));
  let cursor = parseInt(db.getMeta(CRM_CURSOR) || '0', 10) || 0;
  if (cursor >= ordered.length) cursor = 0;
  const batch = ordered.slice(cursor, cursor + Math.max(1, limit));
  const q = async (sql) => {
    const r = await dispatch('db_query', { sql, params: [] });
    const j = JSON.parse((r && r.text) || '{}');
    return j.rows || [];
  };
  const out = { processed: 0, matchedById: 0, matchedByName: 0, updated: 0, fieldsWritten: 0, idStamped: 0, unmatched: [], ambiguous: [], failures: [], cursor: { from: cursor, of: ordered.length } };
  // Name key = FIRST TOKEN of the first name + the clean last name (the feeds carry split fields;
  // official-name strings embed middles/suffixes — "Nicholas J. Begich III" — that exact-equality
  // against CRM FirstName+LastName would miss). Probe the CRM by LAST NAME set, resolve client-side.
  const _ft = (s) => String(s || '').trim().split(/\s+/)[0] || '';
  const keyOf = (first, last) => `${_ft(first)} ${String(last || '').trim()}`.replace(/\s+/g, ' ').trim().toLowerCase();
  const personKey = (p) => keyOf(p.firstName || p.personName, p.lastName || String(p.personName).trim().split(/\s+/).pop());
  try {
    const ids = batch.map((p) => p.bioguide || p.ocdId).filter(Boolean);
    const lasts = [...new Set(batch.map((p) => String(p.lastName || String(p.personName).trim().split(/\s+/).pop() || '').trim().toLowerCase()).filter(Boolean))];
    const COLS = 'id, FirstName, LastName, Title, Email, Phone, Party__c, District__c, Jurisdiction__c, MailingState, Active_Elected__c, Bioguide_Id__c, OCD_Person_Id__c';
    const idRows = ids.length ? await q(
      `SELECT ${COLS} FROM electoral.contact WHERE deleted = 0 AND (Bioguide_Id__c IN (${ids.map((i) => `'${_esc(i)}'`).join(',')}) OR OCD_Person_Id__c IN (${ids.map((i) => `'${_esc(i)}'`).join(',')}))`) : [];
    const nameRows = lasts.length ? await q(
      `SELECT ${COLS} FROM electoral.contact WHERE deleted = 0 AND lower(COALESCE(LastName,'')) IN (${lasts.map((n) => `'${_esc(n)}'`).join(',')})`) : [];
    const byBio = new Map(), byOcd = new Map(), byName = new Map();
    for (const r of idRows) { if (r.Bioguide_Id__c) byBio.set(r.Bioguide_Id__c, r); if (r.OCD_Person_Id__c) byOcd.set(r.OCD_Person_Id__c, r); }
    for (const r of nameRows) {
      const k = keyOf(r.FirstName, r.LastName);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(r);
    }
    for (const p of batch) {
      out.processed++;
      let row = (p.bioguide && byBio.get(p.bioguide)) || (p.ocdId && byOcd.get(p.ocdId)) || null;
      let via = row ? 'id' : null;
      if (!row) {
        const cands = byName.get(personKey(p)) || [];
        // A state hint disambiguates same-named contacts; without a unique winner, report — never guess.
        const filtered = cands.length > 1 && p.stateCode ? cands.filter((c) => c.MailingState === p.stateCode || String(c.Jurisdiction__c || '').endsWith(`-${p.stateCode}`)) : cands;
        if (filtered.length === 1) { row = filtered[0]; via = 'name'; }
        else if (cands.length > 1) { out.ambiguous.push(`${p.personName} (${cands.length} candidates)`); continue; }
      }
      if (!row) { out.unmatched.push(p.personName); continue; }
      if (via === 'id') out.matchedById++; else out.matchedByName++;
      const empty = (v) => v == null || String(v).trim() === '';
      const fields = {};
      if (empty(row.Title) && p.role) fields.Title = p.role;
      if (empty(row.Phone) && p.phone) fields.Phone = p.phone;
      if (empty(row.Email) && p.email) fields.Email = p.email;
      if (empty(row.Party__c) && p.party && _PARTY_CODE[String(p.party).toLowerCase()]) fields.Party__c = _PARTY_CODE[String(p.party).toLowerCase()];
      if (empty(row.District__c) && p.district) fields.District__c = String(p.district);
      if (empty(row.Jurisdiction__c)) fields.Jurisdiction__c = p.kind === 'federal' ? 'US' : (p.stateCode ? `US-${p.stateCode}` : undefined);
      if (fields.Jurisdiction__c === undefined) delete fields.Jurisdiction__c;
      if (empty(row.Active_Elected__c)) fields.Active_Elected__c = 1;
      // the durable join: stamp the empty ID column on a name-matched row
      if (via === 'name') {
        if (p.bioguide && empty(row.Bioguide_Id__c)) { fields.Bioguide_Id__c = p.bioguide; out.idStamped++; }
        if (p.ocdId && empty(row.OCD_Person_Id__c)) { fields.OCD_Person_Id__c = p.ocdId; out.idStamped++; }
      }
      if (!Object.keys(fields).length) continue;
      const ur = await dispatch('update_contact', {
        contact_id: row.id, fields, source_url: p.sourceUrl || null, stage: 'complete',
        finding_notes: 'roster-refresh: validated against the official/aggregator roster feed',
      });
      let rep = null; try { rep = JSON.parse((ur && ur.text) || '{}'); } catch { rep = null; }
      if (rep && !rep.error) { out.updated++; out.fieldsWritten += Object.keys(fields).length; }
      else out.failures.push(`${p.personName}: ${rep && rep.error ? rep.error : 'update failed'}`);
    }
    try { db.setMeta(CRM_CURSOR, String(cursor + batch.length >= ordered.length ? 0 : cursor + batch.length)); } catch {}
  } catch (e) { out.error = e.message; }
  return out;
}

function _summary({ assignments, discrepancies, vacancies, applied }) {
  const x = assignments.filter((a) => a.crossChecked).length;
  return `roster-refresh (federal): ${assignments.length} seats validated against the official rosters `
    + `(${x} cross-checked), ${applied.stored} new membership row(s), ${applied.unchanged} unchanged, `
    + `${applied.changes.length} CHANGE(s) superseded, ${vacancies.length} target(s) with no feed row, `
    + `${discrepancies.length} discrepancy(ies)${applied.failures.length ? `, ${applied.failures.length} write failure(s)` : ''}`;
}

// ── the runnable pass ────────────────────────────────────────────────────────────────────────────
async function run({ deps = {}, fetchImpl = null, echoDispatch = null, force = false, now = Date.now() } = {}) {
  if (String(process.env.ZOE_ROSTER_REFRESH || '1') === '0') return { skipped: 'kill-switch' };
  const db = _db(deps);
  if (!force) {
    const last = parseInt(db.getMeta(META_LAST) || '0', 10);
    if (last && now - last < CADENCE_MS) return { skipped: 'not due', last };
  }
  const f = fetchImpl || globalThis.fetch;
  const get = async (url) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try { const r = await f(url, { signal: ctrl.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.text(); }
    finally { clearTimeout(t); }
  };
  let houseXml, senateXml, crossJson;
  try { [houseXml, senateXml, crossJson] = await Promise.all([get(SOURCES.house), get(SOURCES.senate), get(SOURCES.cross)]); }
  catch (e) { return { ok: false, reason: `fetch failed: ${e.message}` }; }

  let house, senate, cross;
  try { house = parseHouseXml(houseXml); senate = parseSenateXml(senateXml); cross = parseCross(crossJson); }
  catch (e) { return { ok: false, reason: `parse failed: ${e.message}` }; }
  // SANITY FLOOR — a truncated or reshaped feed writes NOTHING. Bounds are loose on purpose:
  // vacancies are normal; half a chamber is not.
  if (house.length < 400 || senate.length < 90 || cross.size < 500) {
    return { ok: false, reason: `sanity floor: house=${house.length} senate=${senate.length} cross=${cross.size}` };
  }

  const targets = (deps.targets) || federalTargetSet();
  const built = buildAssignments({ house, senate, cross, targets });
  const applied = apply({ assignments: built.assignments, deps });
  const stamps = stampCovered({ assignments: built.assignments, deps });
  let summary = _summary({ ...built, applied });

  // STATE TIER — per-state fail-soft; a broken feed skips its state, never the run.
  let statePass = null;
  try { statePass = await runStatePass({ deps, fetchGet: get, beats: deps.stateBeats || null }); }
  catch (e) { statePass = { states: 0, members: 0, departed: [], skipped: [`state pass failed: ${e.message}`], discrepancies: [], people: [] }; }
  summary += ` | states: ${statePass.states} refreshed, ${statePass.members} member(s), ${statePass.departed.length} departure(s), ${statePass.skipped.length} skipped`;

  // CRM WRITE-THROUGH — both tiers' people through the fill-only-empty door, bounded + resumable.
  let crm = null;
  const people = [
    ...built.assignments.map((a) => ({ personName: a.personName, role: a.role, party: a.party, phone: a.phone, sourceUrl: a.sourceUrl, bioguide: a.bioguide, kind: 'federal' })),
    ...(statePass.people || []),
  ];
  try { crm = await crmPass({ deps, dispatch: echoDispatch, people, limit: parseInt(process.env.ZOE_ROSTER_CRM_BATCH, 10) || 1000, now }); }
  catch (e) { crm = { error: e.message }; }
  if (crm && !crm.skipped && !crm.error) summary += ` | CRM: ${crm.matchedById + crm.matchedByName}/${crm.processed} matched (${crm.matchedById} by id), ${crm.updated} updated, ${crm.fieldsWritten} field(s) filled, ${crm.idStamped} id(s) stamped, ${crm.unmatched.length} unmatched`;
  else if (crm) summary += ` | CRM: ${crm.skipped || crm.error}`;

  // Report: a note file + the unprompted-delivery door (same door interweave leverage notes ride).
  try {
    const fs = require('fs'); const path = require('path');
    const dir = path.join(__dirname, '..', 'data', 'zoe_workspace', 'notes');
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      `# Roster refresh — ${new Date(now).toISOString()}`, '',
      `Sources: official House Clerk (${SOURCES.house}), official Senate (${SOURCES.senate}), cross-check @unitedstates (${SOURCES.cross}), states via Openstates bulk CSVs`, '',
      summary, '',
      built.vacancies.length ? `## No feed row (follow up — possible vacancy)\n${built.vacancies.map((v) => `- ${v}`).join('\n')}` : '',
      built.discrepancies.length ? `## Federal discrepancies\n${built.discrepancies.map((d) => `- [${d.kind}] ${d.detail}`).join('\n')}` : '',
      applied.changes.length ? `## Federal changes (superseded rows)\n${applied.changes.map((c) => `- ${c.target}: now ${c.now}`).join('\n')}` : '',
      statePass.departed.length ? `## State departures (superseded)\n${statePass.departed.slice(0, 60).map((d) => `- ${d.target}: ${d.person}`).join('\n')}${statePass.departed.length > 60 ? `\n- … +${statePass.departed.length - 60} more` : ''}` : '',
      statePass.skipped.length ? `## States skipped\n${statePass.skipped.map((s) => `- ${s}`).join('\n')}` : '',
      statePass.discrepancies.length ? `## State discrepancies\n${statePass.discrepancies.slice(0, 40).map((d) => `- [${d.kind}] ${d.detail}`).join('\n')}${statePass.discrepancies.length > 40 ? `\n- … +${statePass.discrepancies.length - 40} more` : ''}` : '',
      (crm && crm.unmatched && crm.unmatched.length) ? `## CRM unmatched (no contact found — completion candidates)\n${crm.unmatched.slice(0, 60).map((u) => `- ${u}`).join('\n')}${crm.unmatched.length > 60 ? `\n- … +${crm.unmatched.length - 60} more` : ''}` : '',
      (crm && crm.ambiguous && crm.ambiguous.length) ? `## CRM ambiguous (multiple candidates — needs a human/deeper key)\n${crm.ambiguous.slice(0, 40).map((u) => `- ${u}`).join('\n')}` : '',
      (crm && crm.failures && crm.failures.length) ? `## CRM write failures\n${crm.failures.slice(0, 40).map((u) => `- ${u}`).join('\n')}` : '',
      applied.failures.length ? `## Store write failures\n${applied.failures.map((x) => `- ${x}`).join('\n')}` : '',
    ].filter(Boolean);
    fs.writeFileSync(path.join(dir, `roster-refresh-${new Date(now).toISOString().slice(0, 10)}.md`), lines.join('\n'));
  } catch { /* the report is best-effort; the stores already hold the data */ }
  try { db.insertInbound({ tabUrl: 'note://roster-refresh', speaker: 'system', text: summary, source: 'roster-refresh' }); } catch {}
  try { db.setMeta(META_LAST, String(now)); } catch {}
  return {
    ok: true, summary, stamps,
    counts: { seats: built.assignments.length, changes: applied.changes.length, vacancies: built.vacancies.length, discrepancies: built.discrepancies.length },
    state: { states: statePass.states, members: statePass.members, departed: statePass.departed.length, skipped: statePass.skipped.length },
    crm,
  };
}

module.exports = { run, parseHouseXml, parseSenateXml, parseCross, parseCsv, buildAssignments, buildStateRosters, runStatePass, crmPass, apply, stampCovered, federalTargetSet, stateLegBeats, SOURCES, OS_STATE_URL, CADENCE_MS, META_LAST, CRM_CURSOR, BEAT_ID };
