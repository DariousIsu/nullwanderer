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
let mode = 'overview', submitted = '', submittedQuery = '';
// --- activity-pulse state: the far-field flares on each landed batch, magnitude set per tier (below) ---
let focalId = null, pulseAt = 0, pulseMag = 1.4;
const linkEnd = (x) => (x && typeof x === 'object') ? x.id : x;

// color helpers for the lit-node / atmosphere rendering (entity colors are hex; fallbacks are hex too)
function hexToRgb(h) { h = String(h || '').replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbaHex(h, a) { const [r, g, b] = hexToRgb(h); return `rgba(${r},${g},${b},${a})`; }
function lighten(h, t) { const [r, g, b] = hexToRgb(h); const m = (v) => Math.round(v + (255 - v) * t); return `rgb(${m(r)},${m(g)},${m(b)})`; }

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function setOverlay(text, cls) { if (!text) { overlay.hidden = true; return; } overlay.hidden = false; overlay.className = 'overlay' + (cls ? ' ' + cls : ''); overlay.textContent = text; }

// Drawn node radius (graph units). Shared by the canvas draw, the label anchor, and the collision
// force so physics spacing matches what's painted.
function nodeRadius(n) {
  if (n.isFocal) return 7;
  if (n.overviewSource && n.degree !== undefined) return Math.max(4, Math.min(10, 4 + Math.log10((n.degree || 0) + 1) * 1.5));
  return 4;
}

// Minimal collision force (d3-force compatible: fn + .initialize) — the bundled force-graph doesn't
// expose d3.forceCollide, so we roll a light grid-based one to stop node disks from stacking into the
// tight overlapping balls seen at overview scale. Grid keeps it ~linear on big corpora.
function makeCollide(radiusFn, strength = 0.8) {
  let nodes = [];
  function force() {
    const n = nodes.length; if (!n) return;
    const r = new Array(n); let maxR = 1;
    for (let i = 0; i < n; i++) { r[i] = radiusFn(nodes[i]); if (r[i] > maxR) maxR = r[i]; }
    const cell = maxR * 2, grid = new Map(), key = (x, y) => x + ',' + y;
    for (let i = 0; i < n; i++) { const k = key(Math.floor(nodes[i].x / cell), Math.floor(nodes[i].y / cell)); (grid.get(k) || grid.set(k, []).get(k)).push(i); }
    for (let i = 0; i < n; i++) {
      const a = nodes[i], cx = Math.floor(a.x / cell), cy = Math.floor(a.y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(key(gx, gy)); if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue; const b = nodes[j];
          let dx = (b.x + (b.vx || 0)) - (a.x + (a.vx || 0)), dy = (b.y + (b.vy || 0)) - (a.y + (a.vy || 0));
          const d2 = dx * dx + dy * dy, min = r[i] + r[j];
          if (d2 < min * min && d2 > 1e-6) { const d = Math.sqrt(d2), f = (min - d) / d * strength; dx *= f; dy *= f; a.vx -= dx; a.vy -= dy; b.vx += dx; b.vy += dy; }
        }
      }
    }
  }
  force.initialize = (n) => { nodes = n; };
  return force;
}

const prefersReducedMotion = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } })();

