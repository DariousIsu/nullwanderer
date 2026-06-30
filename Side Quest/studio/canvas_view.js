/* studio/canvas_view.js — Zoe Canvas: normalize saga-canvas tabs + typed blocks into view shapes
 * (Slice 0, PURE — no I/O, no model). The Side Quest renderer draws what this returns; Echo owns the
 * canvas state (tenant_rainey.canvas_tabs / canvas_blocks) and the schema-locked saga_render_* path.
 *
 * Block-data schemas mirror Echo's saga_canvas_add_block contract. Stage-4 block types get a fully
 * normalized view; the rest pass through as `supported:false` with a safe preview so the UI renders a
 * labelled fallback instead of breaking (Echo expands its own renderers over its stages; we mirror).
 */
'use strict';

const MODES = new Set(['DOC', 'ILLUSTRATIVE', 'RESEARCH', 'JOB']);
const KNOWN_BLOCKS = new Set([
  'heading', 'paragraph', 'list', 'code', 'table', 'chart', 'metric_card', 'callout', 'image',
  'diagram', 'knowledge_graph', 'document_file', 'browser_snapshot', 'map', 'three',
  'draft_review', 'citation', 'source_card',
]);
const STAGE4 = new Set(['heading', 'paragraph', 'table', 'chart']);   // Echo's first-shipped renderers
const RENDERABLE = new Set(['heading', 'paragraph', 'table', 'chart', 'image', 'pdf', 'html', 'document_file']);   // what OUR canvas draws
const CHART_KINDS = new Set(['line', 'bar', 'area']);

const str = (v) => (v == null ? '' : String(v));
const clampInt = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

// canvas_blocks.data is stored as a JSON TEXT column; accept either a parsed object or the raw
// string and fail soft to {} so a malformed payload renders a labelled fallback, never throws.
function parseData(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try { const o = JSON.parse(raw); return (o && typeof o === 'object') ? o : {}; } catch { return {}; }
  }
  return {};
}

function normalizeTab(tab) {
  const t = tab || {};
  const mode = String(t.mode || '').toUpperCase();
  const closedAt = intOrNull(t.closed_at);
  return {
    key: str(t.tab_key || t.key || t.id),
    mode: MODES.has(mode) ? mode : 'DOC',
    title: str(t.title).trim() || '(untitled)',
    openedAt: intOrNull(t.opened_at),
    closedAt,
    open: closedAt == null,
  };
}

// Per-Stage-4-type normalizers. Each returns a clean, render-ready view object.
function viewHeading(d) { return { level: clampInt(d.level, 1, 3, 2), text: str(d.text) }; }
function viewParagraph(d) { return { markdown: str(d.markdown) }; }
function viewTable(d) {
  const headers = Array.isArray(d.headers) ? d.headers.map(str) : [];
  const rows = Array.isArray(d.rows) ? d.rows.map(r => (Array.isArray(r) ? r.map(str) : [str(r)])) : [];
  return { headers, rows, caption: d.caption ? str(d.caption) : null };
}
function viewChart(d) {
  const kind = CHART_KINDS.has(String(d.kind)) ? String(d.kind) : 'line';
  const yKeys = Array.isArray(d.y_keys) ? d.y_keys.map(str).filter(Boolean) : [];
  const xKey = str(d.x_key);
  const series = Array.isArray(d.series) ? d.series : [];
  return {
    kind, xKey, yKeys,
    title: d.title ? str(d.title) : null,
    height: clampInt(d.height, 80, 600, 220),
    points: series.map(p => {
      const out = { x: (p && p[xKey] != null) ? p[xKey] : null };
      for (const k of yKeys) out[k] = (p && Number.isFinite(+p[k])) ? +p[k] : null;
      return out;
    }),
  };
}

// image block — a dropped/produced image, carried as a data URI (or URL). alt for accessibility.
function viewImage(d) { return { src: str(d.src || d.url || d.dataUri || d.data_uri || ''), alt: str(d.alt || d.title || '') }; }
// pdf block — embedded document (Chromium PDF viewer); src is a data: URI or file URL.
function viewPdf(d) { return { src: str(d.src || d.url || ''), alt: str(d.alt || d.title || '') }; }
// html block — rich HTML (e.g. docx → mammoth HTML). The renderer sanitizes before paint.
function viewHtml(d) { return { html: str(d.html || d.markup || '') }; }
// document_file — the taxonomy's file-artifact carrier (pdf/html etc.; 'pdf'/'html' are NOT valid
// engine block types). Carries an embeddable src (PDF file URL) OR rich html; renderer picks.
function viewDocumentFile(d) { return { src: str(d.src || d.url || ''), html: str(d.html || d.markup || ''), alt: str(d.alt || d.title || '') }; }

// A short, safe preview of an unsupported block's payload (so the fallback card shows something).
function preview(data) {
  try { const s = JSON.stringify(data); return s.length > 240 ? s.slice(0, 240) + '…' : s; }
  catch { return ''; }
}

// Normalize one block (row from canvas_blocks OR an add_block payload) → render-ready view.
function normalizeBlock(block) {
  const b = block || {};
  const type = String(b.block_type || b.type || '').toLowerCase();
  const data = parseData(b.data);
  const base = {
    id: str(b.block_id || b.id), type,
    known: KNOWN_BLOCKS.has(type), supported: RENDERABLE.has(type),
    position: intOrNull(b.position), createdAt: intOrNull(b.created_at), updatedAt: intOrNull(b.updated_at),
  };
  if (type === 'heading') return { ...base, view: viewHeading(data) };
  if (type === 'paragraph') return { ...base, view: viewParagraph(data) };
  if (type === 'table') return { ...base, view: viewTable(data) };
  if (type === 'chart') return { ...base, view: viewChart(data) };
  if (type === 'image') return { ...base, view: viewImage(data) };
  if (type === 'pdf') return { ...base, view: viewPdf(data) };
  if (type === 'html') return { ...base, view: viewHtml(data) };
  if (type === 'document_file') return { ...base, view: viewDocumentFile(data) };
  return { ...base, view: { preview: preview(data) } };   // labelled fallback for non-Stage-4 types
}

// Normalize a whole tab's vertical block stream + a small summary for the tab header.
function normalizeStream(blocks) {
  const list = (Array.isArray(blocks) ? blocks : []).map(normalizeBlock);
  return {
    blocks: list,
    summary: {
      total: list.length,
      supported: list.filter(b => b.supported).length,
      byType: list.reduce((m, b) => { m[b.type] = (m[b.type] || 0) + 1; return m; }, {}),
    },
  };
}

module.exports = {
  MODES, KNOWN_BLOCKS, STAGE4, RENDERABLE, CHART_KINDS,
  normalizeTab, normalizeBlock, normalizeStream, parseData,
  viewHeading, viewParagraph, viewTable, viewChart, viewImage, viewPdf, viewHtml, viewDocumentFile,
};
