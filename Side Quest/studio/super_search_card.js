/*
 * Super Search — the standardized RESULT-CARD contract + the recipe registry skeleton.
 *
 * Super Search blends two planes (internal owned corpus ∣ external web) behind ONE deterministic
 * pathway. The thing that lets "everything owned" coexist with the determinism law is this: every
 * result — a Wikipedia FTS hit, a CRM contact, a bill, a web page — normalizes to ONE frozen shape,
 * the ResultCard. The model is caged at three downstream leaves (plan · rerank · overview); the
 * cards themselves are produced by deterministic per-source RECIPES, never by a model.
 *
 * A recipe binds the query to a KNOWN owned tool, maps that tool's KNOWN result shape → cards, and
 * may enrich via the atlas join spine. Because the data surface is fully mapped (get_atlas /
 * get_db_map), each recipe is a tight, known transform — not a guess. See docs/SUPER_SEARCH_SPEC.md.
 *
 * SLICE 1 ships the card contract + the registry skeleton with ONE recipe (`knowledge`, over
 * search_knowledge). Every external dependency is injected (deps.callTool), so this runs pure and
 * offline under the smoke; the live engine is only reached when main wires real deps in slice 7.
 *
 * Runs in Node (smoke) and the browser (surface): CommonJS + window fallback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SuperSearchCard = api;
})(this, function () {
  'use strict';

  const PLANES = ['internal', 'external'];

  // The frozen card field set. Required fields must be present + well-typed or the card is INVALID
  // (flagged, not guessed — feedback-workspace-determinism: reject non-conforming output).
  const REQUIRED = ['id', 'plane', 'source', 'title', 'snippet', 'score'];
  const CARD_FIELDS = ['id', 'plane', 'source', 'title', 'snippet', 'url', 'score', 'rank', 'enrich', 'cite', 'raw_ref'];

  // ---- deterministic atoms ---------------------------------------------------------------------

  // djb2 → base36. Stable id derivation with NO randomness (Math.random is unavailable in workflow
  // scripts anyway, and we want re-runs to produce identical ids).
  function djb2(str) {
    let h = 5381;
    const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  // Strip FTS <mark> highlight tags + collapse whitespace. The engine's FTS snippets come wrapped
  // in <mark>…</mark>; the card stores clean display text and keeps the raw hit in raw_ref.
  function cleanText(s) {
    return String(s == null ? '' : s)
      .replace(/<\/?mark>/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Derive a display title from a snippet that carries no explicit title (e.g. Wikipedia FTS hits).
  // Drop a leading "…", take up to `max` chars at a word boundary.
  function leadTitle(snippet, max = 80) {
    let t = cleanText(snippet).replace(/^[.…]+\s*/, '');
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    return (sp > max * 0.5 ? cut.slice(0, sp) : cut).trim() + '…';
  }

  // FTS5 bm25 `rank` is negative; more-negative = better. Normalize to higher = better so all
  // sources expose a comparable "bigger is more relevant" pre-rank score. Raw rank stays in raw_ref.
  function scoreFromRank(rank) {
    const r = Number(rank);
    return Number.isFinite(r) ? -r : 0;
  }

  // ---- the card contract -----------------------------------------------------------------------

  // Coerce a partial into a complete, well-typed ResultCard with defaults filled. Always returns a
  // full-shape object; validity is reported separately by validateCard (mappers normalize, the
  // contract test validates).
  function normalizeCard(p) {
    const o = p || {};
    return {
      id: o.id != null ? String(o.id) : '',
      plane: o.plane,
      source: o.source != null ? String(o.source) : '',
      title: cleanText(o.title),
      snippet: cleanText(o.snippet),
      url: o.url != null && o.url !== '' ? String(o.url) : null,
      score: Number.isFinite(Number(o.score)) ? Number(o.score) : 0,
      rank: Number.isFinite(Number(o.rank)) ? Number(o.rank) : null,
      enrich: o.enrich && typeof o.enrich === 'object' ? o.enrich : {},
      cite: o.cite != null ? String(o.cite) : '',
      raw_ref: o.raw_ref !== undefined ? o.raw_ref : null,
    };
  }

  // Validate a normalized card against the frozen contract. Returns { valid, missing } — missing
  // lists the required fields that are absent/empty/ill-typed. Deterministic, no throw.
  function validateCard(card) {
    const c = card || {};
    const missing = [];
    for (const f of REQUIRED) {
      if (f === 'score') { if (!Number.isFinite(Number(c.score))) missing.push(f); continue; }
      if (f === 'plane') { if (!PLANES.includes(c.plane)) missing.push(f); continue; }
      if (c[f] == null || c[f] === '') missing.push(f);
    }
    return { valid: missing.length === 0, missing };
  }

  // ---- recipe registry -------------------------------------------------------------------------
  // A recipe is { id, plane, label, enabled(plan), run({query,plan,deps}), toCards(rows) }.
  // run() MUST take all I/O through injected deps (deps.callTool) so the studio stays testable and
  // the one-pathway orchestrator owns the wiring.

  // `knowledge` — the attached FTS5 corpora (wikipedia / general / rainey) via search_knowledge.
  // Real return shape (grounded live 2026-06-24): { result: [ { source, snippet, rank, civic_links? } ] }
  //  — no title/url/id, so we derive title from the snippet, leave url null, and hash a stable id.
  //  civic_links (when present) are the atlas spine: a knowledge hit anchored to a civic entity.
  const knowledgeRecipe = {
    id: 'knowledge',
    plane: 'internal',
    label: 'Knowledge corpora',
    // Enabled when the plan targets it, or by default when no plan/targets given.
    enabled(plan) { return targetEnabled(plan, 'knowledge'); },
    async run({ query, plan, deps }) {
      const source = (plan && plan.knowledge_source) || null;
      const top_k = (plan && plan.top_k) || 10;
      const res = await deps.callTool('search_knowledge', { query, source, top_k, include_civic_links: true });
      return (res && res.result) || [];
    },
    toCards(rows) {
      return (rows || []).map((r) => {
        const corpus = r.source || 'knowledge';
        const cleanSnippet = cleanText(r.snippet);
        const links = Array.isArray(r.civic_links) ? r.civic_links : [];
        const enrich = { corpus };
        if (links.length) enrich.civic_links = links;
        const title = leadTitle(r.snippet);
        return normalizeCard({
          id: `knowledge:${corpus}:${djb2(r.snippet)}`,
          plane: 'internal',
          source: 'knowledge',
          title,
          snippet: cleanSnippet,
          url: null,
          score: scoreFromRank(r.rank),
          enrich,
          cite: `${corpus}: "${title}"`,
          raw_ref: r,
        });
      });
    },
  };

  const REGISTRY = { knowledge: knowledgeRecipe };

  function recipes() { return Object.values(REGISTRY); }

  // Run one recipe end-to-end against injected deps. Deterministic + fail-safe: a disabled recipe
  // returns no cards; a thrown tool error is captured (never propagated) so one bad source can't
  // sink the lane. If the recipe declares an async enrich(cards, deps) — the atlas spine join — it
  // runs after toCards and is covered by the same fail-safe. Returns { source, cards, error }.
  async function runRecipe(recipe, { query, plan, deps }) {
    if (!recipe.enabled(plan)) return { source: recipe.id, cards: [], error: null, skipped: true };
    try {
      const rows = await recipe.run({ query, plan, deps });
      let cards = recipe.toCards(rows);
      if (typeof recipe.enrich === 'function') cards = await recipe.enrich(cards, deps);
      return { source: recipe.id, cards, error: null };
    } catch (e) {
      return { source: recipe.id, cards: [], error: String((e && e.message) || e) };
    }
  }

  // Shared enabled-gate: a recipe is on when the plan names no internal_targets (default-on) or
  // explicitly lists this recipe id. Recipes with special gating (db_query) override enabled().
  function targetEnabled(plan, id) {
    const t = plan && plan.internal_targets;
    return !Array.isArray(t) || t.length === 0 || t.includes(id);
  }

  // Join truthy parts into a " · " descriptor (for cards whose tool returns fields, not a snippet).
  function compose(...parts) { return parts.map(p => (p == null ? '' : String(p)).trim()).filter(Boolean).join(' · '); }

  return {
    PLANES, REQUIRED, CARD_FIELDS,
    djb2, cleanText, leadTitle, scoreFromRank,
    normalizeCard, validateCard,
    knowledgeRecipe, REGISTRY, recipes, runRecipe, targetEnabled, compose,
  };
});
