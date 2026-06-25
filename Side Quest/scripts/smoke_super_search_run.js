/**
 * Offline smoke for Super Search SLICE 6 (studio/super_search_run.js):
 * the run orchestrator — the one pathway → one standardized run object. Drives the REAL recipe
 * registry (all 8 recipes) with stubbed recipeDeps (canned per-tool results), stub caged leaves,
 * and the slice-5 ingestor. Pure deterministic — no engine, no model, no network.
 *
 * Run: node scripts/smoke_super_search_run.js
 */
const { runSuperSearch } = require('../studio/super_search_run');
const { makeIngestor, makeMemoryLedger } = require('../studio/super_search_ingest');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- canned per-tool fixtures (subsets of the real shapes) -----------------------------------
const TOOLS = {
  search_knowledge: { result: [{ source: 'wikipedia', snippet: 'Cloud seeding changes precipitation', rank: -30 }] },
  search_entities: { result: [{ id: 1, name: 'Bureau of Reclamation', entity_type: 'organization', summary: 'federal agency', rank: -8 }] },
  search_contacts: { result: [{ id: 26338, FirstName: 'Roby', LastName: 'Smith', Title: 'Treasurer', Party__c: 'R', MailingState: 'IA', Chamber__c: 'State_Treasurer', rank: -7, name_snippet: 'Roby Smith', notes_snippet: '' }] },
  search_bills: { result: [{ bill_id: 947836, name: 'S 8666 (NY)', state: 'NY', session: '2017-2018', bill_type: 'S', sponsor_count: 0, yea_count: 0, nay_count: 0, summary_match: 'energy aggregators', rank: -8 }] },
  search_poll_questions: { result: [{ question_id: 686, wording: 'Trump pardoned the rioters', question_number: 'Q1', fielded_start: '2025-01-30', fielding_title: 'Trump pardoned the rioters', snippet: 'Trump pardoned' }] },
  academic_search: { results: [{ title: 'Silver Iodide Cloud-Seeding in WRF', authors: ['Lulin Xue', 'A. Hashimoto', 'M. Murakami'], year: 2013, venue: 'JAMC', doi: '10.1175/x', url: 'https://openalex.org/W1', abstract: 'A silver iodide parameterization...', cited_by_count: 82, is_oa: true, source: 'openalex' }] },
  db_query: { ok: true, rows: [] },     // entities spine join: no contact match here
};
const ZOE_SEARCH = { query: 'cloud seeding', results: [
  { title: 'Cloud seeding - Wikipedia', url: 'https://en.wikipedia.org/wiki/Cloud_seeding', snippet: 'weather modification' },
  { title: 'NOAA on cloud seeding', url: 'https://noaa.gov/x', snippet: 'mixed results' },
] };

const recipeDeps = {
  callTool: async (tool) => { if (!(tool in TOOLS)) throw new Error(`unstubbed ${tool}`); return TOOLS[tool]; },
  search: async () => ZOE_SEARCH,
  fetchPage: async (url) => ({ ok: true, url, title: 't', text: 'fetched body about cloud seeding' }),
};

// stub caged leaves
const planner = async (q) => ({ query: q, intent: 'research', entities: ['cloud seeding'], expanded_terms: [], internal_targets: [], external_targets: [], raw: '' });
const reranker = async (q, cards) => cards.map((c, i) => ({ ...c, rank: i + 1 }));   // identity + rank (cage tested in slice 4)
// overview cites the first EXTERNAL card it is handed (deterministic), so 'cited' ingest targets it.
const overview = async (q, cards) => { const i = cards.findIndex(c => c.plane === 'external'); if (i < 0) return { answer: '', citations: [], rendered: false }; const c = cards[i]; return { answer: `Cloud seeding has mixed effects [${i + 1}].`, citations: [{ n: i + 1, id: c.id, cite: c.cite, url: c.url, source: c.source }], rendered: true }; };

const freshIngestor = () => makeIngestor({ callTool: async () => ({ doc_id: 1 }), ledger: makeMemoryLedger(), now: () => '2026-06-24T00:00:00Z' });

