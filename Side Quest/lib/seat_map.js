/**
 * lib/seat_map.js — the SEAT UNIVERSE + Echo-native candidate→party, read from the MAIN DATABASE (Echo).
 *
 * Lucas's point: every incumbent + filed 2026 candidate is ALREADY in Echo (the FEC bulk is mended in) —
 * candidates don't need to be scraped, they need to be READ + disambiguated. Echo holds ~5,700 person
 * records for the 2026 cycle (entity_subtype us_senator/us_representative) whose summary carries structured
 * FEC fields:  `party: REP|DEM`,  `office: S ME 00` / `H AL 01`  (chamber + state + district),  `cycle: 2026`.
 *
 * This module PARSES those records into (a) the complete seat universe (every Senate seat + House district
 * with its candidate set) and (b) a SYNC `partyOf(name)` sourced from Echo — exact, offline, no FEC rate
 * limit (upgrades the live-FEC fuzzy resolver in candidate_party.js). PURE cores over record arrays →
 * offline-testable with the real record shapes; the live reader injects the Echo query (echo_suit, read-only).
 *
 * SCOPE: this is the Phase-1 substrate. The per-seat PRIOR MARGIN (Lucas's spec: past-two-election margins +
 * a Trump-lean counter-variable, unpolled seats flagged for research) is Phase 2 — it needs historical
 * election RESULTS, which are NOT structured in Echo (a real data-acquisition task, tracked in the handoff).
 */
'use strict';

const cp = require('./candidate_party');   // partyCode (REP→B/DEM→A), lastNameOf, norm — shared party convention

// "S ME 00" → { chamber:'senate', state:'ME', district:null };  "H AL 01" → { chamber:'house', state:'AL', district:1 }
function parseOffice(office) {
  const m = String(office == null ? '' : office).trim().match(/^([SH])\s+([A-Za-z]{2})\s+(\d{1,2})/);
  if (!m) return null;
  const chamber = m[1].toUpperCase() === 'S' ? 'senate' : 'house';
  const district = chamber === 'house' ? Number(m[3]) : null;   // Senate district code is 00
  return { chamber, state: m[2].toUpperCase(), district };
}

// stable seat key: "S-ME" (Senate) / "H-AL-01" (House district)
function seatId(chamber, state, district) {
  return chamber === 'senate' ? `S-${state}` : `H-${state}-${String(district).padStart(2, '0')}`;
}

// pull a structured field out of an Echo record summary ("party: REP", "office: H AL 01", "cycle: 2026")
function field(summary, key) {
  const m = String(summary == null ? '' : summary).match(new RegExp(key + '\\s*:\\s*([^\\n]+)', 'i'));
  return m ? m[1].trim() : null;
}

// one Echo candidate entity {name, summary, external_id?} → normalized candidate, or null if unusable.
function parseRecord(rec) {
  if (!rec) return null;
  const summary = rec.summary || '';
  const office = parseOffice(field(summary, 'office'));
  if (!office) return null;                                     // no parseable seat → skip
  const partyRaw = field(summary, 'party');                     // 'REP' | 'DEM' | ...
  const cycle = Number(field(summary, 'cycle')) || null;
  const displayName = String(rec.name || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();   // strip " [S6ME00159]"
  const fecId = (String(rec.name || '').match(/\[([SH]\w+)\]/) || [])[1]
    || (String(rec.external_id || '').match(/FEC:(\S+)/) || [])[1] || null;
  return {
    name: displayName, party: cp.partyCode(partyRaw), party_raw: partyRaw || null,
    chamber: office.chamber, state: office.state, district: office.district,
    seat: seatId(office.chamber, office.state, office.district), fecId, cycle,
  };
}

/**
 * PURE — Echo candidate records → the seat universe for a cycle.
 * Returns { [seatId]: { seat, chamber, state, district, candidates:[{name,party,fecId}], parties:{A,B,other} } }.
 * Dedups candidates by fecId (Echo carries multiple rows per person).
 */
function buildSeatUniverse(records, { cycle = 2026 } = {}) {
  const seats = {};
  const seenByCand = {};
  for (const rec of (Array.isArray(records) ? records : [])) {
    const c = parseRecord(rec);
    if (!c || (cycle && c.cycle && c.cycle !== cycle)) continue;
    const s = seats[c.seat] || (seats[c.seat] = { seat: c.seat, chamber: c.chamber, state: c.state, district: c.district, candidates: [], parties: { A: 0, B: 0, other: 0 } });
    const dedupKey = c.seat + '|' + (c.fecId || cp.norm(c.name));
    if (seenByCand[dedupKey]) continue;
    seenByCand[dedupKey] = true;
    s.candidates.push({ name: c.name, party: c.party, fecId: c.fecId });
    s.parties[c.party === 'A' ? 'A' : c.party === 'B' ? 'B' : 'other']++;
  }
  return seats;
}

// summary counts over a universe (how much of the map we actually have)
function universeStats(seats) {
  const list = Object.values(seats || {});
  return {
    seats: list.length,
    senate: list.filter((s) => s.chamber === 'senate').length,
    house: list.filter((s) => s.chamber === 'house').length,
    candidates: list.reduce((n, s) => n + s.candidates.length, 0),
    contested: list.filter((s) => s.parties.A > 0 && s.parties.B > 0).length,   // has both a D and an R filed
  };
}

/**
 * PURE — a SYNC partyOf(name) sourced from Echo records (exact, no network). Matches on normalized full name,
 * then surname fallback. Returns 'A'(Dem) | 'B'(Rep) | null. Composes with candidate_party (Echo first, then
 * live FEC for anyone not yet filed / not in the bulk).
 */
function buildPartyOf(records) {
  const byName = new Map(), bySurname = new Map();
  for (const rec of (Array.isArray(records) ? records : [])) {
    const c = parseRecord(rec);
    if (!c || !c.party) continue;
    byName.set(cp.norm(c.name), c.party);
    const ln = cp.lastNameOf(c.name);
    if (ln && !bySurname.has(ln)) bySurname.set(ln, c.party);
    else if (ln && bySurname.get(ln) !== c.party) bySurname.set(ln, null);   // ambiguous surname → don't guess
  }
  const partyOf = (choice) => {
    const n = cp.norm(choice);
    if (byName.has(n)) return byName.get(n);
    const ln = cp.lastNameOf(choice);
    return ln && bySurname.get(ln) != null ? bySurname.get(ln) : null;
  };
  return { partyOf, byName, size: byName.size };
}

/**
 * LIVE — read the cycle's candidate records from Echo (read-only) via an injected `query`, then build the
 * universe + partyOf. `query()` → an array of {name, summary, external_id} rows (echo_suit / db_query-backed).
 * Fail-soft → empty. NEVER writes Echo.
 */
async function loadFromEcho({ query, cycle = 2026 } = {}) {
  let records = [];
  try { records = (typeof query === 'function' ? await query({ cycle }) : []) || []; } catch { records = []; }
  const seats = buildSeatUniverse(records, { cycle });
  const { partyOf, size } = buildPartyOf(records);
  return { seats, partyOf, stats: { ...universeStats(seats), party_index: size, records: records.length } };
}

module.exports = { parseOffice, seatId, field, parseRecord, buildSeatUniverse, universeStats, buildPartyOf, loadFromEcho };
