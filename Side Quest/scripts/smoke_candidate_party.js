/**
 * Offline smoke for lib/candidate_party.js — candidate NAME → party (A=Dem/B=Rep) via FEC. Pure matching +
 * the async pre-resolve → sync lookup, with an injected fake `search` (no network). Run: node scripts/smoke_candidate_party.js
 */
const C = require('../lib/candidate_party');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

// party code mapping
ok('partyCode: DEM/DFL → A, REP → B, third/empty → null', C.partyCode('DEM') === 'A' && C.partyCode('DFL') === 'A' && C.partyCode('REP') === 'B' && C.partyCode('IND') === null && C.partyCode('') === null);
ok('officeCode: chamber + poll_type', C.officeCode('senate') === 'S' && C.officeCode('us-senator') === 'S' && C.officeCode('house') === 'H' && C.officeCode('us-representative') === 'H' && C.officeCode('president') === 'P' && C.officeCode('x') === null);
ok('lastNameOf: First Last / LAST, FIRST / suffix', C.lastNameOf('Ruben Gallego') === 'gallego' && C.lastNameOf('GALLEGO, RUBEN') === 'gallego' && C.lastNameOf('Nick Begich III') === 'begich');

// matchRecord: surname + office + state, prefer major party; no surname match → null
const recs = [
  { name: 'GALLEGO, RUBEN', party: 'DEM', office: 'S', state: 'AZ' },
  { name: 'GALLEGO, SOMEONE', party: 'LIB', office: 'H', state: 'TX' },
];
ok('matchRecord: picks surname+office+state, major party', C.partyFromResults('Ruben Gallego', recs, { office: 'S', state: 'AZ' }) === 'A');
ok('matchRecord: no surname match → null (no guessing)', C.matchRecord('Kari Lake', recs, {}) === null);
ok('partyFromResults: empty results → null', C.partyFromResults('Anyone', []) === null);

(async () => {
  // injected FEC search (no network)
  const DB = {
    'ruben gallego': [{ name: 'GALLEGO, RUBEN', party: 'DEM', office: 'S', state: 'AZ' }],
    'kari lake': [{ name: 'LAKE, KARI', party: 'REP', office: 'S', state: 'AZ' }],
    'jasmine crockett': [{ name: 'CROCKETT, JASMINE', party: 'DEM', office: 'H', state: 'TX' }],
  };
  let calls = 0;
  const search = async (name) => { calls++; return DB[C.norm(name)] || []; };

  const entries = [
    { name: 'Ruben Gallego', office: 'S', state: 'AZ' },
    { name: 'Kari Lake', office: 'S', state: 'AZ' },
    { name: 'Nobody Random', office: 'S' },
    { name: 'Ruben Gallego', office: 'S', state: 'AZ' },   // dup → resolved once
  ];
  const cache = new Map();
  const built = await C.resolveMany(entries, { search, cache });
  ok('resolveMany: sync partyOf resolves D and R', built.partyOf('Ruben Gallego') === 'A' && built.partyOf('Kari Lake') === 'B');
  ok('resolveMany: unmatched name → null (prior fallback)', built.partyOf('Nobody Random') === null);
  ok('resolveMany: resolved/total counts', built.resolved === 2 && built.total === 3, `resolved ${built.resolved} total ${built.total}`);
  ok('resolveMany: dedups the search (3 unique, not 4)', calls === 3, `calls ${calls}`);

  // cache reuse: a second pass with the same cache does NO new searches
  const before = calls;
  const built2 = await C.resolveMany(entries, { search, cache });
  ok('resolveMany: cache reuse → no re-search', calls === before && built2.partyOf('Kari Lake') === 'B');

  // fail-safe: a throwing search → null, no crash
  const built3 = await C.resolveMany([{ name: 'Boom Person' }], { search: async () => { throw new Error('fec down'); }, cache: new Map() });
  ok('resolveMany: search throws → null, fail-safe', built3.partyOf('Boom Person') === null);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
