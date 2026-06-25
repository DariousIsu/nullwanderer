/*
 * Reader / Library surface — standardized VIEW model. Pure mappers from the engine's corpus tools
 * (list_projects / recent_documents / get_document) → fixed render shapes. The Reader rides the
 * document substrate: a document's `markdown` body flows through editor_import.normalizeMarkdown →
 * the same structured block model the whole writing suite uses. No model, read-only. Grounded on
 * REAL shapes captured live (2026-06-25). Phase 2 of the writing suite; see project_writing_suite.
 *
 * Runs in Node (smoke) and the browser (surface): CommonJS + window fallback.
 */
(function (root, factory) {
  const EI = (typeof require !== 'undefined') ? require('../lib/editor_import') : (typeof window !== 'undefined' ? window.EditorImport : null);
  const api = factory(EI);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DocView = api;
})(this, function (EI) {
  'use strict';

  function basename(p) { return String(p || '').split(/[\\/]/).pop() || ''; }
  function extOf(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; }
  // unix-seconds (or ms) → YYYY-MM-DD; tolerant of both scales.
  function isoDate(ts) {
    const n = Number(ts); if (!Number.isFinite(n) || n <= 0) return '';
    const ms = n < 1e12 ? n * 1000 : n;
    try { return new Date(ms).toISOString().slice(0, 10); } catch (e) { return ''; }
  }

  // list_projects payload → Library project entries (for the project filter). Sorted by doc count desc.
  function projectList(payload) {
    const rows = (payload && payload.result) || (Array.isArray(payload) ? payload : []);
    return rows.map(p => ({
      name: p.project_name, type: p.project_type || '', domain: p.domain || '',
      count: Number(p.document_count) || 0, path: p.path || '',
    })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  // recent_documents payload → document list items.
  function docList(payload) {
    const rows = (payload && payload.result) || (Array.isArray(payload) ? payload : []);
    return rows.map(d => {
      const srcExt = extOf(d.source_path) || extOf(d.path);
      return {
        id: d.id, title: d.title || basename(d.path) || `doc ${d.id}`,
        project: d.project_name || '', date: isoDate(d.ingested_at || d.mtime),
        method: d.extraction_method || '', sourceExt: srcExt, path: d.path || '',
      };
    });
  }

  // get_document(full) payload → the reader view: metadata header + structured blocks (body
  // markdown normalized through the shared block model).
  function readerDoc(payload) {
    if (!payload || payload.id == null) return null;
    const fm = payload.frontmatter || (() => { try { return JSON.parse(payload.frontmatter_json || '{}'); } catch (e) { return {}; } })();
    const wc = (EI && typeof EI.normalizeMarkdown === 'function')
      ? EI.normalizeMarkdown(payload.markdown || '', { title: payload.title || null, format: 'md' })
      : { blocks: [], title: payload.title || '' };
    const srcExt = extOf(payload.source_path) || extOf(payload.path);
    return {
      id: payload.id,
      title: payload.title || wc.title || `doc ${payload.id}`,
      project: payload.project_name || '',
      sourceExt: srcExt,
      method: payload.extraction_method || '',
      date: isoDate(payload.ingested_at || payload.mtime),
      sourcePath: payload.source_path || payload.path || '',
      // surface a few useful frontmatter fields (drop the noisy/internal ones)
      meta: pickMeta(fm),
      blocks: wc.blocks || [],
      blockCount: (wc.blocks || []).length,
    };
  }

  // Keep human-relevant frontmatter; drop internal plumbing keys.
  const META_DROP = new Set(['title', 'source_vault_path', 'archived_from', 'sha256', 'frontmatter_json']);
  function pickMeta(fm) {
    const out = [];
    for (const k in (fm || {})) {
      if (META_DROP.has(k)) continue;
      const v = fm[k];
      if (v == null || v === '') continue;
      out.push({ key: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v) });
    }
    return out;
  }

  return { basename, extOf, isoDate, projectList, docList, readerDoc, pickMeta };
});
