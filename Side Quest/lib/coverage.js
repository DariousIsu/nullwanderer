/**
 * lib/coverage.js — assemble the FULL seat universe for the sim, so the balance isn't distorted by *which*
 * races happened to be polled. Every House district + every up-Senate seat gets a prior margin from the 538
 * partisan lean (+ incumbency); a POLLED seat overrides its prior. Not-up Senate seats become holdover counts.
 * This replaces `illustrativeSlate()`/the crude holdover lumps — the sim now runs on the real 435 + Senate map.
 *
 * PURE + inject-everything (leans text, polled-by-seat, incumbent-by-seat, senate composition) → offline-testable;
 * main.js supplies the live data (538 CSVs via fs, polled margins from the loop, incumbents/senate class from Echo).
 * A=Dem, B=Rep. Every prior is flagged `source:'lean'` (vs `'polls'`) + `research:true` so unpolled seats can be
 * surfaced for deeper research (Lucas's flag-for-research directive).
 */
'use strict';

const clampSigma = (x) => Math.max(3.5, Math.min(9, x));

// The 35 states with a U.S. Senate seat up in 2026 — Class 2 (33) + the OH & FL specials (appointed seats).
// Full names to match the 538 states keys. Stable public record for the cycle; the rest are holdovers.
const SENATE_2026 = [
  'Alabama', 'Alaska', 'Arkansas', 'Colorado', 'Delaware', 'Georgia', 'Idaho', 'Illinois', 'Iowa', 'Kansas',
  'Kentucky', 'Louisiana', 'Maine', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Montana',
  'Nebraska', 'New Hampshire', 'New Jersey', 'New Mexico', 'North Carolina', 'Oklahoma', 'Oregon',
  'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Virginia', 'West Virginia',
  'Wyoming', 'Ohio', 'Florida',
];

// parse a 538 lean CSV ("id,YEAR\nCA-22,10.3\n…") → { 'CA-22': 10.3, … }. Last column is the lean.
function parseLeanCsv(text) {
  const out = {};
  const lines = String(text == null ? '' : text).trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const k = (parts[0] || '').trim();
    const v = Number(parts[parts.length - 1]);
    if (k && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

// one seat's prior race from its lean (+ incumbency); a polled entry (margin_source==='polls') overrides it.
function seatRace(seat, chamber, lean, opts) {
  const { polled, incumbentParty, incAdv, priorSigma, entities } = opts;
  if (polled && polled.margin_source === 'polls' && polled.margin != null) {
    return { seat, id: seat, chamber, margin: polled.margin, sigma: clampSigma(polled.sigma || 5),
      source: 'polls', margin_source: 'polls', n_polls: polled.n_polls || 0, research: false, entities: entities || [seat] };
  }
  const incTerm = incumbentParty === 'A' ? incAdv : (incumbentParty === 'B' ? -incAdv : 0);
  const margin = lean == null ? 0 : Number((lean + incTerm).toFixed(2));
  return { seat, id: seat, chamber, margin, sigma: priorSigma,
    source: lean == null ? 'prior_flat' : 'lean', margin_source: 'prior', n_polls: 0, research: true, entities: entities || [seat] };
}

/**
 * Build the full slate + holdovers for forecast_sim.
 * opts: {
 *   districts: {'CA-22':lean,…} (538, all 435),  states: {'Arizona':lean,…} (538, 50+DC),
 *   senateUp: ['Arizona','Texas',…] (states with a Senate seat up this cycle),
 *   senateHoldovers: { A, B } (party counts for the NOT-up Senate seats — from Echo),
 *   polledBySeat: { 'H-CA-22': {margin, margin_source, sigma, n_polls}, 'S-AZ': {…} },
 *   incumbentBySeat: { 'H-CA-22':'B', 'S-ME':'B', … },
 *   cfg: { incAdv=2, priorSigmaHouse=8, priorSigmaSenate=7 }
 * }
 * → { races:[…435 house + senate-up…], holdovers:{house:{A:0,B:0}, senate:{A,B}}, majority:{house:218,senate:51},
 *     counts:{house_total, senate_up, polled, lean} }
 */
function buildCoverage(opts = {}) {
  const districts = opts.districts || {};
  const states = opts.states || {};
  const senateUp = new Set(opts.senateUp || []);
  const polledBySeat = opts.polledBySeat || {};
  const incumbentBySeat = opts.incumbentBySeat || {};
  const c = { incAdv: 2, priorSigmaHouse: 8, priorSigmaSenate: 7, ...(opts.cfg || {}) };

  const STATE_ABBR = opts.stateAbbr || require('./forecast_registry').STATE_ABBR;   // full-name → USPS
  const races = [];

  // HOUSE — all 435 districts (every seat is up)
  for (const d in districts) {                    // d = 'CA-22'
    const seat = 'H-' + d;
    races.push(seatRace(seat, 'house', districts[d], {
      polled: polledBySeat[seat], incumbentParty: incumbentBySeat[seat],
      incAdv: c.incAdv, priorSigma: c.priorSigmaHouse, entities: [d],
    }));
  }

  // SENATE — the seats up this cycle become races (state lean prior, polled override); rest are holdovers.
  let senate_up = 0;
  for (const stateName of senateUp) {
    const abbr = STATE_ABBR[String(stateName).toLowerCase()] || String(stateName).toUpperCase().slice(0, 2);
    const seat = 'S-' + abbr;
    races.push(seatRace(seat, 'senate', states[stateName], {
      polled: polledBySeat[seat], incumbentParty: incumbentBySeat[seat],
      incAdv: c.incAdv, priorSigma: c.priorSigmaSenate, entities: [stateName, abbr],
    }));
    senate_up++;
  }

  const holdovers = {
    house: { A: 0, B: 0 },                          // all 435 House seats are races
    senate: opts.senateHoldovers || { A: 0, B: 0 }, // the not-up Senate seats, by current party (from Echo)
  };
  const polled = races.filter((r) => r.source === 'polls').length;
  return {
    races, holdovers,
    majority: { house: 218, senate: 51 },
    counts: { house_total: Object.keys(districts).length, senate_up, races: races.length, polled, lean: races.length - polled },
  };
}

// map a loop race (forecast_registry shape: chamber + state + district) → a seat id matching the 538 keys.
// house → 'H-<ABBR>-<district>' (no zero-pad, e.g. H-NH-2); senate → 'S-<ABBR>'. null if unresolvable.
function seatIdForRace(race, stateAbbr) {
  if (!race || !race.chamber) return null;
  const ABBR = stateAbbr || require('./forecast_registry').STATE_ABBR;
  const toAbbr = (s) => {
    if (!s) return null;
    const low = String(s).toLowerCase();
    if (ABBR[low]) return ABBR[low];
    return String(s).length === 2 ? String(s).toUpperCase() : null;
  };
  const abbr = toAbbr(race.state) || toAbbr(race.stateAbbr) || toAbbr((race.geo || '').split('-')[0]);
  if (!abbr) return null;
  if (race.chamber === 'senate') return 'S-' + abbr;
  if (race.chamber === 'house' && race.district != null) return 'H-' + abbr + '-' + Number(race.district);
  return null;
}

module.exports = { parseLeanCsv, seatRace, buildCoverage, seatIdForRace, SENATE_2026 };