(async () => {
  const run = await runSuperSearch('does cloud seeding work', { recipeDeps, planner, reranker, overview, ingestor: freshIngestor(), ingestMode: 'cited' });

  // ---- standardized run-object shape ---------------------------------------------------------
  ok('run: has the standardized shape', ['query', 'plan', 'internal', 'external', 'overview', 'ingested', 'stats'].every(k => k in run));
  ok('run: keeps the query', run.query === 'does cloud seeding work');
  ok('run: plan came from the planner', run.plan.intent === 'research');

  // ---- retrieval: both lanes populated from the right recipes --------------------------------
  ok('run: internal lane has knowledge+entities+contacts+bills+polls', run.internal.length === 5 && new Set(run.internal.map(c => c.source)).size === 5);
  ok('run: external lane has web(2)+academic(1)', run.external.length === 3 && run.external.filter(c => c.source === 'web').length === 2 && run.external.filter(c => c.source === 'academic').length === 1);
  ok('run: every card carries a rank (reranked)', run.internal.every(c => c.rank >= 1) && run.external.every(c => c.rank >= 1));
  ok('run: stats.bySource counts each recipe', run.stats.bySource.knowledge === 1 && run.stats.bySource.web === 2 && run.stats.bySource.academic === 1);
  ok('run: db_query recipe skipped (no plan.sql) → 0', run.stats.bySource.db_query === 0);
  ok('run: no recipe errors', run.stats.errors.length === 0, JSON.stringify(run.stats.errors));
  ok('run: lanes are plane-pure', run.internal.every(c => c.plane === 'internal') && run.external.every(c => c.plane === 'external'));

  // ---- overview + cite_floor -----------------------------------------------------------------
  ok('run: overview rendered with a citation', run.overview.rendered === true && run.overview.citations.length === 1);
  ok('run: stats reflect overview', run.stats.overviewRendered === true && run.stats.reranked === true);

  // ---- cited-ingest gate ---------------------------------------------------------------------
  ok('run: ingestMode=cited ingested exactly the cited external card', run.ingested.length === 1 && run.ingested[0].url === run.overview.citations[0].url);
  ok('run: ingested entry carries provenance query', run.ingested[0].query === 'does cloud seeding work');

  // ingestMode 'all' → every external hit (with a url+body) ingested.
  const runAll = await runSuperSearch('q', { recipeDeps, planner, reranker, overview, ingestor: freshIngestor(), ingestMode: 'all' });
  ok('run: ingestMode=all ingests all externals with url+body', runAll.ingested.length === runAll.external.filter(c => c.url).length);

  // ingestMode 'none' → nothing ingested.
  const runNone = await runSuperSearch('q', { recipeDeps, planner, reranker, overview, ingestor: freshIngestor(), ingestMode: 'none' });
  ok('run: ingestMode=none ingests nothing', runNone.ingested.length === 0 && runNone.stats.ingestMode === 'none');

  // ---- degrade cleanly: no leaves injected ---------------------------------------------------
  const bare = await runSuperSearch('q', { recipeDeps });
  ok('run: no planner → safe default plan', bare.plan.intent === 'lookup');
  ok('run: no reranker → cards still ranked by score', bare.stats.reranked === false && bare.internal.every(c => c.rank >= 1));
  ok('run: no overview → not rendered', bare.overview.rendered === false);
  ok('run: no ingestor → nothing ingested, no throw', bare.ingested.length === 0);

  // ---- a recipe error surfaces in stats, lane still returns the rest -------------------------
  const brokenDeps = { ...recipeDeps, callTool: async (tool) => { if (tool === 'search_bills') throw new Error('bills index down'); if (!(tool in TOOLS)) throw new Error(`unstubbed ${tool}`); return TOOLS[tool]; } };
  const runErr = await runSuperSearch('q', { recipeDeps: brokenDeps, planner, reranker, overview, ingestor: freshIngestor() });
  ok('run: a recipe error is captured in stats.errors', runErr.stats.errors.some(e => e.source === 'bills' && /index down/.test(e.error)));
  ok('run: other lanes still return despite one recipe error', runErr.internal.length === 4 && runErr.external.length === 3);

  // ---- determinism: identical inputs → identical lanes/overview ------------------------------
  const r1 = await runSuperSearch('det', { recipeDeps, planner, reranker, overview, ingestor: freshIngestor() });
  const r2 = await runSuperSearch('det', { recipeDeps, planner, reranker, overview, ingestor: freshIngestor() });
  ok('run: deterministic (same inputs → same internal/external/overview)', JSON.stringify([r1.internal, r1.external, r1.overview]) === JSON.stringify([r2.internal, r2.external, r2.overview]));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
