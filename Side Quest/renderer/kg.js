/* Knowledge Graph surface — operator entity-network explorer. Vanilla force-graph (MIT) canvas;
   data via window.sq.kg.* over IPC (main builds the graph + styling via studio/kg_view.js). Two
   modes: corpus overview (graph_overview) + ego-network (query_graph). Client-side type-filter,
   click-to-recenter, fuzzy search. Read-only — a view-only port of Echo's KnowledgeGraphSurface. */
'use strict';
const $ = (id) => document.getElementById(id);
const graphEl = $('graph'), overlay = $('overlay'), pillsEl = $('pills'), legendEl = $('legend'),
  statsEl = $('stats'), hoverEl = $('hovercard'), qEl = $('q'), ddEl = $('dd'), hopsEl = $('hops'), backBtn = $('backBtn'),
  followBtn = $('followBtn'), nowLbl = $('nowLbl');

let G = null;             // force-graph instance
let full = { nodes: [], links: [] };   // pristine current-mode graph (string-keyed links)
let selected = new Set(); // active entity-type filter
let hovered = null;
let mode = 'overview', submitted = '';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function setOverlay(text, cls) { if (!text) { overlay.hidden = true; return; } overlay.hidden = false; overlay.className = 'overlay' + (cls ? ' ' + cls : ''); overlay.textContent = text; }

function ensureGraph() {
  if (G) return G;
  G = ForceGraph()(graphEl)
    .nodeId('id').backgroundColor('#0a0b0e')
    .cooldownTicks(120).d3VelocityDecay(0.3)
    .linkColor(l => l.color).linkWidth(l => l.width)
    .linkDirectionalArrowLength(3).linkDirectionalArrowRelPos(1)
    .linkLabel(l => `${l.relType} (${l.category})`)
    .onNodeHover(n => { hovered = n || null; renderHover(); if (G) G.nodeColor(G.nodeColor()); })
    .onNodeClick(n => { if (n && !n.isFocal) focus(n.id); })
    .nodePointerAreaPaint((n, color, ctx) => { ctx.beginPath(); ctx.arc(n.x, n.y, n.isFocal ? 10 : 8, 0, 2 * Math.PI, false); ctx.fillStyle = color; ctx.fill(); })
    .nodeCanvasObject((n, ctx, scale) => {
      let r = 4;
      if (n.isFocal) r = 7;
      else if (n.overviewSource && n.degree !== undefined) r = Math.max(4, Math.min(10, 4 + Math.log10((n.degree || 0) + 1) * 1.5));
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI, false); ctx.fillStyle = n.color || '#7dd3fc'; ctx.fill();
      if (n.isFocal) { ctx.lineWidth = 2 / scale; ctx.strokeStyle = '#FBBF24'; ctx.stroke(); }
      if (n.overviewSource === 'recent' || n.overviewSource === 'both') { ctx.beginPath(); ctx.arc(n.x, n.y, r + 2, 0, 2 * Math.PI, false); ctx.setLineDash([2, 2]); ctx.lineWidth = 1.2 / scale; ctx.strokeStyle = '#FBBF24'; ctx.stroke(); ctx.setLineDash([]); }
      if (hovered && hovered.id === n.id) { ctx.beginPath(); ctx.arc(n.x, n.y, r * 1.8, 0, 2 * Math.PI, false); ctx.strokeStyle = 'rgba(125,211,252,0.85)'; ctx.lineWidth = 1.5 / scale; ctx.stroke(); }
      if (scale > 0.6 || n.isFocal) {
        const fs = Math.max(9, 11 / Math.sqrt(scale));
        ctx.font = `${fs}px sans-serif`; ctx.fillStyle = n.isFocal ? '#FBBF24' : '#CBD5E1'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(n.id.length > 32 ? n.id.slice(0, 32) + '…' : n.id, n.x, n.y + r + 2);
      }
    });
  const fit = () => { const w = graphEl.clientWidth, h = graphEl.clientHeight; G.width(w).height(h); };
  fit(); new ResizeObserver(fit).observe(graphEl);
  return G;
}

