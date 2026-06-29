/* scripts/smoke_canvas_view.js — offline checks for the Zoe Canvas view-mappers (pure node). */
'use strict';
const V = require('../studio/canvas_view');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

// ---- tabs ----
ok('tab mode passthrough', V.normalizeTab({ tab_key: 't1', mode: 'ILLUSTRATIVE', title: 'EPA' }).mode === 'ILLUSTRATIVE');
ok('tab bad mode → DOC', V.normalizeTab({ mode: 'WHATEVER' }).mode === 'DOC');
ok('tab untitled fallback', V.normalizeTab({ mode: 'doc' }).title === '(untitled)' && V.normalizeTab({ mode: 'doc' }).mode === 'DOC');

// ---- heading ----
const h = V.normalizeBlock({ block_id: 'b1', block_type: 'heading', data: { level: 5, text: 'Hi' } });
ok('heading supported + level clamped to 3', h.supported && h.view.level === 3 && h.view.text === 'Hi');

// ---- paragraph ----
ok('paragraph markdown', V.normalizeBlock({ block_type: 'paragraph', data: { markdown: '**bold**' } }).view.markdown === '**bold**');

// ---- table ----
const t = V.normalizeBlock({ block_type: 'table', data: { headers: ['A', 'B'], rows: [[1, 2], [3, 4]], caption: 'c' } });
ok('table headers/rows/caption', t.view.headers.length === 2 && t.view.rows.length === 2 && t.view.rows[0][0] === '1' && t.view.caption === 'c');
ok('table tolerates missing rows', V.normalizeBlock({ block_type: 'table', data: { headers: ['A'] } }).view.rows.length === 0);

// ---- chart ----
const c = V.normalizeBlock({ block_type: 'chart', data: {
  kind: 'bar', x_key: 'q', y_keys: ['rev'], title: 'Q', height: 999,
  series: [{ q: 'Q1', rev: 10 }, { q: 'Q2', rev: 'oops' }],
} });
ok('chart kind kept', c.view.kind === 'bar' && c.view.title === 'Q');
ok('chart height clamped', c.view.height === 600);
ok('chart points mapped, bad y → null', c.view.points[0].rev === 10 && c.view.points[1].rev === null && c.view.points[0].x === 'Q1');
ok('chart bad kind → line', V.normalizeBlock({ block_type: 'chart', data: { kind: 'pie' } }).view.kind === 'line');

// ---- fallback for non-Stage-4 known type ----
const kg = V.normalizeBlock({ block_type: 'knowledge_graph', data: { nodes: [1, 2] } });
ok('knowledge_graph known but not supported', kg.known && !kg.supported && /nodes/.test(kg.view.preview));
// ---- unknown type ----
const u = V.normalizeBlock({ block_type: 'wat', data: {} });
ok('unknown type not known, has preview', !u.known && !u.supported && typeof u.view.preview === 'string');

// ---- Slice 1: tab open/closed status + timestamps ----
const openTab = V.normalizeTab({ tab_key: 'doc-1', mode: 'DOC', title: 'Live', opened_at: 1780623699, closed_at: null });
ok('tab open when closed_at null', openTab.open === true && openTab.closedAt === null && openTab.openedAt === 1780623699);
const closedTab = V.normalizeTab({ tab_key: 'doc-2', mode: 'DOC', title: 'Done', opened_at: 1, closed_at: 99 });
ok('tab closed when closed_at set', closedTab.open === false && closedTab.closedAt === 99);

// ---- Slice 1: data arrives as a JSON string (the canvas_blocks.data TEXT column) ----
const strData = V.normalizeBlock({ block_id: 'b9', block_type: 'paragraph', data: '{"markdown":"**hi**"}', position: 3, created_at: 1780623699 });
ok('JSON-string data parsed', strData.view.markdown === '**hi**' && strData.position === 3 && strData.createdAt === 1780623699);
ok('table from JSON string', V.normalizeBlock({ block_type: 'table', data: '{"headers":["A"],"rows":[["1"]]}' }).view.rows[0][0] === '1');
ok('malformed JSON string → empty fallback', V.normalizeBlock({ block_type: 'paragraph', data: '{not json' }).view.markdown === '');
ok('parseData object passthrough', V.parseData({ x: 1 }).x === 1 && Object.keys(V.parseData('nope')).length === 0);

// ---- stream summary ----
const s = V.normalizeStream([
  { block_type: 'heading', data: { text: 'T' } },
  { block_type: 'paragraph', data: { markdown: 'p' } },
  { block_type: 'map', data: {} },
]);
ok('stream counts', s.summary.total === 3 && s.summary.supported === 2 && s.summary.byType.heading === 1 && s.summary.byType.map === 1);

console.log(`\nsmoke_canvas_view: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
