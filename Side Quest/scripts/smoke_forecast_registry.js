/**
 * Offline smoke for lib/forecast_registry.js — the read-only race slate builder.
 * Run: node scripts/smoke_forecast_registry.js
 */
const G = require('../lib/forecast_registry');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }

// --- parseSubject ---
eq('parse state', G.parseSubject('2026 Florida'), { year: 2026, state: 'Florida', stateAbbr: 'FL' });
eq('parse district', G.parseSubject('2026 NH-02'), { year: 2026, stateAbbr: 'NH', district: 2 });
eq('parse city/place', G.parseSubject('2025 New York City'), { year: 2025, place: 'New York City' });
eq('parse bare figure', G.parseSubject('Donald Trump'), { year: null, place: 'Donald Trump' });

// --- raceFromSubject ---
const flSen = G.raceFromSubject('2026 Florida', 'us-senator');
eq('senate race chamber/office', [flSen.chamber, flSen.office], ['senate', 'U.S. Senate']);
ok('senate race state + entities', flSen.state === 'Florida' && flSen.entities.includes('Florida'));
const nh = G.raceFromSubject('2026 NH-02', 'us-representative');
eq('district → house + geo', [nh.chamber, nh.district, nh.geo], ['house', 2, 'NH-02']);
eq('governor chamber', G.raceFromSubject('2026 Oregon', 'governor').chamber, 'governor');
eq('non-race poll_type → null', G.raceFromSubject('Donald Trump', 'approval'), null);
ok('race id is stable + slug-safe', /^[A-Za-z0-9:-]+$/.test(flSen.id.replace(/[.]/g, '')));

// --- buildSlate ---
const subjects = [
  { subject: '2026 Florida', poll_types: ['governor', 'us-senator'] },
  { subject: '2026 NH-02', poll_types: ['us-representative'] },
  { subject: 'JD Vance', poll_types: ['favorability'] },          // not a race → dropped
  { subject: 'Donald Trump', poll_types: ['approval'] },           // not a race → dropped
];
const slate = G.buildSlate(subjects);
eq('slate: 3 races (2 FL + 1 NH), non-races dropped', slate.length, 3);
ok('slate: FL produced both offices', slate.filter((r) => r.state === 'Florida').map((r) => r.chamber).sort().join(',') === 'governor,senate');
eq('slate: pollTypes filter narrows offices', G.buildSlate(subjects, { pollTypes: ['us-senator'] }).length, 1);

// --- enrich (READ-ONLY; injected resolver) ---
(async () => {
  const resolve = async (name) => (/florida/i.test(name) ? { id: 'E42', name: 'Florida', type: 'place' } : null);
  const enriched = await G.enrich(flSen, { resolve });
  eq('enrich attaches echo_ref pointer (read-only)', [enriched.echo_ref, enriched.echo.type], ['E42', 'place']);
  const noResolve = await G.enrich(flSen, {});
  eq('enrich without resolver → unchanged, echo_ref null', noResolve.echo_ref, null);
  const boom = await G.enrich(flSen, { resolve: async () => { throw new Error('echo down'); } });
  eq('enrich fail-soft on resolver throw', boom.echo_ref, null);

  // --- fetchSlate (injected fetchSubjects) ---
  const fs = await G.fetchSlate({ fetchSubjects: async () => ({ subjects }) });
  eq('fetchSlate builds from VoteHub /subjects', fs.length, 3);
  eq('fetchSlate missing fetcher → []', await G.fetchSlate({}), []);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