// client-side type filter → fresh graphData (clone links so force-graph's source/target mutation
// never corrupts the pristine `full`).
function applyFilter() {
  const useFilter = selected.size > 0;
  const nodes = full.nodes.filter(n => n.isFocal || !useFilter || selected.has(n.entityType));
  const present = new Set(nodes.map(n => n.id));
  const links = full.links
    .map(l => ({ source: typeof l.source === 'object' ? l.source.id : l.source, target: typeof l.target === 'object' ? l.target.id : l.target, relType: l.relType, color: l.color, width: l.width, category: l.category }))
    .filter(l => present.has(l.source) && present.has(l.target));
  ensureGraph().graphData({ nodes, links });
  if (nodes.length) setTimeout(() => { try { G.zoomToFit(400, 50); } catch (e) {} }, 450);
}

function renderPills(types) {
  if (!types || !types.length) { pillsEl.innerHTML = ''; return; }
  const sel = selected;
  pillsEl.innerHTML = types.map(t => {
    const on = sel.size === 0 || sel.has(t);
    const col = (full.nodes.find(n => n.entityType === t) || {}).color || '#7dd3fc';
    return `<button class="pill" data-t="${esc(t)}" style="border-color:${col};color:${on ? col : 'var(--tx-fainter)'};background:${on ? col + '22' : 'transparent'}">${esc(t)}</button>`;
  }).join('') + (sel.size ? `<button class="pill" data-t="__clear__" style="border-color:var(--line-strong);color:var(--tx-dim)">clear</button>` : '');
  pillsEl.querySelectorAll('.pill').forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.t;
    if (t === '__clear__') selected = new Set();
    else { selected.has(t) ? selected.delete(t) : selected.add(t); }
    renderPills(types); applyFilter();
  }));
}

function renderLegend(rows) {
  if (!rows || !rows.length) { legendEl.hidden = true; return; }
  legendEl.hidden = false;
  legendEl.innerHTML = `<div class="lt">edges</div>` + rows.map(r => `<div class="row"><span class="bar" style="background:${r.color};height:${Math.max(1, r.width)}px"></span>${esc(r.category)}</div>`).join('');
}

function renderHover() {
  if (!hovered) { hoverEl.hidden = true; return; }
  hoverEl.hidden = false;
  hoverEl.innerHTML = `<div class="hh"><span class="swatch" style="background:${hovered.color || '#7dd3fc'}"></span><span class="nm">${esc(hovered.id)}</span><span class="ty">${esc(hovered.entityType)}</span></div>${hovered.summary ? `<div class="sm">${esc(hovered.summary)}</div>` : ''}<div class="hint">${hovered.isFocal ? 'focal entity' : 'click to re-center'}</div>`;
}

function setData(res, m) {
  mode = m;
  backBtn.hidden = (m !== 'ego');
  if (!res || !res.ok) { setOverlay((res && res.error) || 'failed to load', 'fail'); full = { nodes: [], links: [] }; renderPills([]); statsEl.hidden = true; return; }
  if (res.error) { setOverlay(`${res.error}: ${submitted}`, 'warn'); full = { nodes: [], links: [] }; renderPills([]); applyFilter(); statsEl.hidden = true; return; }
  full = { nodes: res.nodes || [], links: res.links || [] };
  selected = new Set();
  renderPills(res.availableTypes || []);
  renderLegend(res.legend || []);
  setOverlay(full.nodes.length ? null : 'No graph data.');
  statsEl.hidden = false;
  statsEl.textContent = m === 'ego'
    ? `ego · ${res.stats ? res.stats.related : full.links.length} related · hops=${res.stats ? res.stats.hops : ''}`
    : `overview · ${(res.stats && res.stats.totalEntities || 0).toLocaleString()} nodes · ${(res.stats && res.stats.totalRelations || 0).toLocaleString()} edges`;
  applyFilter();
}

async function loadOverview() {
  mode = 'overview'; submitted = ''; backBtn.hidden = true; setOverlay('Loading corpus overview…');
  try { setData(await window.sq.kg.overview(), 'overview'); } catch (e) { setOverlay(String(e.message || e), 'fail'); }
}
async function focus(name) {
  submitted = name; qEl.value = name; ddEl.hidden = true; setOverlay('Walking the graph…');
  try { setData(await window.sq.kg.ego(name, Number(hopsEl.value)), 'ego'); } catch (e) { setOverlay(String(e.message || e), 'fail'); }
}

