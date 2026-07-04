/**
 * Offline smoke for lib/coverage.js — full seat-universe assembly. Run: node scripts/smoke_coverage.js
 */
const C = require('../lib/coverage');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

// parseLeanCsv
const leans = C.parseLeanCsv('district,2022\nCA-22,10.3\nTX-1,-50.4\nNY-14,56.8\n');
ok('parseLeanCsv: header skipped, values parsed', leans['CA-22'] === 10.3 && leans['TX-1'] === -50.4 && Object.keys(leans).length === 3);

// seatRace: poll overrides lean; lean + incumbency otherwise
const polledSeat = C.seatRace('H-CA-22', 'house', 10.3, { polled: { margin: 5.2, margin_source: 'polls', sigma: 5, n_polls: 3 }, incAdv: 2, priorSigma: 8 });
ok('seatRace: polled overrides lean', polledSeat.margin === 5.2 && polledSeat.source === 'polls' && polledSeat.research === false);
const leanSeat = C.seatRace('H-TX-1', 'house', -50.4, { incumbentParty: 'B', incAdv: 2, priorSigma: 8 });
ok('seatRace: lean + incumbency (R incumbent → -2)', leanSeat.margin === -52.4 && leanSeat.source === 'lean' && leanSeat.research === true);
const flat = C.seatRace('H-XX-9', 'house', null, { incAdv: 2, priorSigma: 8 });
ok('seatRace: no lean → flat prior 0', flat.margin === 0 && flat.source === 'prior_flat');

// seatIdForRace: loop race → seat id (matches 538 keys, no zero-pad)
ok('seatIdForRace: senate', C.seatIdForRace({ chamber: 'senate', state: 'Arizona' }) === 'S-AZ');
ok('seatIdForRace: house (NH-02 → H-NH-2)', C.seatIdForRace({ chamber: 'house', state: 'NH', district: 2 }) === 'H-NH-2');
ok('seatIdForRace: house from geo', C.seatIdForRace({ chamber: 'house', geo: 'AZ-06', district: 6 }) === 'H-AZ-6');

// buildCoverage: full universe
const cov = C.buildCoverage({
  districts: { 'CA-22': 10.3, 'TX-1': -50.4, 'NY-14': 56.8 },
  states: { Arizona: -7.2, Maine: 4.4, Texas: -12.9 },
  senateUp: ['Arizona', 'Maine', 'Texas'],
  senateHoldovers: { A: 30, B: 35 },
  polledBySeat: { 'S-AZ': { margin: 1.1, margin_source: 'polls', sigma: 4, n_polls: 14 }, 'H-CA-22': { margin: 5, margin_source: 'polls' } },
  incumbentBySeat: { 'S-ME': 'B', 'H-TX-1': 'B' },
});
ok('buildCoverage: 3 house + 3 senate-up races', cov.races.filter((r) => r.chamber === 'house').length === 3 && cov.races.filter((r) => r.chamber === 'senate').length === 3);
const byId = Object.fromEntries(cov.races.map((r) => [r.seat, r]));
ok('buildCoverage: H-CA-22 uses poll', byId['H-CA-22'].margin === 5 && byId['H-CA-22'].source === 'polls');
ok('buildCoverage: H-TX-1 lean + R incumbency = -52.4', byId['H-TX-1'].margin === -52.4);
ok('buildCoverage: H-NY-14 pure lean (no incumbent)', byId['H-NY-14'].margin === 56.8);
ok('buildCoverage: S-AZ polled overrides state lean', byId['S-AZ'].margin === 1.1 && byId['S-AZ'].source === 'polls');
ok('buildCoverage: S-ME state lean + R incumbency = 2.4', byId['S-ME'].margin === 2.4);
ok('buildCoverage: house has no holdovers, senate carries them', cov.holdovers.house.A === 0 && cov.holdovers.senate.B === 35);
ok('buildCoverage: majority thresholds', cov.majority.house === 218 && cov.majority.senate === 51);
ok('buildCoverage: counts (2 polled, 4 lean)', cov.counts.polled === 2 && cov.counts.lean === 4 && cov.counts.senate_up === 3);

// parseIncumbents: congress-legislators JSON → seat → party
const inc = C.parseIncumbents([
  { terms: [{ type: 'rep', state: 'AL', district: 4, party: 'Republican' }] },
  { terms: [{ type: 'rep', state: 'AK', district: 0, party: 'Republican' }] },   // at-large 0 → 1
  { terms: [{ type: 'sen', state: 'ME', class: 2, party: 'Republican' }] },       // class 2 = up 2026 (Collins)
  { terms: [{ type: 'sen', state: 'ME', class: 1, party: 'Independent' }] },       // King (I) not up → I skipped, R kept
  { terms: [{ type: 'sen', state: 'AZ', class: 3, party: 'Democrat' }] },          // no class-2 → fallback fills
]);
ok('parseIncumbents: rep by district → party', inc['H-AL-4'] === 'B');
ok('parseIncumbents: at-large district 0 → 1', inc['H-AK-1'] === 'B');
ok('parseIncumbents: senate prefers class-2 (ME R, not the Independent)', inc['S-ME'] === 'B');
ok('parseIncumbents: senate fallback when no class-2 (AZ D)', inc['S-AZ'] === 'A');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
