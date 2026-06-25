/*
 * Super Search — the recipe set: INTERNAL lane (slice 2) + EXTERNAL lane (slice 3). One
 * deterministic recipe per source, each binding the query to a KNOWN tool and mapping that tool's
 * KNOWN result shape → the standardized ResultCard (studio/super_search_card.js). Bindings +
 * enrichment are grounded in the live atlas (get_atlas / get_db_map) and the real tool return
 * shapes captured live (2026-06-24).
 *
 * INTERNAL (plane='internal'):
 *   entities  — search_entities (civic_graph FTS5) ; spine enrich: entities.contact_id → contact
 *   contacts  — search_contacts (CRM FTS5)         ; party/state/chamber inline from the row
 *   bills     — search_bills    (bill FTS5)         ; state/session/votes inline from the row
 *   polls     — search_poll_questions (polling FTS5); no rank field → positional score
 *   db_query  — parameterized SELECT escape hatch   ; fires only when the plan supplies SQL
 * EXTERNAL (plane='external'):
 *   web       — Zoe's own search (deps.search) PRIMARY, engine web_search FALLBACK (the engine's
 *               federated providers have no keys → empty). enrich: fetch top-N bodies via web_extract.
 *   academic  — academic_search (keyless OpenAlex/Crossref/DOAJ); abstract inline, no fetch needed.
 *
 * Pure + offline-testable: all I/O goes through injected deps (deps.callTool / deps.search /
 * deps.fetchPage). buildRegistry() assembles the full registry (knowledge + internal + external);
 * the slice-6 orchestrator consumes it. See docs/SUPER_SEARCH_SPEC.md.
 *
 * Runs in Node (smoke) and the browser (surface): CommonJS + window fallback.
 */
