/**
 * Offline smoke for Super Search SLICE 2 (studio/super_search_recipes.js):
 * the full internal recipe set (entities · contacts · bills · polls · db_query) + the entities
 * spine join. Pure deterministic — every tool is injected as a stub returning the REAL shapes
 * captured live (2026-06-24), so each toCards mapping is proven against reality, not assumptions.
 *
 * Run: node scripts/smoke_super_search_recipes.js
 */
const card = require('../studio/super_search_card');
const R = require('../studio/super_search_recipes');
const { validateCard, runRecipe } = card;

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- REAL fixtures (captured live from the engine) -------------------------------------------
const ENTITIES = { result: [
  { id: 1581350, name: 'cluster_ ENERGY CREATES ENERGY', entity_type: 'decision', entity_subtype: 'court_opinion', summary: 'cluster_ ENERGY CREATES ENERGY', confidence: 1, rank: -8.744178805002695, snippet: 'cluster_ <mark>ENERGY</mark> CREATES <mark>ENERGY</mark>' },
  { id: 1581339, name: 'Posse Energy, Ltd. v. Parsley Energy, LP', entity_type: 'decision', entity_subtype: 'court_opinion', summary: 'Posse Energy v. Parsley Energy', confidence: 1, rank: -8.459851680689004, snippet: 'Posse <mark>Energy</mark> v. Parsley <mark>Energy</mark>' },
] };
const CONTACTS = { result: [
  { id: 26338, FirstName: 'Roby', LastName: 'Smith', Title: 'Treasurer', Party__c: 'R', MailingState: 'IA', District__c: 'IA', Chamber__c: 'State_Treasurer', Jurisdiction__c: 'IA', Contact_Kind__c: 'elected', Email: 'roby.smith@legis.iowa.gov', rank: -7.099555874500856, name_snippet: 'Roby <mark>Smith</mark>', notes_snippet: '' },
  { id: 25632, FirstName: 'Fern', LastName: 'Smith', Title: 'Judge (Former)', Party__c: null, MailingState: null, District__c: null, Chamber__c: 'Federal_District', Jurisdiction__c: 'US-FED', Contact_Kind__c: 'judge', Email: null, rank: -6.835774918232585, name_snippet: 'Fern <mark>Smith</mark>', notes_snippet: '' },
] };
const BILLS = { result: [
  { bill_id: 947836, name: 'S 8666 (NY, 2017-2018)', state: 'NY', session: '2017-2018', bill_type: 'S', introduced_year: 2017, sponsor_count: 0, yea_count: 0, nay_count: 0, summary_snippet: 'Establishes licensing requirements for energy aggregators', summary_match: 'Establishes licensing requirements for <mark>energy</mark> aggregators', rank: -8.164605460729838, name_snippet: 'S 8666 (NY, 2017-2018)' },
] };
const POLLS = { result: [
  { question_id: 686, fielding_id: 'X538-trump-5c3c48fe85', wording: 'Trump pardoned the 1,500 January 6th rioters...', question_number: 'Q1', fielded_start: '2025-01-30', fielding_title: 'Trump pardoned the 1,500 January 6th rioters who were criminally charged with storming the Capitol', snippet: 'Trump pardoned the 1,500 January 6th rioters... <mark>election</mark>...' },
] };

const stub = (map) => ({ callTool: async (tool, args) => { const r = map[tool]; if (typeof r === 'function') return r(args); return r; } });

// ---- entities --------------------------------------------------------------------------------
{
  const cards = R.entitiesRecipe.toCards(ENTITIES.result);
  ok('entities: card per hit', cards.length === 2);
  ok('entities: contract-valid', cards.every(c => validateCard(c).valid), JSON.stringify(cards.map(c => validateCard(c).missing)));
  ok('entities: id/plane/source', cards[0].id === 'entities:1581350' && cards[0].plane === 'internal' && cards[0].source === 'entities');
  ok('entities: title=name, snippet de-marked', cards[0].title === 'cluster_ ENERGY CREATES ENERGY' && !/<mark>/.test(cards[0].snippet));
  ok('entities: entity_type in enrich', cards[0].enrich.entity_type === 'decision' && cards[0].enrich.entity_subtype === 'court_opinion');
  ok('entities: score ordering (bm25)', cards[0].score > cards[1].score);
}

// ---- contacts (inline party/state enrichment) ------------------------------------------------
{
  const cards = R.contactsRecipe.toCards(CONTACTS.result);
  ok('contacts: contract-valid', cards.every(c => validateCard(c).valid));
  ok('contacts: title from First+Last', cards[0].title === 'Roby Smith');
  ok('contacts: party/state inline in enrich', cards[0].enrich.party === 'R' && cards[0].enrich.state === 'IA');
  ok('contacts: snippet composed when notes empty', /Treasurer/.test(cards[0].snippet) && /IA/.test(cards[0].snippet));
  ok('contacts: nulls pruned from enrich', !('party' in cards[1].enrich) && !('email' in cards[1].enrich));
  ok('contacts: cite carries state', /\(IA\)/.test(cards[0].cite));
}