// Far-field: a faint SEEDED web of distant specks behind the focused graph, so the ~40-node view reads as a
// small bright island inside the vast interconnected corpus (~1.7M entities / 8.5M relations) rather than a
// few disembodied systems in a void. Impressionistic scale, not specific entities. It's a MESH (specks +
// nearest-neighbour links) because the corpus's whole point is interconnection. Dense enough to feel like a
// galaxy, faint enough to stay background. Geometry precomputed once (seeded → stable).
let _farField = null;
function farField() {
  if (_farField) return _farField;
  let s = 0x9e3779b9;                                   // seeded LCG → identical field every frame
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const TINT = ['148,163,184', '20,184,166', '34,197,94', '168,85,247', '245,158,11'];   // slate/teal/green/violet/amber
  // depth-banded specks: z in [0,1] (0 = deep/far, 1 = near) drives size, brightness, drift + zoom spread,
  // so the bands parallax at different rates → depth is *felt*, not just decorated.
  const N = 340, pts = [];
  for (let i = 0; i < N; i++) { const z = rnd(); pts.push({ x: rnd(), y: rnd(), z, r: 0.3 + z * 1.5, b: 0.035 + z * 0.12, t: TINT[(rnd() * TINT.length) | 0] }); }
  const edges = [];
  for (let i = 0; i < N; i++) {                          // connect each speck to its 1–2 nearest → a net, not stars
    let n1 = -1, n2 = -1, d1 = 1e9, d2 = 1e9;
    for (let j = 0; j < N; j++) { if (j === i) continue; const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, d = dx * dx + dy * dy; if (d < d1) { d2 = d1; n2 = n1; d1 = d; n1 = j; } else if (d < d2) { d2 = d; n2 = j; } }
    if (n1 > i) edges.push([i, n1]); if (n2 > i) edges.push([i, n2]);
  }
  // nebula: a few big soft colour clouds so the galaxy has structure + hue, not a uniform void. Deepest layer.
  const CLOUD_HUE = ['20,184,166', '34,197,94', '168,85,247', '96,165,250', '148,163,184'];
  const clouds = [];
  for (let i = 0; i < 6; i++) clouds.push({ x: rnd(), y: rnd(), r: 0.4 + rnd() * 0.5, a: 0.028 + rnd() * 0.032, t: CLOUD_HUE[i % CLOUD_HUE.length], depth: 0.12 + rnd() * 0.3, ph: rnd() * 6.28 });
  _farField = { pts, edges, clouds };
  return _farField;
}
function drawFarField(ctx, w, h) {
  const F = farField(), t = prefersReducedMotion ? 0 : performance.now() / 1000;
  let zoom = 1; try { zoom = (G && G.zoom) ? G.zoom() : 1; } catch (e) {}
  let boost = 1; if (pulseAt) { const el = performance.now() - pulseAt; if (el >= 0 && el < 1600) boost = 1 + (1 - el / 1600) * pulseMag; }   // field flares when a batch lands (magnitude per tier)
  const cx = w / 2, cy = h / 2;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  // 1) nebula clouds (deepest layer) — big soft colour, slow drift scaled by their depth
  for (const c of F.clouds) {
    const nx = cx + (c.x - 0.5) * w * 1.1 + Math.sin(t * 0.03 + c.ph) * 26 * c.depth;
    const ny = cy + (c.y - 0.5) * h * 1.1 + Math.cos(t * 0.025 + c.ph) * 20 * c.depth;
    const rad = c.r * Math.min(w, h);
    const g = ctx.createRadialGradient(nx, ny, 0, nx, ny, rad);
    g.addColorStop(0, `rgba(${c.t},${Math.min(0.11, c.a * boost)})`); g.addColorStop(1, `rgba(${c.t},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(nx, ny, rad, 0, 2 * Math.PI, false); ctx.fill();
  }
  // 2) mesh + specks, depth-parallaxed: near band (high z) drifts + spreads more than the far band
  const spread = (z) => 0.8 + zoom * (0.07 + z * 0.16);
  const dxOf = (z) => Math.sin(t * 0.05) * (5 + z * 22), dyOf = (z) => Math.cos(t * 0.04) * (4 + z * 16);
  const X = p => cx + (p.x - 0.5) * w * spread(p.z) + dxOf(p.z), Y = p => cy + (p.y - 0.5) * h * spread(p.z) + dyOf(p.z);
  ctx.lineWidth = 0.6;
  for (const [a, b] of F.edges) { const pa = F.pts[a], pb = F.pts[b]; ctx.strokeStyle = `rgba(${pa.t},${0.04 * boost})`; ctx.beginPath(); ctx.moveTo(X(pa), Y(pa)); ctx.lineTo(X(pb), Y(pb)); ctx.stroke(); }
  for (const p of F.pts) { ctx.beginPath(); ctx.arc(X(p), Y(p), p.r, 0, 2 * Math.PI, false); ctx.fillStyle = `rgba(${p.t},${Math.min(0.4, p.b * boost)})`; ctx.fill(); }
  // 3) connect shockwave — a faint ring expanding into the cosmos. Gated to bigger events (growth/clean,
  //    mag ≥ 1.2) so the frequent ambient curation tier never fires it.
  if (pulseAt && pulseMag >= 1.2 && !prefersReducedMotion) {
    const el = performance.now() - pulseAt;
    if (el >= 0 && el < 1600) { const p = el / 1600, rad = 20 + p * Math.max(w, h) * 0.6; ctx.strokeStyle = `rgba(251,191,36,${(1 - p) * Math.min(0.34, 0.18 * pulseMag)})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 2 * Math.PI, false); ctx.stroke(); }
  }
  ctx.restore();
}