(function (root, factory) {
  const card = (typeof require !== 'undefined') ? require('./super_search_card')
    : (typeof window !== 'undefined' ? window.SuperSearchCard : null);
  const api = factory(card);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SuperSearchRecipes = api;
})(this, function (card) {
  'use strict';

  const { normalizeCard, cleanText, leadTitle, scoreFromRank, djb2, targetEnabled, compose, knowledgeRecipe } = card;

  // Drop null/empty values from an enrich object so cards carry only real spine data.
  function pruned(obj) {
    const out = {};
    for (const k in obj) { const v = obj[k]; if (v != null && v !== '' && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) out[k] = v; }
    return out;
  }

  // ---- entities — civic_graph FTS5 -------------------------------------------------------------
  // Shape: { result: [ { id, name, entity_type, entity_subtype, summary, confidence, rank, snippet } ] }
  const entitiesRecipe = {
    id: 'entities',
    plane: 'internal',
    label: 'Civic entities',
    enabled(plan) { return targetEnabled(plan, 'entities'); },
    async run({ query, plan, deps }) {
      const res = await deps.callTool('search_entities', { query, entity_type: (plan && plan.entity_type) || null, top_k: (plan && plan.top_k) || 10 });
      return (res && res.result) || [];
    },
    toCards(rows) {
      return (rows || []).map((r) => normalizeCard({
        id: `entities:${r.id}`,
        plane: 'internal',
        source: 'entities',
        title: r.name,
        snippet: cleanText(r.snippet || r.summary),
        url: null,
        score: scoreFromRank(r.rank),
        enrich: pruned({ entity_type: r.entity_type, entity_subtype: r.entity_subtype, confidence: r.confidence }),
        cite: compose(r.entity_type, r.name),
        raw_ref: r,
      }));
    },
    // SPINE JOIN: a person entity → its CRM contact (party / state / title live there, not in the
    // graph). entities.contact_id → contact.id (atlas spine). Batched, fail-safe: any error leaves
    // the cards untouched. Non-person rows simply have no contact_id and drop out of the join.
    async enrich(cards, deps) {
      const ids = cards.map(c => Number(String(c.id).split(':')[1])).filter(Number.isFinite);
      if (!ids.length) return cards;
      const ph = ids.map(() => '?').join(',');
      let rows = [];
      try {
        const res = await deps.callTool('db_query', {
          sql: `SELECT e.id AS eid, c.Party__c AS party, c.MailingState AS state, c.Title AS title
                FROM entities e JOIN contact c ON c.id = e.contact_id WHERE e.id IN (${ph})`,
          params: ids,
        });
        rows = (res && res.rows) || [];
      } catch (e) { return cards; }
      if (!rows.length) return cards;
      const byId = {};
      for (const row of rows) byId[row.eid] = pruned({ party: row.party, state: row.state, title: row.title });
      return cards.map((c) => {
        const eid = Number(String(c.id).split(':')[1]);
        const extra = byId[eid];
        return extra ? { ...c, enrich: { ...c.enrich, ...extra } } : c;
      });
    },
  };

  // ---- contacts — CRM FTS5 ---------------------------------------------------------------------
  // Shape: { result: [ { id, FirstName, LastName, Title, Party__c, MailingState, District__c,
  //                      Chamber__c, Jurisdiction__c, Contact_Kind__c, Email, name_snippet,
  //                      notes_snippet, rank } ] }. Party/state/chamber are inline — no extra hop.
  const contactsRecipe = {
    id: 'contacts',
    plane: 'internal',
    label: 'CRM contacts',
    enabled(plan) { return targetEnabled(plan, 'contacts'); },
    async run({ query, plan, deps }) {
      const res = await deps.callTool('search_contacts', { query, state: (plan && plan.state) || null, top_k: (plan && plan.top_k) || 30 });
      return (res && res.result) || [];
    },
    toCards(rows) {
      return (rows || []).map((r) => {
        const name = compose(`${r.FirstName || ''} ${r.LastName || ''}`.trim()) || cleanText(r.name_snippet);
        const state = r.MailingState || r.District__c || r.Jurisdiction__c || null;
        return normalizeCard({
          id: `contacts:${r.id}`,
          plane: 'internal',
          source: 'contacts',
          title: name,
          snippet: cleanText(r.notes_snippet) || compose(r.Title, r.Chamber__c, state),
          url: null,
          score: scoreFromRank(r.rank),
          enrich: pruned({ party: r.Party__c, state, chamber: r.Chamber__c, jurisdiction: r.Jurisdiction__c, kind: r.Contact_Kind__c, title: r.Title, email: r.Email }),
          cite: compose(name, state ? `(${state})` : ''),
          raw_ref: r,
        });
      });
    },
  };

  // ---- bills — bill FTS5 -----------------------------------------------------------------------
  // Shape: { result: [ { bill_id, name, state, session, bill_type, introduced_year, sponsor_count,
  //                      yea_count, nay_count, summary_snippet, summary_match, rank, ... } ] }
  const billsRecipe = {
    id: 'bills',
    plane: 'internal',
    label: 'Legislation',
    enabled(plan) { return targetEnabled(plan, 'bills'); },
    async run({ query, plan, deps }) {
      const res = await deps.callTool('search_bills', { query, state: (plan && plan.state) || null, session: (plan && plan.session) || null, top_k: (plan && plan.top_k) || 30 });
      return (res && res.result) || [];
    },
    toCards(rows) {
      return (rows || []).map((r) => normalizeCard({
        id: `bills:${r.bill_id}`,
        plane: 'internal',
        source: 'bills',
        title: r.name,
        snippet: cleanText(r.summary_match || r.summary_snippet),
        url: null,
        score: scoreFromRank(r.rank),
        enrich: pruned({ state: r.state, session: r.session, bill_type: r.bill_type, introduced_year: r.introduced_year, sponsors: r.sponsor_count, votes: (r.yea_count || r.nay_count) ? { yea: r.yea_count, nay: r.nay_count } : null }),
        cite: r.name,
        raw_ref: r,
      }));
    },
  };

  // ---- polls — polling FTS5 --------------------------------------------------------------------
  // Shape: { result: [ { question_id, fielding_id, wording, question_number, fielded_start,
  //                      fielding_title, snippet } ] }. NOTE: no `rank` field → positional score
  //  (preserve the engine's returned order; the rerank leaf re-sorts later).
  const pollsRecipe = {
    id: 'polls',
    plane: 'internal',
    label: 'Polling',
    enabled(plan) { return targetEnabled(plan, 'polls'); },
    async run({ query, plan, deps }) {
      const res = await deps.callTool('search_poll_questions', { query, top_k: (plan && plan.top_k) || 20 });
      return (res && res.result) || [];
    },
    toCards(rows) {
      const list = rows || [];
      return list.map((r, i) => normalizeCard({
        id: `polls:${r.question_id}`,
        plane: 'internal',
        source: 'polls',
        title: leadTitle(r.fielding_title || r.wording),
        snippet: cleanText(r.snippet || r.wording),
        url: null,
        score: ('rank' in r) ? scoreFromRank(r.rank) : (list.length - i),
        enrich: pruned({ fielding_id: r.fielding_id, question_number: r.question_number, fielded_start: r.fielded_start }),
        cite: compose(r.question_number ? `poll ${r.question_number}` : 'poll', r.fielded_start ? `(${r.fielded_start})` : ''),
        raw_ref: r,
      }));
    },
  };

  // ---- db_query — parameterized SELECT escape hatch --------------------------------------------
  // Fires ONLY when the plan supplies SQL (the caged plan leaf composes it). Shape: { ok, rows,
  // row_count, ms, sql }. Rows have arbitrary columns → best-effort generic mapping.
  const TITLE_COLS = ['name', 'title', 'label', 'question_text', 'wording'];
  const dbQueryRecipe = {
    id: 'db_query',
    plane: 'internal',
    label: 'Direct query',
    // Special gating: not default-on. Only runs when the plan explicitly carries SQL.
    enabled(plan) { return !!(plan && plan.sql); },
    async run({ plan, deps }) {
      const res = await deps.callTool('db_query', { sql: plan.sql, params: plan.params || null });
      return (res && res.rows) || [];
    },
    toCards(rows) {
      const list = rows || [];
      return list.map((r, i) => {
        const titleKey = TITLE_COLS.find(k => r[k] != null) || Object.keys(r).find(k => typeof r[k] === 'string');
        const title = titleKey ? String(r[titleKey]) : `row ${i + 1}`;
        const rest = Object.keys(r).filter(k => k !== titleKey).map(k => `${k}: ${r[k]}`).join(' · ');
        return normalizeCard({
          id: `db_query:${djb2(JSON.stringify(r))}`,
          plane: 'internal',
          source: 'db_query',
          title,
          snippet: cleanText(rest),
          url: null,
          score: list.length - i,
          enrich: {},
          cite: title,
          raw_ref: r,
        });
      });
    },
  };

  const INTERNAL = [entitiesRecipe, contactsRecipe, billsRecipe, pollsRecipe, dbQueryRecipe];

  // ============================ EXTERNAL LANE (slice 3) ========================================
  // External recipes gate on plan.external_targets (default-on — the operator chose two lanes that
  // both run). Host of a URL → a small provenance tag.
  function externalEnabled(plan, id) {
    const t = plan && plan.external_targets;
    return !Array.isArray(t) || t.length === 0 || t.includes(id);
  }
  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }

  // ---- web — Zoe's search PRIMARY, engine web_search FALLBACK ----------------------------------
  // Zoe's search (deps.search) → { query, results: [ { title, url, snippet } ] }. The engine's
  // web_search needs provider keys it doesn't have (returns [] with providers_skipped), so it is
  // only the fallback. enrich() deepens the top FETCH_TOP results via web_extract (body=text_preview).
  const FETCH_TOP = 3;
  const webRecipe = {
    id: 'web',
    plane: 'external',
    label: 'Web',
    enabled(plan) { return externalEnabled(plan, 'web'); },
    async run({ query, plan, deps }) {
      const top_k = (plan && plan.top_k) || 10;
      const raw = (typeof deps.search === 'function')
        ? await deps.search(query)
        : await deps.callTool('web_search', { query, top_k });
      return (raw && raw.results) || [];
    },
    toCards(rows) {
      const list = rows || [];
      return list.map((r, i) => normalizeCard({
        id: `web:${djb2(r.url || r.title)}`,
        plane: 'external',
        source: 'web',
        title: r.title || hostOf(r.url),
        snippet: cleanText(r.snippet),
        url: r.url || null,
        score: list.length - i,
        enrich: pruned({ host: hostOf(r.url) }),
        cite: compose(r.title, r.url),
        raw_ref: r,
      }));
    },
    // Deepen the top FETCH_TOP hits: pull the readable body via engine web_extract (text_preview)
    // or injected deps.fetchPage. Bounded + per-url fail-safe — the body feeds the cited overview.
    async enrich(cards, deps) {
      const out = cards.slice();
      const n = Math.min(FETCH_TOP, out.length);
      for (let i = 0; i < n; i++) {
        const c = out[i];
        if (!c.url) continue;
        try {
          let body = '';
          if (typeof deps.fetchPage === 'function') { const r = await deps.fetchPage(c.url); body = (r && (r.text || r.body)) || ''; }
          else { const r = await deps.callTool('web_extract', { url: c.url }); body = (r && (r.text_preview || r.text_excerpt || r.body)) || ''; }
          if (body) out[i] = { ...c, enrich: { ...c.enrich, body: cleanText(body).slice(0, 1200), fetched: true } };
        } catch (e) { /* fail-safe: leave the card as-is */ }
      }
      return out;
    },
  };

  // ---- academic — keyless OpenAlex / Crossref / DOAJ -------------------------------------------
  // Shape: { results: [ { title, authors[], year, venue, doi, url, abstract, cited_by_count,
  //                       is_oa, source } ], providers_used, providers_skipped }
  const academicRecipe = {
    id: 'academic',
    plane: 'external',
    label: 'Academic',
    enabled(plan) { return externalEnabled(plan, 'academic'); },
    async run({ query, plan, deps }) {
      const res = await deps.callTool('academic_search', { query, top_k: (plan && plan.top_k) || 10 });
      return (res && res.results) || [];
    },
    toCards(rows) {
      const list = rows || [];
      return list.map((r, i) => {
        const authors = Array.isArray(r.authors) ? r.authors : [];
        const byline = authors.length ? (authors.length > 2 ? `${authors[0]} et al.` : authors.join(', ')) : '';
        return normalizeCard({
          id: `academic:${djb2(r.doi || r.url || r.title)}`,
          plane: 'external',
          source: 'academic',
          title: r.title,
          snippet: cleanText(r.abstract) || compose(byline, r.venue, r.year),
          url: r.url || (r.doi ? `https://doi.org/${r.doi}` : null),
          score: list.length - i,
          enrich: pruned({ authors: byline, year: r.year, venue: r.venue, doi: r.doi, cited_by: r.cited_by_count, open_access: r.is_oa, provider: r.source }),
          cite: compose(byline, r.year ? `(${r.year})` : '', r.venue, r.doi ? `doi:${r.doi}` : ''),
          raw_ref: r,
        });
      });
    },
  };

  const EXTERNAL = [webRecipe, academicRecipe];

  // Full registry = knowledge (contract module) + internal set + external lane.
  function buildRegistry() {
    const reg = { knowledge: knowledgeRecipe };
    for (const r of INTERNAL) reg[r.id] = r;
    for (const r of EXTERNAL) reg[r.id] = r;
    return reg;
  }
  function recipes() { return Object.values(buildRegistry()); }

  return {
    entitiesRecipe, contactsRecipe, billsRecipe, pollsRecipe, dbQueryRecipe,
    webRecipe, academicRecipe,
    INTERNAL, EXTERNAL, buildRegistry, recipes, pruned, hostOf,
  };
});