// fuzzy search dropdown
let st, hits = [], activeIdx = 0;
function renderDropdown() {
  if (!hits.length) { ddEl.hidden = true; return; }
  ddEl.hidden = false;
  ddEl.innerHTML = hits.map((h, i) => `<div class="hit${i === activeIdx ? ' on' : ''}" data-i="${i}"><span class="swatch" style="background:${h.color || '#7dd3fc'}"></span><span class="nm">${esc(h.name)}</span><span class="ty">${esc(h.entity_type)}</span></div>`).join('');
  ddEl.querySelectorAll('.hit').forEach(el => el.addEventListener('mousedown', (e) => { e.preventDefault(); focus(hits[Number(el.dataset.i)].name); }));
}
qEl.addEventListener('input', () => {
  clearTimeout(st);
  const v = qEl.value.trim();
  if (v.length < 2) { hits = []; ddEl.hidden = true; return; }
  st = setTimeout(async () => {
    try { const r = await window.sq.kg.search(v); hits = (r && r.hits) || []; activeIdx = 0; renderDropdown(); } catch (e) { hits = []; ddEl.hidden = true; }
  }, 180);
});
qEl.addEventListener('keydown', (e) => {
  if (ddEl.hidden || !hits.length) { if (e.key === 'Enter' && qEl.value.trim()) focus(qEl.value.trim()); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(hits.length - 1, activeIdx + 1); renderDropdown(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); renderDropdown(); }
  else if (e.key === 'Enter') { e.preventDefault(); hits[activeIdx] ? focus(hits[activeIdx].name) : focus(qEl.value.trim()); }
  else if (e.key === 'Escape') ddEl.hidden = true;
});
document.addEventListener('mousedown', (e) => { if (!qEl.parentElement.contains(e.target)) ddEl.hidden = true; });
hopsEl.addEventListener('change', () => { if (mode === 'ego' && submitted) focus(submitted); });
backBtn.addEventListener('click', () => { qEl.value = ''; loadOverview(); });

// --- LIVE-FOLLOW the idle graph-walk -----------------------------------------
// When ON, the panel re-centers the ego view on each entity the idle graph-builder enriches, so you can
// watch it walk your neighborhood (Brad Overcash → Janet Cowell → …). The "now" label ticks on every
// move even when follow is OFF, so the panel always shows what she's working. main broadcasts kg:focus-move.
let follow = false, lastMove = null;
function renderNow() {
  if (!lastMove) { nowLbl.hidden = true; return; }
  nowLbl.hidden = false;
  nowLbl.innerHTML = `<span class="dot"></span>now: <span>${esc(lastMove.anchor)}</span>${lastMove.source ? `<span class="src">${esc(lastMove.source)}</span>` : ''}`;
}
function setFollow(on) {
  follow = !!on;
  followBtn.classList.toggle('on', follow);
  followBtn.innerHTML = follow ? 'Following &#9209;' : 'Follow &#9654;';   // ⏹ when active, ▶ when idle
  try { localStorage.setItem('kg.follow', follow ? '1' : '0'); } catch (e) {}
  // turning follow ON snaps straight to the last known anchor so there's no wait for the next move
  if (follow && lastMove && lastMove.anchor && lastMove.anchor !== submitted) focus(lastMove.anchor);
}
function onFocusMove(p) {
  if (!p || !p.anchor) return;
  lastMove = p; renderNow();
  if (follow && p.anchor !== submitted) focus(p.anchor);   // re-center the ego walk on her current node
}
followBtn.addEventListener('click', () => setFollow(!follow));
try {
  if (window.sq && window.sq.kg && typeof window.sq.kg.onFocusMove === 'function') window.sq.kg.onFocusMove(onFocusMove);
  else followBtn.disabled = true;   // older host without the live channel → toggle inert
} catch (e) { followBtn.disabled = true; }
try { if (localStorage.getItem('kg.follow') === '1') setFollow(true); } catch (e) {}

loadOverview();