// Atmosphere pass (onRenderFramePre → drawn under links/nodes): a screen-space vignette (subtle centre
// lift, darker rim) turns the flat void into space, a far-field cosmos implies the corpus continuing beyond
// the frame, and a soft graph-space colour bloom behind the focal node steers the eye to the active spot.
function drawAtmosphere(ctx, scale) {
  const cv = ctx && ctx.canvas; if (!cv) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);   // vignette is screen-anchored → draw in device pixels
  const w = cv.width, h = cv.height;
  const vg = ctx.createRadialGradient(w * 0.5, h * 0.42, 0, w * 0.5, h * 0.42, Math.max(w, h) * 0.72);
  vg.addColorStop(0, 'rgba(26,28,38,0.45)'); vg.addColorStop(0.55, 'rgba(10,11,16,0)'); vg.addColorStop(1, 'rgba(3,4,6,0.6)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
  ctx.restore();
  drawFarField(ctx, w, h);   // the vast corpus behind the focused island
  if (!G) return;
  const nodes = (G.graphData().nodes) || [];
  let target = nodes.find(n => n.isFocal);
  if (!target) { for (const n of nodes) if (!target || (n.degree || 0) > (target.degree || 0)) target = n; }   // richest hub in overview
  if (target && target.x != null) {
    const col = target.color || '#FBBF24', rad = 72;
    const bg = ctx.createRadialGradient(target.x, target.y, 0, target.x, target.y, rad);
    bg.addColorStop(0, rgbaHex(col, 0.12)); bg.addColorStop(1, rgbaHex(col, 0));
    ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(target.x, target.y, rad, 0, 2 * Math.PI, false); ctx.fill();
  }
}

