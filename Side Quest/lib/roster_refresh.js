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
        target, personName: s.name, role: `${roles[i]} United States Senator`, party: s.party || null,
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
      target, personName: h.name, role, party: h.party || null, phone: h.phone || null,
      sourceUrl: SOURCES.house, bioguide: h.bioguide || null,
      crossChecked: _nameAgrees(cross.get(h.bioguide), h.name.split(/\s+/).pop()),
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

// Stamp validated targets as covered on every focus running the federal beat — honest coverage
// this time: each stamped name carries an official-source membership row written above.
function stampCovered({ assignments = [], deps = {} } = {}) {
  const db = _db(deps);
  const stamped = [];
  try {
    for (const key of db.getMetaKeysLike('focus.%.covered')) {
      const focusId = key.split('.')[1];
      if (db.getMeta(`focus.${focusId}.beat`) !== BEAT_ID) continue;
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

function _summary({ assignments, discrepancies, vacancies, applied }) {
  const x = assignments.filter((a) => a.crossChecked).length;
  return `roster-refresh (federal): ${assignments.length} seats validated against the official rosters `
    + `(${x} cross-checked), ${applied.stored} new membership row(s), ${applied.unchanged} unchanged, `
    + `${applied.changes.length} CHANGE(s) superseded, ${vacancies.length} target(s) with no feed row, `
    + `${discrepancies.length} discrepancy(ies)${applied.failures.length ? `, ${applied.failures.length} write failure(s)` : ''}`;
}

// ── the runnable pass ────────────────────────────────────────────────────────────────────────────
async function run({ deps = {}, fetchImpl = null, force = false, now = Date.now() } = {}) {
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
  const summary = _summary({ ...built, applied });

  // Report: a note file + the unprompted-delivery door (same door interweave leverage notes ride).
  try {
    const fs = require('fs'); const path = require('path');
    const dir = path.join(__dirname, '..', 'data', 'zoe_workspace', 'notes');
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      `# Roster refresh — federal — ${new Date(now).toISOString()}`, '',
      `Sources: official House Clerk (${SOURCES.house}), official Senate (${SOURCES.senate}), cross-check @unitedstates (${SOURCES.cross})`, '',
      summary, '',
      built.vacancies.length ? `## No feed row (follow up — possible vacancy)\n${built.vacancies.map((v) => `- ${v}`).join('\n')}` : '',
      built.discrepancies.length ? `## Discrepancies\n${built.discrepancies.map((d) => `- [${d.kind}] ${d.detail}`).join('\n')}` : '',
      applied.changes.length ? `## Changes (superseded rows)\n${applied.changes.map((c) => `- ${c.target}: now ${c.now}`).join('\n')}` : '',
      applied.failures.length ? `## Write failures\n${applied.failures.map((x) => `- ${x}`).join('\n')}` : '',
    ].filter(Boolean);
    fs.writeFileSync(path.join(dir, `roster-refresh-${new Date(now).toISOString().slice(0, 10)}.md`), lines.join('\n'));
  } catch { /* the report is best-effort; the stores already hold the data */ }
  try { db.insertInbound({ tabUrl: 'note://roster-refresh', speaker: 'system', text: summary, source: 'roster-refresh' }); } catch {}
  try { db.setMeta(META_LAST, String(now)); } catch {}
  return { ok: true, summary, counts: { seats: built.assignments.length, changes: applied.changes.length, vacancies: built.vacancies.length, discrepancies: built.discrepancies.length }, stamps };
}

module.exports = { run, parseHouseXml, parseSenateXml, parseCross, buildAssignments, apply, stampCovered, federalTargetSet, SOURCES, CADENCE_MS, META_LAST, BEAT_ID };
