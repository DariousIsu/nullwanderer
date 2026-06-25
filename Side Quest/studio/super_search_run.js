/*
 * Super Search — the RUN ORCHESTRATOR (slice 6). The one pathway, assembled: every Super Search
 * produces ONE standardized run object, same shape every time. The model is caged at exactly the
 * three injected leaves (plan · rerank · overview); everything else is deterministic.
 *
 *   1. PLAN     — planner(query) → schema-bounded plan (or a safe default if no planner injected).
 *   2. RETRIEVE — run every enabled recipe in parallel via runRecipe (each fail-safe + enrich).
 *   3. RERANK   — per lane (internal ∣ external), the reranker reorders that lane's cards.
 *   4. OVERVIEW — cloud leaf builds a cited answer from the top of both lanes (cite_floor gated).
 *   5. INGEST   — ingestMode 'cited' (default): auto-ingest the external cards the overview cited
 *                 — useful-enough-to-ground-the-answer = worth keeping; uncited stays ephemeral.
 *                 'all' ingests every external hit; 'none' skips. All gated + reversible (slice 5).
 *
 * Pure over injected deps — recipeDeps (callTool/search/fetchPage), the three leaves, the ingestor.
 * Any leaf may be omitted (that stage is skipped) so the harness degrades cleanly. Offline-testable;
 * slice 7 wires the real engine + Ollama local/cloud + SQLite ledger. See docs/SUPER_SEARCH_SPEC.md.
 *
 * Runs in Node (smoke) and the browser: CommonJS + window fallback.
 */
(function (root, factory) {
  const card = (typeof require !== 'undefined') ? require('./super_search_card') : (typeof window !== 'undefined' ? window.SuperSearchCard : null);
  const recipesMod = (typeof require !== 'undefined') ? require('./super_search_recipes') : (typeof window !== 'undefined' ? window.SuperSearchRecipes : null);
  const api = factory(card, recipesMod);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SuperSearchRun = api;
})(this, function (card, recipesMod) {
  'use strict';
  const { runRecipe } = card;

  function defaultPlan(query) {
    return { query, intent: 'lookup', entities: [], expanded_terms: [], internal_targets: [], external_targets: [], raw: '' };
  }

  // Pick the head of each lane for the overview prompt (deterministic: post-rerank order).
  function topOfLane(cards, n) { return cards.slice(0, n); }

  /**
   * Execute one Super Search. Returns the standardized run object.
   * deps: {
   *   recipes?      — registry object (default: full buildRegistry())
   *   recipeDeps    — { callTool, search?, fetchPage? } passed to every recipe
   *   planner?, reranker?, overview?  — the three caged leaves (omit to skip a stage)
   *   ingestor?     — slice-5 ingestor (omit to skip ingest)
   *   ingestMode?   — 'cited' (default) | 'all' | 'none'
   *   overviewTopPerLane? — head size per lane fed to the overview (default 4)
   * }
   */
  async function runSuperSearch(query, deps = {}) {
    const registry = deps.recipes || (recipesMod ? recipesMod.buildRegistry() : {});
    const recipeList = Object.values(registry);
    const ingestMode = deps.ingestMode || 'cited';
    const topN = deps.overviewTopPerLane || 4;

    // 1. PLAN
    const plan = deps.planner ? await deps.planner(query) : defaultPlan(query);

    // Per-lane query: internal FTS5 wants KEYWORDS (implicit-AND chokes on a natural-language
    // question), so the internal lane uses the plan's extracted entities when present; the external
    // lane (web/academic) handles the raw question fine. No entities (planner absent) → raw query.
    const kw = (plan.entities || []).filter(Boolean).join(' ').trim();
    const internalQuery = kw || query;
    const queryFor = (recipe) => (recipe && recipe.plane === 'external') ? query : internalQuery;

    // 2. RETRIEVE — all enabled recipes in parallel, each fail-safe.
    const settled = await Promise.all(recipeList.map(r => runRecipe(r, { query: queryFor(r), plan, deps: deps.recipeDeps || {} })));
    const errors = [];
    let internalCards = [], externalCards = [];
    const bySource = {};
    for (const res of settled) {
      if (res.error) errors.push({ source: res.source, error: res.error });
      const recipe = registry[res.source];
      bySource[res.source] = res.cards.length;
      if (!res.cards.length) continue;
      if (recipe && recipe.plane === 'external') externalCards = externalCards.concat(res.cards);
      else internalCards = internalCards.concat(res.cards);
    }

    // Pre-rerank ordering: by native score, descending (stable, deterministic).
    const byScore = (a, b) => (b.score || 0) - (a.score || 0);
    internalCards.sort(byScore);
    externalCards.sort(byScore);

    // 3. RERANK — per lane.
    if (deps.reranker) {
      internalCards = await deps.reranker(query, internalCards);
      externalCards = await deps.reranker(query, externalCards);
    } else {
      internalCards = internalCards.map((c, i) => ({ ...c, rank: i + 1 }));
      externalCards = externalCards.map((c, i) => ({ ...c, rank: i + 1 }));
    }

    // 4. OVERVIEW — top of both lanes (internal first), cite_floor gated by the leaf.
    const overviewInput = topOfLane(internalCards, topN).concat(topOfLane(externalCards, topN));
    const overview = deps.overview ? await deps.overview(query, overviewInput) : { answer: '', citations: [], rendered: false };

    // 5. INGEST — auto, gated. 'cited' keeps only what the overview cited; 'all' keeps every
    //    external hit; 'none' skips. Always dedup/provenance/reversible via the ingestor.
    let ingested = [], ingestSkipped = [];
    if (deps.ingestor && ingestMode !== 'none') {
      let targets = [];
      if (ingestMode === 'all') targets = externalCards;
      else { const citedIds = new Set((overview.citations || []).map(c => c.id)); targets = externalCards.filter(c => citedIds.has(c.id)); }
      if (targets.length) { const r = await deps.ingestor.ingestKept(targets, { query }); ingested = r.ingested; ingestSkipped = r.skipped; }
    }

    return {
      query,
      plan,
      internal: internalCards,
      external: externalCards,
      overview,
      ingested,
      stats: {
        internalCount: internalCards.length,
        externalCount: externalCards.length,
        bySource,
        errors,
        reranked: !!deps.reranker,
        overviewRendered: !!overview.rendered,
        ingestMode,
        ingestedCount: ingested.length,
        ingestSkipped,
      },
    };
  }

  return { runSuperSearch, defaultPlan };
});
