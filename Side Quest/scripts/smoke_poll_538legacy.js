/**
 * Offline smoke for lib/poll_538legacy.js — the 538 legacy-data adapter (ratings + backtest history).
 * Fixtures use the REAL CSV headers/rows captured live (2026-07-03). No network (fetchText mocked).
 *
 * Run: node scripts/smoke_poll_538legacy.js
 */
const F = require('../lib/poll_538legacy');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }

// --- CSV parser: quoted field containing a comma ---
const CSVQ = 'a,b,c\n1,"Smith, John",3\n4,plain,6';
const objs = F.parseCsvObjects(CSVQ);
eq('csv: quoted comma kept intact', objs[0].b, 'Smith, John');
eq('csv: 2 data rows', objs.length, 2);
eq('csv: escaped "" quotes', F.parseCsvObjects('x\n"he said ""hi"""')[0].x, 'he said "hi"');

// --- pollster ratings (real header + rows) ---
const RATINGS = [
  'pollster,pollster_rating_id,aapor_roper,inactive,numeric_grade,rank,POLLSCORE,wtd_avg_transparency,number_polls_pollster_total,percent_partisan_work,error_ppm,bias_ppm,number_polls_pollster_time_weighted',
  'The New York Times/Siena College,448,TRUE,FALSE,3,1,-1.5,8.7,120,0,-1,-2,111.6',
  'Rasmussen Reports/Pulse Opinion Research,269,FALSE,FALSE,1.5,180,0.8,1.2,300,10,2,4.5,250',
  ',999,FALSE,FALSE,0,0,0,0,0,0,0,0,0',   // no pollster → dropped
].join('\n');
const rats = F.parseRatings(RATINGS);
eq('ratings: 2 valid (blank pollster dropped)', rats.length, 2);
const nyt = rats.find((r) => /New York Times/.test(r.pollster));
eq('ratings: grade parsed', nyt.grade, 3);
eq('ratings: bias_ppm signed (house-effect prior)', nyt.bias_ppm, -2);
eq('ratings: pollscore', nyt.pollscore, -1.5);
eq('ratings: n_polls', nyt.n_polls, 120);
eq('ratings: source+tier', [nyt.source, nyt.tier], ['538_legacy', 'free']);
const ras = rats.find((r) => /Rasmussen/.test(r.pollster));
eq('ratings: positive bias (R lean) preserved', ras.bias_ppm, 4.5);

// --- raw polls with actual result (backtest) ---
const RAWP = [
  'poll_id,question_id,race_id,cycle,location,type_simple,race,pollster,pollster_rating_id,aapor_roper,inactive,methodology,transparency_score,partisan,polldate,electiondate,time_to_election,samplesize,cand1_name,cand1_id,cand1_party,cand1_pct,cand1_actual,cand2_name,cand2_id,cand2_party,cand2_pct,cand2_actual,margin_poll,margin_actual',
  '32945,39543,1,2014,NE,Sen-G,2014_Sen-G_NE,YouGov,391,FALSE,FALSE,Online Panel,8,NA,2014-09-26,2014-11-04,39,721,Dave Domina,6263,DEM,31,31.49,Ben Sasse,6269,REP,58,64.34,-27,-32.85',
].join('\n');
const rp = F.parseRawPolls(RAWP)[0];
eq('rawpoll: pollster', rp.pollster, 'YouGov');
eq('rawpoll: race/type', [rp.race, rp.type], ['2014_Sen-G_NE', 'Sen-G']);
eq('rawpoll: sample_size', rp.sample_size, 721);
eq('rawpoll: cand1', rp.cand1, { name: 'Dave Domina', party: 'DEM', pct: 31, actual: 31.49 });
eq('rawpoll: margin poll vs actual (backtest signal)', [rp.margin_poll, rp.margin_actual], [-27, -32.85]);
eq('rawpoll: kind=result', rp.kind, 'result');

// --- fetch (mocked fetchText) + fail-soft ---
(async () => {
  const r = await F.fetchRatings({ fetchText: async () => RATINGS });
  ok('fetchRatings ok + parsed', r.ok && r.ratings.length === 2);
  eq('fetchRatings missing fetchText → ok:false', (await F.fetchRatings({})).ok, false);
  const err = await F.fetchRawPolls({ fetchText: async () => { throw new Error('HTTP 404'); } });
  ok('fetchRawPolls fail-soft on throw', err.ok === false && /404/.test(err.error));
  eq('empty csv → no rows', F.parseRatings('').length, 0);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