function ensureGraph() {
  if (G) return G;
  G = ForceGraph()(graphEl)
    .nodeId('id').backgroundColor('#0a0b0e')
    .cooldownTicks(120).d3VelocityDecay(0.3)
    .linkColor(l => l.color).linkWidth(l => l.width)
    // A same-category glow drawn OVER the default line ('after' → force-graph keeps native arrows + the
    // directional/emitted particles that drive the connection-ripple). Category still owns COLOUR + WIDTH
    // (legend stays valid) — we only add presence against the dark ground.
    .linkCanvasObjectMode(() => 'after')
    .linkCanvasObject((l, ctx, scale) => {
      const s = l.source, t = l.target;
      if (!s || !t || s.x == null || t.x == null) return;
      const base = l.color || 'rgba(148,163,184,0.5)', w = Math.max(0.7, (l.width || 0.6) * 1.4);
      ctx.save();
      ctx.shadowColor = base; ctx.shadowBlur = 3;
      ctx.strokeStyle = base; ctx.lineWidth = w; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
      ctx.restore();
    })
    .linkDirectionalArrowLength(3).linkDirectionalArrowRelPos(1)
    // COSMETIC (demo): animate ONLY the current focal node's edges — a light amber shimmer so the panel
    // looks alive on whatever the subconscious is working. 0 particles elsewhere (overview stays static →
    // perf-safe). Keeps the canvas render loop ticking in follow mode, which also drives the pulse ring.
    .linkDirectionalParticles(l => (focalId && (linkEnd(l.source) === focalId || linkEnd(l.target) === focalId)) ? 2 : 0)
    .linkDirectionalParticleSpeed(0.011).linkDirectionalParticleWidth(2).linkDirectionalParticleColor(() => 'rgba(251,191,36,0.9)')
    .linkLabel(l => `${l.relType} (${l.category})`)
    .onNodeHover(n => { hovered = n || null; renderHover(); if (G) G.nodeColor(G.nodeColor()); })
    .onNodeClick(n => { if (n && !n.isFocal) focus(n.id); })
    .nodePointerAreaPaint((n, color, ctx) => { ctx.beginPath(); ctx.arc(n.x, n.y, n.isFocal ? 10 : 8, 0, 2 * Math.PI, false); ctx.fillStyle = color; ctx.fill(); })
    .nodeCanvasObject((n, ctx, scale) => {
      const r = nodeRadius(n), col = n.color || '#7dd3fc';
      // lit node: a soft same-hue glow (scales with radius → hubs shine brighter) makes the disk read as a
      // lit object, then a radial gradient (light core → saturated rim) gives it depth instead of a flat fill.
      ctx.save();
      ctx.shadowColor = rgbaHex(col, 0.85); ctx.shadowBlur = r;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI, false); ctx.fillStyle = col; ctx.fill();
      ctx.restore();
      const grad = ctx.createRadialGradient(n.x - r * 0.35, n.y - r * 0.4, r * 0.12, n.x, n.y, r);
      grad.addColorStop(0, lighten(col, 0.55)); grad.addColorStop(0.55, col); grad.addColorStop(1, rgbaHex(col, 0.92));
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI, false); ctx.fillStyle = grad; ctx.fill();
      // subtle rim for definition against the glow
      ctx.lineWidth = 1 / scale; ctx.strokeStyle = 'rgba(0,0,0,0.38)'; ctx.stroke();
      if (n.isFocal) { ctx.lineWidth = 2 / scale; ctx.strokeStyle = '#FBBF24'; ctx.stroke(); }
      // COSMETIC (demo): an expanding amber ring on the focal node for ~1.4s after each move — reads as
      // "new activity landed here". Time-based off pulseAt; the edge particles keep frames coming so it draws.
      if (n.isFocal && pulseAt) { const dt = performance.now() - pulseAt; if (dt >= 0 && dt < 1400) { const p = dt / 1400; ctx.beginPath(); ctx.arc(n.x, n.y, r + 3 + p * 22, 0, 2 * Math.PI, false); ctx.strokeStyle = `rgba(251,191,36,${(1 - p) * 0.7})`; ctx.lineWidth = 2 / scale; ctx.stroke(); } }
      if (n.overviewSource === 'recent' || n.overviewSource === 'both') { ctx.beginPath(); ctx.arc(n.x, n.y, r + 2, 0, 2 * Math.PI, false); ctx.setLineDash([2, 2]); ctx.lineWidth = 1.2 / scale; ctx.strokeStyle = '#FBBF24'; ctx.stroke(); ctx.setLineDash([]); }
      if (hovered && hovered.id === n.id) { ctx.beginPath(); ctx.arc(n.x, n.y, r * 1.8, 0, 2 * Math.PI, false); ctx.strokeStyle = 'rgba(125,211,252,0.85)'; ctx.lineWidth = 1.5 / scale; ctx.stroke(); }
      n.__r = r;   // stash for the label pass (onRenderFramePost draws labels so it can rank + de-collide)
    })
    // Labels are drawn in ONE post pass (not per-node) so we control z-order: focal/hovered/neighbors
    // first, then by prominence, each skipped if its box would overlap an already-placed label. Kills the
    // pile-up seen at overview scale where every node stamped its text on top of the others.
    .onRenderFramePre(drawAtmosphere)
    .onRenderFramePost(drawLabels);
  // Force tuning: spread clusters and stop node disks stacking. Stronger bounded charge repels nodes
  // without yanking distant clusters into one thread (distanceMax caps the pull range); softer, longer
  // links give the graph room; the custom collide keeps disks off each other.
  try {
    const charge = G.d3Force('charge'); if (charge && charge.strength) charge.strength(-150).distanceMax(700);
    const link = G.d3Force('link'); if (link && link.distance) link.distance(l => 36 + (l.category === 'generic' ? 12 : 0)).strength(0.32);
    G.d3Force('collide', makeCollide(n => nodeRadius(n) + 3));
  } catch (e) {}
  const fit = () => { const w = graphEl.clientWidth, h = graphEl.clientHeight; G.width(w).height(h); };
  fit(); new ResizeObserver(fit).observe(graphEl);
  return G;
}

