/* Smoke: lib/news_topics — the tuner's category model (deterministic categorizeFast + cloud batch classify,
 * mocked ask). Pure. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_topics.js */
'use strict';
const T = require('../lib/news_topics');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ===== taxonomy shape =====
ok(T.CATEGORIES.length === 9 && T.CATEGORIES.includes('weather'), 'taxonomy has 9 categories incl. weather');
ok(T.BY_KEY.weather.protected === true, 'weather is protected');

// ===== categorizeFast: clear cases =====
const cat = (o) => T.categorizeFast(o).category;
ok(cat({ title: 'USA reaches World Cup round of 16 after dramatic win' }) === 'sports', 'World Cup → sports');
ok(cat({ title: 'Hurricane strengthens to Category 4 as evacuations begin along the coast' }) === 'weather', 'hurricane/evacuations → weather');
ok(cat({ title: 'Senate advances the bill in a late-night vote' }) === 'politics', 'Senate/bill/vote → politics');
ok(cat({ title: 'Federal Reserve holds interest rate as inflation cools' }) === 'markets', 'Fed/interest rate/inflation → markets');
ok(cat({ title: 'CDC warns of explosive diarrhea parasite; symptoms and how to treat' }) === 'health', 'CDC/parasite/symptoms → health');
ok(cat({ title: 'City council approves zoning ordinance for downtown' }) === 'local', 'city council/zoning → local');
ok(cat({ title: 'OpenAI unveils new artificial intelligence chip' }) === 'tech', 'AI/chip → tech');
ok(cat({ title: 'Ceasefire holds as troops withdraw from the border' }) === 'world', 'ceasefire/troops/border → world');
ok(cat({ title: 'The film sweeps the box office on opening weekend' }) === 'culture', 'film/box office → culture');
// source hint
ok(cat({ title: 'Late rally seals it', source: 'ESPN' }) === 'sports', 'source hint (ESPN) → sports even w/ terse title');
// nothing matches → culture, confidence 0
const none = T.categorizeFast({ title: 'A quiet uneventful afternoon' });
ok(none.category === 'culture' && none.confidence === 0, 'no signal → culture @ confidence 0');

// ===== toKey =====
ok(T.toKey('weather') === 'weather' && T.toKey('Weather & Disaster') === 'weather' && T.toKey('SPORTS') === 'sports', 'toKey accepts key + label, case-insensitive');
ok(T.toKey('nonsense') === null, 'toKey null for unknown');

// ===== validator =====
ok(T.classifyValidator('[{"id":1,"cat":"sports"},{"id":2,"cat":"weather"}]').valid === true, 'validator accepts well-formed');
const fenced = T.classifyValidator('```json\n[{"id":5,"cat":"world"}]\n```');
ok(fenced.valid === true && fenced.value[0].cat === 'world', 'validator tolerates code fences');
const trunc = T.classifyValidator('[{"id":7,"cat":"markets"},{"id":8,"cat":"heal');
ok(trunc.valid === true && trunc.value.length === 1 && trunc.value[0].id === 7, 'validator recovers from truncation');
ok(T.classifyValidator('[{"id":1,"cat":"bogus"}]').valid === false, 'validator drops invalid category → no verdicts');

// ===== classifyTopicsBatch: cloud-on-everything + fail-safe =====
const items = [
  { id: 1, title: 'World Cup quarterfinal set' },       // model + fast agree sports
  { id: 2, title: 'Random ambiguous headline xyz' },    // model says weather; fast would say culture
  { id: 3, title: 'Tornado tears through town' },       // model omits → fast fallback = weather
];
(async () => {
  const askMock = async ({ input }) => input.filter((i) => i.id !== 3).map((i) => ({ id: i.id, cat: i.id === 2 ? 'weather' : 'sports' }));
  const v = await T.classifyTopicsBatch(items, { ask: askMock });
  ok(v[1] === 'sports', 'batch: model label used (id1 sports)');
  ok(v[2] === 'weather', 'batch: model can override the deterministic guess (id2 → weather, not culture)');
  ok(v[3] === 'weather', 'batch: model-omitted id falls back to categorizeFast (id3 → weather)');

  const vDown = await T.classifyTopicsBatch(items, { ask: async () => { throw new Error('cloud down'); } });
  ok(vDown[1] === 'sports' && vDown[3] === 'weather', 'batch: cloud down → every item still labeled via fast (never unlabeled)');
  ok(Object.keys(vDown).length === 3, 'batch: all items labeled even with no cloud');

  // ===== FAST-PATH-FIRST (un-inversion 2026-08-15, deterministic-loops #3) =====
  let sawIds = null;
  const askSpy = async ({ input }) => { sawIds = input.map((i) => i.id); return input.map((i) => ({ id: i.id, cat: 'culture' })); };
  const mix = [
    { id: 10, title: 'Hurricane strengthens to Category 4 as evacuations begin along the coast' }, // 2+ kw hits → fast answers
    { id: 11, title: 'Late rally seals it', source: 'ESPN' },                                      // source-hint winner → fast answers
    { id: 12, title: 'Random ambiguous headline xyz' },                                            // residue → the model
  ];
  const vm = await T.classifyTopicsBatch(mix, { ask: askSpy });
  ok(vm[10] === 'weather' && vm[11] === 'sports', 'confident items are answered by the FAST path (2+ keywords / source hint)');
  ok(sawIds && sawIds.length === 1 && sawIds[0] === 12, `only the RESIDUE reaches the model (${JSON.stringify(sawIds)})`);
  ok(vm[12] === 'culture', 'residue takes the model label');
  let asked = false;
  const vAll = await T.classifyTopicsBatch([mix[0], mix[1]], { ask: async () => { asked = true; return []; } });
  ok(!asked && vAll[10] === 'weather' && vAll[11] === 'sports', 'an all-confident batch makes ZERO model calls');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