// ---- bills -----------------------------------------------------------------------------------
{
  const cards = R.billsRecipe.toCards(BILLS.result);
  ok('bills: contract-valid', cards.every(c => validateCard(c).valid));
  ok('bills: id from bill_id', cards[0].id === 'bills:947836');
  ok('bills: snippet prefers summary_match, de-marked', /licensing requirements/.test(cards[0].snippet) && !/<mark>/.test(cards[0].snippet));
  ok('bills: state/session/type in enrich', cards[0].enrich.state === 'NY' && cards[0].enrich.session === '2017-2018' && cards[0].enrich.bill_type === 'S');
  ok('bills: zero votes pruned (no votes key)', !('votes' in cards[0].enrich));
}

// ---- polls (no rank → positional score) ------------------------------------------------------
{
  const cards = R.pollsRecipe.toCards(POLLS.result);
  ok('polls: contract-valid', cards.every(c => validateCard(c).valid));
  ok('polls: id from question_id', cards[0].id === 'polls:686');
  ok('polls: long wording → bounded title', cards[0].title.length <= 81);
  ok('polls: positional score (no rank field)', cards[0].score === 1);
  ok('polls: fielding metadata in enrich', cards[0].enrich.fielding_id === 'X538-trump-5c3c48fe85' && cards[0].enrich.question_number === 'Q1');
}

// ---- db_query (generic escape hatch) ---------------------------------------------------------
{
  const rows = [{ name: 'Acme PAC', total: 5000, year: 2024 }, { label: 'Other', x: 1 }];
  const cards = R.dbQueryRecipe.toCards(rows);
  ok('db_query: contract-valid', cards.every(c => validateCard(c).valid));
  ok('db_query: title from name col', cards[0].title === 'Acme PAC');
  ok('db_query: snippet packs the other cols', /total: 5000/.test(cards[0].snippet) && /year: 2024/.test(cards[0].snippet));
  ok('db_query: title falls back to label col', cards[1].title === 'Other');
  ok('db_query: id hashed + stable', cards[0].id.startsWith('db_query:') && cards[0].id === R.dbQueryRecipe.toCards(rows)[0].id);
}

// ---- async: runRecipe wiring, enabled gates, db_query special gate, spine join, fail-safe -----
(async () => {
  // entities through runRecipe with the spine join stubbed (db_query returns a contact match).
  const deps = stub({
    search_entities: ENTITIES,
    db_query: { ok: true, rows: [{ eid: 1581350, party: 'D', state: 'TX', title: 'Senator' }] },
  });
  const ent = await runRecipe(R.entitiesRecipe, { query: 'energy', plan: null, deps });
  ok('runRecipe(entities) returns cards', ent.error === null && ent.cards.length === 2);
  ok('spine join merges contact party/state onto matching card', ent.cards.find(c => c.id === 'entities:1581350').enrich.party === 'D' && ent.cards.find(c => c.id === 'entities:1581350').enrich.state === 'TX');
  ok('spine join leaves unmatched card untouched', !('party' in ent.cards.find(c => c.id === 'entities:1581339').enrich));

  // spine join fail-safe: db_query throws → cards returned unenriched, no throw.
  const depsFail = stub({ search_entities: ENTITIES, db_query: () => { throw new Error('join blew up'); } });
  const entFail = await runRecipe(R.entitiesRecipe, { query: 'energy', plan: null, deps: depsFail });
  ok('spine join error is fail-safe (cards still returned)', entFail.error === null && entFail.cards.length === 2 && !('party' in entFail.cards[0].enrich));

  // contacts run passes the state filter from the plan.
  const cDeps = stub({ search_contacts: CONTACTS });
  await runRecipe(R.contactsRecipe, { query: 'smith', plan: { state: 'IA' }, deps: { callTool: async (t, a) => { ok('contacts run forwards state filter', a.state === 'IA'); return CONTACTS; } } });

  // db_query special gate: skipped without plan.sql, runs with it.
  const noSql = await runRecipe(R.dbQueryRecipe, { query: 'x', plan: null, deps: stub({}) });
  ok('db_query skipped when plan has no sql', noSql.skipped === true && noSql.cards.length === 0);
  const withSql = await runRecipe(R.dbQueryRecipe, { query: 'x', plan: { sql: 'SELECT name FROM contact LIMIT 1' }, deps: stub({ db_query: { ok: true, rows: [{ name: 'Jane Doe' }] } }) });
  ok('db_query runs when plan supplies sql', withSql.cards.length === 1 && withSql.cards[0].title === 'Jane Doe');

  // internal_targets gating: only named recipes fire.
  const billsOff = await runRecipe(R.billsRecipe, { query: 'x', plan: { internal_targets: ['knowledge'] }, deps: stub({ search_bills: BILLS }) });
  ok('bills skipped when not in internal_targets', billsOff.skipped === true);
  const billsOn = await runRecipe(R.billsRecipe, { query: 'x', plan: { internal_targets: ['bills'] }, deps: stub({ search_bills: BILLS }) });
  ok('bills run when in internal_targets', billsOn.cards.length === 1);

  // ---- registry assembly ----------------------------------------------------------------------
  const reg = R.buildRegistry();
  ok('buildRegistry has all 6 recipes', ['knowledge', 'entities', 'contacts', 'bills', 'polls', 'db_query'].every(k => reg[k]));
  ok('every recipe has the recipe shape', R.recipes().every(r => r.id && card.PLANES.includes(r.plane) && typeof r.enabled === 'function' && typeof r.run === 'function' && typeof r.toCards === 'function'));
  ok('all internal recipes are plane=internal', R.INTERNAL.every(r => r.plane === 'internal'));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