// --- label pass -------------------------------------------------------------
// Adjacency + degree, rebuilt only when the links array identity changes (cheap; graphs here are
// bounded). Degree drives label priority in ego mode where nodes carry no precomputed `degree`.
let _adjLinks = null, _adj = new Map(), _deg = new Map();
function ensureAdjacency(links) {
  if (links === _adjLinks) return;
  _adjLinks = links; _adj = new Map(); _deg = new Map();
  for (const l of links) {
    const a = linkEnd(l.source), b = linkEnd(l.target);
    if (a == null || b == null) continue;
    if (!_adj.has(a)) _adj.set(a, new Set()); if (!_adj.has(b)) _adj.set(b, new Set());
    _adj.get(a).add(b); _adj.get(b).add(a);
    _deg.set(a, (_deg.get(a) || 0) + 1); _deg.set(b, (_deg.get(b) || 0) + 1);
  }
}
function roundRectPath(ctx, x, y, w, h, rad) {
  const r = Math.min(rad, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// Priority order for label placement (higher = placed first, wins collisions):
// focal ≫ hovered ≫ hovered's neighbors ≫ node degree. Neighbors keep a hovered node's context legible.
function labelPriority(n, hovId, neigh) {
  if (n.isFocal) return 1e9;
  if (hovId && n.id === hovId) return 1e8;
  if (neigh && neigh.has(n.id)) return 1e7;
  return (n.degree != null ? n.degree : (_deg.get(n.id) || 0));
}

function drawLabels(ctx, scale) {
  if (!G) return;
  const data = G.graphData(); const nodes = data.nodes;
  if (!nodes || !nodes.length) return;
  ensureAdjacency(data.links || []);
  const hovId = hovered ? hovered.id : null;
  const neigh = hovId ? _adj.get(hovId) : null;

  const fs = Math.max(9, 11 / Math.sqrt(scale));   // font size in graph units (constant-ish on screen)
  const padX = 4 / scale, padY = 2.5 / scale, gap = 2 / scale;
  ctx.font = `${fs}px -apple-system, "Segoe UI", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';

  // Below this on-screen zoom, only the strongest labels (focal/hovered/neighbors + top hubs) show,
  // so a zoomed-out overview stays a clean constellation instead of a wall of text.
  const zoomGate = scale < 0.55 ? 3 : (scale < 1.1 ? 1 : 0);

  const ranked = nodes
    .filter(n => n.x != null && n.y != null)
    .map(n => ({ n, p: labelPriority(n, hovId, neigh) }))
    .sort((a, b) => b.p - a.p);

  const placed = [];   // graph-space boxes {x0,y0,x1,y1}
  const overlaps = (b) => placed.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
  let count = 0;
  for (const { n, p } of ranked) {
    if (count > 70) break;                          // no point drawing more than a screenful
    const forced = p >= 1e7;                         // focal / hovered / neighbor — always attempt
    if (!forced && p < zoomGate) continue;           // prominence gate at low zoom
    const label = n.id.length > 34 ? n.id.slice(0, 34) + '…' : n.id;
    const w = ctx.measureText(label).width;
    const r = n.__r || 4;
    const bx0 = n.x - w / 2 - padX, bx1 = n.x + w / 2 + padX;
    const by0 = n.y + r + gap, by1 = by0 + fs + padY * 2;
    const box = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    if (!forced && overlaps(box)) continue;          // skip low-priority labels that would collide
    placed.push(box); count++;
    const focal = n.isFocal, hov = hovId && n.id === hovId;
    // halo plate for legibility over edges + neighbors; brighter for focal/hovered
    roundRectPath(ctx, bx0, by0, bx1 - bx0, by1 - by0, 3 / scale);
    ctx.fillStyle = focal || hov ? 'rgba(12,13,17,0.9)' : 'rgba(10,11,14,0.72)';
    ctx.fill();
    ctx.fillStyle = focal ? '#FBBF24' : hov ? '#E8E8EB' : (neigh && neigh.has(n.id)) ? '#CBD5E1' : '#9AA3B2';
    ctx.fillText(label, n.x, by0 + padY);
  }
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
  focalId = (full.nodes.find(n => n.isFocal) || {}).id || null;   // drives the edge-shimmer + pulse target
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
// focus(displayName, opt): query_graph is name-based and needs the EXACT stored name (with its "[…]" tag),
// but we show the clean name. opt.query = the exact name to walk (defaults to displayName). opt.soft = a
// follow auto-recenter: if it misses, keep the current graph instead of blanking (a dead panel mid-demo).
async function focus(name, opt = {}) {
  const queryName = opt.query || name;
  submitted = name; submittedQuery = queryName; qEl.value = name; ddEl.hidden = true; setOverlay('Walking the graph…');
  try {
    const res = await window.sq.kg.ego(queryName, Number(hopsEl.value));
    if (opt.soft && res && (!res.ok || res.error) && full.nodes.length) { setOverlay(null); return; }  // keep the working view
    setData(res, 'ego');
  } catch (e) { if (!opt.soft || !full.nodes.length) setOverlay(String(e.message || e), 'fail'); }
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
hopsEl.addEventListener('change', () => { if (mode === 'ego' && submitted) focus(submitted, { query: submittedQuery }); });
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
// --- tiered activity pulses (the "metabolism") ------------------------------
// The graph self-curates on THREE tempos, and intensity is INVERSE to frequency so the panel stays a calm
// ambient companion instead of a strobe: frequent programmatic curation (connect/merge/dedup) is a whisper,
// hourly growth blasts are a noticeable swell, the daily cleaning sweep is the showpiece. Batches are
// COALESCED — N events fold into ONE gesture scaled by log(N) — so a chatty programmatic pass never seizures.
const TIER = {
  growth:   { mag: 1.6, ring: 0.9, coalesceMs: 140 },   // hourly — a swell you'd catch at a glance
  curation: { mag: 0.7, ring: 0.0, coalesceMs: 850 },   // frequent — ambient, never demands attention
  clean:    { mag: 2.3, ring: 1.0, coalesceMs: 200 },   // daily — the cinematic sweep
};
let intensity = (() => { try { return localStorage.getItem('kg.intensity') || 'lively'; } catch (e) { return 'lively'; } })();
const INTENSITY_MUL = { off: 0, calm: 0.5, lively: 1 };

// coalescing: same-tier events inside the tier's window fold together; a different tier flushes first.
let _coal = null, _coalTimer = 0;
function ingestPulse(evt) {
  if (!evt) return;
  const tier = TIER[evt.tier] ? evt.tier : 'growth';
  if (_coal && _coal.tier !== tier) flushPulse();
  if (!_coal) _coal = { tier, count: 0, items: [], anchor: null };
  _coal.count += (evt.count || 1);
  if (evt.items && evt.items.length) _coal.items.push(...evt.items);
  if (evt.anchor) _coal.anchor = evt.anchor;
  clearTimeout(_coalTimer); _coalTimer = setTimeout(flushPulse, TIER[tier].coalesceMs);
}
function flushPulse() {
  const c = _coal; _coal = null; clearTimeout(_coalTimer);
  if (!c) return;
  const mul = INTENSITY_MUL[intensity] != null ? INTENSITY_MUL[intensity] : 1;
  if (mul <= 0) return;                                   // intensity: off
  const t = TIER[c.tier], size = Math.min(2.4, 1 + Math.log10((c.count || 1) + 1) * 0.9);   // batch size → intensity
  pulse({ mag: t.mag * size * mul, ring: t.ring * mul });
  // c.items[] (in-view (source,target) pairs) will drive local light-threads in the next slice.
}

// Fire one pulse: flare the far-field (mag) and optionally ripple a light-wave outward across the visible
// web (ring). Generalised from the old focal-only pulse so every tier routes through a single gesture.
function pulse({ mag = 1.6, ring = 1 } = {}) {
  pulseAt = performance.now(); pulseMag = mag;
  if (ring <= 0 || prefersReducedMotion || !G || !focalId) return;
  try {
    const links = G.graphData().links || [];
    const adj = new Map();
    for (const l of links) { const a = linkEnd(l.source), b = linkEnd(l.target); if (a == null || b == null) continue; (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a); }
    const dist = new Map([[focalId, 0]]), q = [focalId];
    while (q.length) { const u = q.shift(); for (const v of (adj.get(u) || [])) if (!dist.has(v)) { dist.set(v, dist.get(u) + 1); q.push(v); } }
    // emit a particle on every reachable link, staggered by hop level → a wave rippling OUTWARD; cap by ring.
    let emitted = 0; const cap = Math.round(120 * ring);
    for (const l of links) {
      const lvl = Math.min(dist.has(linkEnd(l.source)) ? dist.get(linkEnd(l.source)) : 99, dist.has(linkEnd(l.target)) ? dist.get(linkEnd(l.target)) : 99);
      if (lvl >= 99 || emitted > cap) continue;
      emitted++;
      setTimeout(() => { try { G.emitParticle(l); } catch (e) {} }, lvl * 150 + Math.random() * 70);
    }
  } catch (e) {}
}
function onFocusMove(p) {
  if (!p || !p.anchor) return;
  lastMove = p; renderNow();
  // growth tier: re-center on the exact node, then pulse (coalesced through the metabolism core)
  if (follow && p.anchor !== submitted) focus(p.anchor, { query: p.canonical || p.anchor, soft: true }).then(() => ingestPulse({ tier: 'growth', anchor: p.anchor, count: 1 })).catch(() => {});
}
// curation metabolism: frequent programmatic curation + the daily clean sweep arrive here. Inert until the
// host emits kg:curation-move — same graceful-degrade pattern as follow. Payload {tier, kind, count, items?}.
function onCurationMove(p) { ingestPulse(p); }
followBtn.addEventListener('click', () => setFollow(!follow));
try {
  if (window.sq && window.sq.kg && typeof window.sq.kg.onFocusMove === 'function') window.sq.kg.onFocusMove(onFocusMove);
  else followBtn.disabled = true;   // older host without the live channel → toggle inert
} catch (e) { followBtn.disabled = true; }
try { if (window.sq && window.sq.kg && typeof window.sq.kg.onCurationMove === 'function') window.sq.kg.onCurationMove(onCurationMove); } catch (e) {}
try { if (localStorage.getItem('kg.follow') === '1') setFollow(true); } catch (e) {}

loadOverview();
