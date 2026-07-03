/**
 * Offline smoke for lib/seat_map.js — the Echo-native seat universe + candidate→party. Uses the REAL Echo
 * record shapes pulled from the main DB (FEC-bulk summaries). Run: node scripts/smoke_seat_map.js
 */
const S = require('../lib/seat_map');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

// mirror the real Echo record shape: name "LAST, FIRST [FECID]", summary with party/office/cycle fields.
const rec = (name, fec, party, office, cycle = 2026) => ({ name: `${name} [${fec}]`, summary: `${name}\n  FEC candidate id: ${fec}\n  party: ${party}\n  office: ${office}\n  cycle: ${cycle}\n  source: refresh:fec_bulk:edges_mend:auto` });

// office parsing
ok('parseOffice: Senate', (() => { const o = S.parseOffice('S ME 00'); return o.chamber === 'senate' && o.state === 'ME' && o.district === null; })());
ok('parseOffice: House district', (() => { const o = S.parseOffice('H AL 01'); return o.chamber === 'house' && o.state === 'AL' && o.district === 1; })());
ok('parseOffice: junk → null', S.parseOffice('nonsense') === null);
ok('seatId: senate vs house', S.seatId('senate', 'ME', null) === 'S-ME' && S.seatId('house', 'AL', 1) === 'H-AL-01');

// record parsing (real shapes)
const collins = S.parseRecord(rec('COLLINS, SUSAN M.', 'S6ME00159', 'REP', 'S ME 00'));
ok('parseRecord: strips FEC id, maps party REP→B, seat S-ME', collins.name === 'COLLINS, SUSAN M.' && collins.party === 'B' && collins.seat === 'S-ME' && collins.district === null && collins.fecId === 'S6ME00159', JSON.stringify(collins));
const carl = S.parseRecord(rec('CARL, JERRY LEE, JR', 'H0AL01055', 'REP', 'H AL 01'));
ok('parseRecord: House seat + district', carl.seat === 'H-AL-01' && carl.district === 1 && carl.chamber === 'house');
ok('parseRecord: DEM → A', S.parseRecord(rec('JONES, DOUG', 'S0AL00156', 'DEM', 'S AL 00')).party === 'A');

// seat universe from the real records
const records = [
  rec('COLLINS, SUSAN M.', 'S6ME00159', 'REP', 'S ME 00'),
  rec('LONG, BILLY MR.', 'H0MO07113', 'REP', 'S MO 00'),
  rec('JONES, DOUG', 'S0AL00156', 'DEM', 'S AL 00'),
  rec('BYRNE, BRADLEY ROBERTS', 'S0AL00206', 'REP', 'S AL 00'),
  rec('JONES, DOUG', 'S0AL00156', 'DEM', 'S AL 00'),          // duplicate row (Echo carries many) → dedup
  rec('CARL, JERRY LEE, JR', 'H0AL01055', 'REP', 'H AL 01'),
  rec('AVERHART, JAMES', 'H0AL01097', 'DEM', 'H AL 02'),
  rec('ROBY, MARTHA', 'H0AL02087', 'REP', 'H AL 02'),
  rec('SEWELL, TERRI A.', 'H0AL07086', 'DEM', 'H AL 07'),
  rec('OLD, TIMER', 'S9XX00001', 'REP', 'S TX 00', 2024),      // wrong cycle → excluded
];
const universe = S.buildSeatUniverse(records, { cycle: 2026 });
ok('buildSeatUniverse: S-AL is contested (D + R filed)', universe['S-AL'] && universe['S-AL'].parties.A === 1 && universe['S-AL'].parties.B === 1);
ok('buildSeatUniverse: dedups duplicate candidate rows', universe['S-AL'].candidates.length === 2, `got ${universe['S-AL'].candidates.length}`);
ok('buildSeatUniverse: H-AL-02 contested (Averhart D vs Roby R)', universe['H-AL-02'].parties.A === 1 && universe['H-AL-02'].parties.B === 1);
ok('buildSeatUniverse: excludes wrong cycle', !universe['S-TX']);

const stats = S.universeStats(universe);
ok('universeStats: 3 senate + 3 house seats', stats.senate === 3 && stats.house === 3 && stats.seats === 6, JSON.stringify(stats));
ok('universeStats: 2 contested (S-AL, H-AL-02)', stats.contested === 2, `contested ${stats.contested}`);

// Echo-native partyOf
const { partyOf, size } = S.buildPartyOf(records);
ok('partyOf: exact name (Echo LAST, FIRST)', partyOf('COLLINS, SUSAN M.') === 'B');
ok('partyOf: surname fallback (Doug Jones → D)', partyOf('Doug Jones') === 'A' && partyOf('Susan Collins') === 'B');
ok('partyOf: unknown → null', partyOf('Nobody Here') === null);
ok('partyOf: index built', size >= 8);

// ambiguous surname → null (don't guess)
const amb = S.buildPartyOf([rec('SMITH, JOHN', 'H1', 'DEM', 'H TX 01'), rec('SMITH, JANE', 'H2', 'REP', 'H TX 02')]);
ok('partyOf: ambiguous surname (D + R Smiths) → null', amb.partyOf('Somebody Smith') === null && amb.partyOf('SMITH, JOHN') === 'A');

// live loader with injected Echo query
(async () => {
  const loaded = await S.loadFromEcho({ query: async () => records, cycle: 2026 });
  ok('loadFromEcho: builds universe + partyOf + stats', loaded.stats.seats === 6 && loaded.partyOf('Terri A. Sewell') === 'A' && loaded.stats.party_index >= 8, JSON.stringify(loaded.stats));
  ok('loadFromEcho: query throws → fail-soft empty', (await S.loadFromEcho({ query: async () => { throw new Error('echo down'); } })).stats.seats === 0);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
