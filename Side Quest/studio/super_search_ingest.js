/*
 * Super Search — the INGEST-GATED loop (slice 5). The feedback edge that turns search into a way
 * to GROW the brain: a kept EXTERNAL result is archived into the owned Vault (via save_source) so
 * the next INTERNAL search finds it. This is the one place the operator's choice ("auto-ingest")
 * meets the determinism law — so it is gated three ways:
 *
 *   DEDUP       — a ledger keyed by URL; an already-ingested URL is skipped, never re-archived.
 *   PROVENANCE  — every ingest writes a ledger row: card_id, url, title, the QUERY that surfaced
 *                 it, source recipe, timestamp, and the corpus ref returned by the engine.
 *   REVERSIBLE  — revert(id) archives the corpus doc (best-effort) and drops the ledger row, so
 *                 the same URL can be re-ingested later. The ledger is the audit trail.
 *
 * Pure over injected deps (deps.callTool / deps.ledger / deps.now) — no HTTP, no DB here, so it is
 * offline-testable; slice 7 backs the ledger with Zoe's SQLite. A failed engine call leaves the
 * ledger UNTOUCHED (no phantom rows; the URL stays retryable). See docs/SUPER_SEARCH_SPEC.md.
 *
 * Runs in Node (smoke) and the browser: CommonJS + window fallback.
 */
(function (root, factory) {
  const card = (typeof require !== 'undefined') ? require('./super_search_card')
    : (typeof window !== 'undefined' ? window.SuperSearchCard : null);
  const api = factory(card);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SuperSearchIngest = api;
})(this, function (card) {
  'use strict';
  const { djb2, cleanText } = card;

  // A simple in-memory ledger (the smoke uses this; slice 7 swaps a SQLite-backed one with the
  // same interface: has(url) · add(entry) · remove(id) · list()).
  function makeMemoryLedger() {
    const byUrl = new Map();
    return {
      has: (url) => byUrl.has(url),
      get: (url) => byUrl.get(url) || null,
      add: (entry) => { byUrl.set(entry.url, entry); return entry; },
      remove: (id) => { for (const [u, e] of byUrl) if (e.id === id) { byUrl.delete(u); return true; } return false; },
      list: () => [...byUrl.values()],
    };
  }

  // Only EXTERNAL cards with a URL and some text are ingestable — internal cards already live in
  // the corpus; a bodyless/urlless card has nothing durable to archive.
  function ingestable(c) {
    if (!c || c.plane !== 'external') return { ok: false, reason: 'not_external' };
    if (!c.url) return { ok: false, reason: 'no_url' };
    const body = (c.enrich && c.enrich.body) || c.snippet || '';
    if (!cleanText(body)) return { ok: false, reason: 'no_text' };
    return { ok: true };
  }

  function makeIngestor({ callTool, ledger, now, ingestTool = 'save_source', revertTool = 'archive_document' } = {}) {
    const led = ledger || makeMemoryLedger();
    const stamp = now || (() => new Date().toISOString());

    async function ingestCard(c, { query = '', citingDocIds = [] } = {}) {
      const g = ingestable(c);
      if (!g.ok) return { ingested: false, reason: g.reason, card_id: c && c.id };
      if (led.has(c.url)) return { ingested: false, reason: 'duplicate', card_id: c.id, url: c.url };
      const content_md = cleanText((c.enrich && c.enrich.body) || c.snippet || '');
      const frontmatter = { source: c.url, collection_date: stamp(), title: c.title, via: 'super_search', query };
      let ref = null;
      try {
        const res = await callTool(ingestTool, { original_url: c.url, content_md, citing_doc_ids: citingDocIds, frontmatter });
        ref = (res && (res.doc_id != null ? res.doc_id : res.id != null ? res.id : res.source_id)) || null;
      } catch (e) {
        return { ingested: false, reason: String((e && e.message) || e), card_id: c.id };  // ledger untouched → retryable
      }
      const entry = { id: djb2(c.url), card_id: c.id, url: c.url, title: c.title, query, source: c.source, ingested_at: frontmatter.collection_date, ref };
      led.add(entry);
      return { ingested: true, entry };
    }

    // Batch over a set of kept cards. Re-gates each (caller intent + safety). Returns the split.
    async function ingestKept(cards, opts = {}) {
      const ingested = [], skipped = [];
      for (const c of (cards || [])) {
        const r = await ingestCard(c, opts);
        if (r.ingested) ingested.push(r.entry);
        else skipped.push({ card_id: r.card_id, reason: r.reason });
      }
      return { ingested, skipped };
    }

    // Undo an ingest: archive the corpus doc (best-effort) then drop the ledger row.
    async function revert(id) {
      const entry = led.list().find(e => e.id === id);
      if (!entry) return { reverted: false, reason: 'not_found' };
      if (entry.ref != null && revertTool) { try { await callTool(revertTool, { doc_id: entry.ref }); } catch (e) { /* best-effort */ } }
      led.remove(id);
      return { reverted: true, entry };
    }

    return { ingestCard, ingestKept, revert, ledger: led };
  }

  return { makeIngestor, makeMemoryLedger, ingestable };
});
