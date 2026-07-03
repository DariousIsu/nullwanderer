/**
 * Offline smoke for lib/forecast_assess.js — gpt-oss direction judgment (pure input/validate + injected ask),
 * incl. the assess→reactor plug-in (batch lookup drives a real margin shift). Run: node scripts/smoke_forecast_assess.js
 */
const A = require('../lib/forecast_assess');
const R = require('../lib/forecast_reactor');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }

const event = { id: 7, title: 'Jones concedes ground after debate; Smith surges', summary: 'Post-debate coverage', entities: ['Smith', 'Jones'] };
const race = { id: 'S-OH', subject: '2026 Ohio', office: 'U.S. Senate', partyA: 'D', partyB: 'R', candidates: ['Smith', 'Jones'], entities: ['Smith', 'Jones', 'Ohio'] };

// --- buildAssessInput ---
const inp = A.buildAssessInput(event, race);
ok('input carries event title + race A/B', inp.event.title.length > 0 && inp.race.partyA === 'D' && inp.race.partyB === 'R');
ok('input summary capped', inp.event.summary.length <= 400);

// --- validateAssess ---
eq('valid JSON parsed', A.validateAssess('{"favors":"A","magnitude":"medium","confidence":0.8}').value, { favors: 'A', magnitude: 'medium', confidence: 0.8 });
ok('neutral needs no magnitude', A.validateAssess('{"favors":"neutral","confidence":0.3}').valid === true);
ok('missing favors → invalid', A.validateAssess('{"magnitude":"large"}').valid === false);
eq('confidence clamped to [0,1]', A.validateAssess('{"favors":"B","magnitude":"small","confidence":1.7}').value.confidence, 1);
ok('tolerates prose/fence around JSON', A.validateAssess('```json\n{"favors":"A","magnitude":"large","confidence":0.9}\n``` done').valid === true);
ok('garbage → invalid (no throw)', A.validateAssess('not json').valid === false);

// --- assessOne / assessBatch with MOCK ask (no network) ---
(async () => {
  const mockAsk = async ({ input }) => ({ favors: /smith/i.test(input.event.title) ? 'A' : 'neutral', magnitude: 'medium', confidence: 0.8 });
  eq('assessOne via mock ask', await A.assessOne(event, race, { ask: mockAsk }), { favors: 'A', magnitude: 'medium', confidence: 0.8 });
  eq('assessOne without ask → null (fail-safe)', await A.assessOne(event, race, {}), null);
  eq('assessOne ask throws → null', await A.assessOne(event, race, { ask: async () => { throw new Error('cloud down'); } }), null);

  const batch = await A.assessBatch([{ event, race }], { ask: mockAsk });
  ok('assessBatch builds a lookup', batch.lookup(event, race) && batch.lookup(event, race).favors === 'A');
  eq('assessBatch keyOf miss → null', batch.lookup({ id: 99 }, race), null);

  // --- INTEGRATION: the batch lookup IS the reactor's sync assess → drives a margin shift ---
  const raceR = { id: 'S-OH', chamber: 'senate', margin: -1, sigma: 6, entities: ['Smith', 'Jones', 'Ohio'] };
  const evC = { id: 7, title: event.title, entities: ['Smith', 'Jones', 'Ohio'], corroboration: 5, last_ts: Date.now() };
  const b2 = await A.assessBatch([{ event: evC, race: raceR }], { ask: mockAsk });
  const reacted = R.reactRace(raceR, { events: [evC], momentum: [] }, { assess: (e, r) => b2.lookup(e, r) });
  ok('assess→reactor: attributed event shifts the margin toward A', reacted.news_delta > 0, `news_delta ${reacted.news_delta}`);
  ok('assess→reactor: audit records the direction', reacted.audit.some((a) => a.kind === 'attributed-shift' && a.favors === 'A'));

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
