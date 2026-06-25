/**
 * Offline smoke for Super Search SLICE 4 (studio/super_search_model_io.js):
 * the three caged model leaves — plan · rerank · overview. Pure deterministic: `complete` is a
 * mock returning canned replies, so we prove the CAGE (bounded plan, permutation-only rerank,
 * cite_floor gate) without any model or network.
 *
 * Run: node scripts/smoke_super_search_modelio.js
 */
const MIO = require('../studio/super_search_model_io');
const { makePlanner, makeReranker, makeOverview } = MIO;

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
// complete mock: returns whatever canned string we set; records the messages it saw.
function mock(reply) { const f = async (args) => { f.seen = args; return typeof reply === 'function' ? reply(args) : reply; }; return f; }

(async () => {
  // ---- PLAN: free-form reply → schema-bounded plan -------------------------------------------
  const plan = await makePlanner({ complete: mock('INTENT=research | ENTITIES=cloud seeding, snowpack | TERMS=weather modification, silver iodide | INTERNAL=knowledge,bills | EXTERNAL=academic'), model: 'm' })('does cloud seeding work');
  ok('plan: intent parsed', plan.intent === 'research');
  ok('plan: entities parsed', plan.entities.includes('cloud seeding') && plan.entities.includes('snowpack'));
  ok('plan: expansion terms parsed', plan.expanded_terms.includes('silver iodide'));
  ok('plan: internal_targets filtered to known', JSON.stringify(plan.internal_targets) === JSON.stringify(['knowledge', 'bills']));
  ok('plan: external_targets filtered to known', JSON.stringify(plan.external_targets) === JSON.stringify(['academic']));
  ok('plan: keeps the raw query', plan.query === 'does cloud seeding work');

  const planStar = await makePlanner({ complete: mock('INTENT=lookup | ENTITIES=- | TERMS=- | INTERNAL=* | EXTERNAL=*'), model: 'm' })('q');
  ok('plan: * → empty targets (= all lanes on)', planStar.internal_targets.length === 0 && planStar.external_targets.length === 0);
  ok('plan: "-" placeholders → empty entities/terms', planStar.entities.length === 0 && planStar.expanded_terms.length === 0);

  // CAGE: model cannot invent a source, and db_query is never model-selectable.
  const planInvent = await makePlanner({ complete: mock('INTENT=hack | INTERNAL=knowledge,twitter,db_query | EXTERNAL=darkweb,academic'), model: 'm' })('q');
  ok('plan: invalid intent → safe default lookup', planInvent.intent === 'lookup');
  ok('plan: invented internal source dropped', JSON.stringify(planInvent.internal_targets) === JSON.stringify(['knowledge']));
  ok('plan: db_query is NOT model-selectable', !planInvent.internal_targets.includes('db_query'));
  ok('plan: invented external source dropped', JSON.stringify(planInvent.external_targets) === JSON.stringify(['academic']));

  // CAGE: garbage / model error → safe all-lanes-on default, never throws.
  const planJunk = await makePlanner({ complete: mock('lol I dunno'), model: 'm' })('q');
  ok('plan: garbage reply → safe default (all lanes)', planJunk.intent === 'lookup' && planJunk.internal_targets.length === 0 && planJunk.external_targets.length === 0);
  const planErr = await makePlanner({ complete: async () => { throw new Error('model down'); }, model: 'm' })('q');
  ok('plan: model error is fail-safe', planErr.intent === 'lookup' && Array.isArray(planErr.internal_targets));

  // ---- RERANK: output is ALWAYS a permutation of the input -----------------------------------
  const cards = [
    { id: 'a', title: 'Alpha', snippet: 'one' },
    { id: 'b', title: 'Beta', snippet: 'two' },
    { id: 'c', title: 'Gamma', snippet: 'three' },
  ];
  const rr = await makeReranker({ complete: mock('ORDER=3,1,2'), model: 'm' })('q', cards);
  ok('rerank: applies the model order', rr.map(c => c.id).join('') === 'cab');
  ok('rerank: assigns 1-based rank', rr[0].rank === 1 && rr[2].rank === 3);
  ok('rerank: same card set preserved (permutation)', new Set(rr.map(c => c.id)).size === 3);

  // CAGE: model drops/invents indices → still a clean permutation of exactly the input.
  const rrPartial = await makeReranker({ complete: mock('ORDER=2'), model: 'm' })('q', cards);
  ok('rerank: omitted cards appended, none lost', rrPartial.map(c => c.id).sort().join('') === 'abc' && rrPartial[0].id === 'b');
  const rrJunk = await makeReranker({ complete: mock('ORDER=9,9,7'), model: 'm' })('q', cards);
  ok('rerank: out-of-range/dupe indices ignored → original order kept', rrJunk.map(c => c.id).join('') === 'abc');
  const rrErr = await makeReranker({ complete: async () => { throw new Error('x'); }, model: 'm' })('q', cards);
  ok('rerank: model error → original order, ranks set', rrErr.map(c => c.id).join('') === 'abc' && rrErr[0].rank === 1);
  ok('rerank: single card short-circuits', (await makeReranker({ complete: mock('') })('q', [cards[0]])).length === 1);

  // ---- OVERVIEW: cite_floor gate -------------------------------------------------------------
  const topCards = [
    { id: 'k1', source: 'knowledge', cite: 'wikipedia: Cloud seeding', url: null, snippet: 'Cloud seeding changes precipitation.' },
    { id: 'a1', source: 'academic', cite: 'Xue et al. (2013)', url: 'https://openalex.org/W1', enrich: { body: 'Enhancement ranged 0.3% to 429%.' } },
  ];
  const ovMock = mock('Cloud seeding can modestly increase precipitation [1], with modeled enhancement varying widely [2].');
  const ov = await makeOverview({ complete: ovMock, model: 'cloud' })('does cloud seeding work', topCards);
  ok('overview: renders when answer cites sources', ov.rendered === true && ov.answer.length > 0);
  ok('overview: citations map to used [n]', ov.citations.length === 2 && ov.citations[0].id === 'k1' && ov.citations[1].id === 'a1');
  ok('overview: citation carries cite handle + url', ov.citations[1].cite === 'Xue et al. (2013)' && ov.citations[1].url === 'https://openalex.org/W1');
  const sentPrompt = ovMock.seen.messages.map(m => m.content).join('\n');
  ok('overview: uses enrich.body for the academic card in the prompt', /Enhancement ranged 0\.3% to 429%/.test(sentPrompt));
  ok('overview: uses snippet for the body-less knowledge card', /Cloud seeding changes precipitation/.test(sentPrompt));

  // CAGE: uncited answer ⇒ does NOT render.
  const ovUncited = await makeOverview({ complete: mock('Cloud seeding definitely works great.'), model: 'cloud' })('q', topCards);
  ok('overview: uncited answer ⇒ rendered:false', ovUncited.rendered === false && ovUncited.citations.length === 0);
  // CAGE: model says INSUFFICIENT ⇒ does not render.
  const ovInsuf = await makeOverview({ complete: mock('INSUFFICIENT'), model: 'cloud' })('q', topCards);
  ok('overview: INSUFFICIENT ⇒ rendered:false', ovInsuf.rendered === false);
  // CAGE: no input cards ⇒ short-circuit, no complete call.
  let called = false;
  const ovEmpty = await makeOverview({ complete: async () => { called = true; return 'x [1]'; }, model: 'cloud' })('q', []);
  ok('overview: zero cards ⇒ rendered:false without calling model', ovEmpty.rendered === false && called === false);
  // CAGE: a citation to a non-existent source number is ignored (only real cards count).
  const ovBadCite = await makeOverview({ complete: mock('Answer with bogus marker [9].'), model: 'cloud' })('q', topCards);
  ok('overview: out-of-range [n] ignored ⇒ rendered:false', ovBadCite.rendered === false);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
