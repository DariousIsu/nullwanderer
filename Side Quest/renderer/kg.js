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

// Persistent "world" for follow/ego mode: each ego walk MERGES into this store (keyed by id) instead of
// replacing the graph, so shared nodes keep their positions and the panel feels like flying through ONE
// galaxy rather than regrowing every move. Capped with an LRU trail — nodes you've moved away from fade
// out at the periphery. Node objects are reused by reference so d3-force preserves x/y across updates.
const world = { nodes: new Map(), links: new Map() };
const WORLD_CAP = 320;
// degree bridge: ego nodes lack real degree until main's db_query enrichment reboots. Capture degrees from
// ANY node that carries them (the overview hubs loaded at startup, or enriched ego) so the tendrils can show
// on those hubs in Follow mode right now, not only after a reboot.
const degreeHint = new Map();
// SHORT-TERM LAYER (the two-source galaxy): Side Quest's own store (graph_entities + recent docs) rendered
// AS ITS OWN layer, merged into every render alongside the Echo corpus. Tagged store:'sidequest' + epistemic;
// styled as a brighter, denser, epistemic-coloured CORE, pulled to centre by makeCoreForce. Cross-store links
// (short-term ↔ Echo, via name_key↔name) draw as bright federation threads. Node objects reused → d3 keeps x/y.
const shortTerm = { nodes: new Map(), links: new Map() };
const linkEnd = (x) => (x && typeof x === 'object') ? x.id : x;

// color helpers for the lit-node / atmosphere rendering (entity colors are hex; fallbacks are hex too)
function hexToRgb(h) { h = String(h || '').replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbaHex(h, a) { const [r, g, b] = hexToRgb(h); return `rgba(${r},${g},${b},${a})`; }
function lighten(h, t) { const [r, g, b] = hexToRgb(h); const m = (v) => Math.round(v + (255 - v) * t); return `rgb(${m(r)},${m(g)},${m(b)})`; }
// Stable per-identity seed in [0,1) (FNV-1a) — freezes a node's tendril arbor to WHO it is, not WHERE it is,
// so the reach never shimmers with residual physics micro-motion the way a live-position seed does.
function hashSeed(id) { let h = 2166136261; const s = String(id); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }

// The render-hook try/catch must keep swallowing (a per-frame throw must never kill the always-live loop —
// that's the black-canvas guard). But a SILENT swallow once hid a tendril-killing ReferenceError for a whole
// build. warnOnce surfaces the FIRST throw per site to the console without spamming — silent-failure, ended.
const _warned = new Set();
function warnOnce(where, e) { if (_warned.has(where)) return; _warned.add(where); try { console.warn(`[kg] render throw in ${where} (loop kept alive):`, e && e.message || e); } catch (_) {} }
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

// Core force: gently pull short-term (store:'sidequest') nodes toward the graph's centre-of-mass so they
// gather as the dense bright CORE, while the Echo corpus spreads around them via charge. d3-compatible
// (fn + .initialize); alpha-scaled so it relaxes as the sim cools. Placement is tunable (strength) — this is
// the "short-term in the middle, long-term around" spatial model, adjustable once we see both on screen.
function makeCoreForce(strength = 0.06) {
  let nodes = [];
  function force(alpha) {
    let cx = 0, cy = 0, c = 0;
    for (const n of nodes) if (Number.isFinite(n.x)) { cx += n.x; cy += n.y; c++; }
    if (!c) return; cx /= c; cy /= c;
    for (const n of nodes) if (n.store === 'sidequest' && Number.isFinite(n.x)) { n.vx = (n.vx || 0) + (cx - n.x) * strength * alpha; n.vy = (n.vy || 0) + (cy - n.y) * strength * alpha; }
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
  const N = 460, pts = [];
  // CENTER-WEIGHTED radial distribution: densest where the graph sits (centre) and thinning outward, so the
  // near field, tendrils and far field read as ONE continuous galaxy with a falloff — not three layers + gaps.
  for (let i = 0; i < N; i++) { const z = rnd(), ang = rnd() * 6.283, rad = Math.pow(rnd(), 1.7) * 0.72; pts.push({ x: 0.5 + Math.cos(ang) * rad, y: 0.5 + Math.sin(ang) * rad, z, r: 0.3 + z * 1.5, b: 0.04 + z * 0.13, t: TINT[(rnd() * TINT.length) | 0] }); }
  const edges = [];
  for (let i = 0; i < N; i++) {                          // connect each speck to its 1–2 nearest → a net, not stars
    let n1 = -1, n2 = -1, d1 = 1e9, d2 = 1e9;
    for (let j = 0; j < N; j++) { if (j === i) continue; const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, d = dx * dx + dy * dy; if (d < d1) { d2 = d1; n2 = n1; d1 = d; n1 = j; } else if (d < d2) { d2 = d; n2 = j; } }
    if (n1 > i) edges.push([i, n1]); if (n2 > i) edges.push([i, n2]);
  }
  _farField = { pts, edges };   // clouds removed — the galactic-core glow (drawFarField) replaced them
  return _farField;
}
function drawFarField(ctx, w, h) {
  const F = farField(), t = prefersReducedMotion ? 0 : performance.now() / 1000;
  let zoom = 1; try { zoom = (G && G.zoom) ? G.zoom() : 1; } catch (e) {}
  let boost = 1; if (pulseAt) { const el = performance.now() - pulseAt; if (el >= 0 && el < 1600) boost = 1 + (1 - el / 1600) * pulseMag; }   // field flares when a batch lands (magnitude per tier)
  // Anchor the far-field to the graph's OWN centre-of-mass (projected to screen), not the static screen
  // middle — otherwise the cluster slides over a fixed backdrop and reads as "floating above" it. Projecting
  // the centroid through the live pan/zoom makes the core glow + specks travel WITH the island, so panning
  // and zooming feel like moving through the surrounding cosmos rather than across a painted curtain.
  let cx = w / 2, cy = h / 2;
  try {
    if (G && G.graph2ScreenCoords) {
      const nn = (G.graphData().nodes) || [];
      let sx = 0, sy = 0, c = 0;
      for (const n of nn) if (Number.isFinite(n.x) && Number.isFinite(n.y)) { sx += n.x; sy += n.y; c++; }
      if (c) {
        const p = G.graph2ScreenCoords(sx / c, sy / c);          // CSS px relative to canvas
        const cv = ctx.canvas, ratio = cv.clientWidth ? cv.width / cv.clientWidth : 1;   // → device px
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) { cx = p.x * ratio; cy = p.y * ratio; }
      }
    }
  } catch (e) {}
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  // 1) galactic-core glow (replaces discrete clouds): the graph sits in a luminous core that fades to dark
  //    edges, bridging near field ↔ far field into one continuous space instead of a graph floating in a gap.
  const coreR = Math.max(w, h) * 0.62;
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  core.addColorStop(0, `rgba(38,50,74,${0.13 * boost})`); core.addColorStop(0.45, `rgba(22,29,46,${0.055 * boost})`); core.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = core; ctx.fillRect(0, 0, w, h);
  // 2) mesh + specks, depth-parallaxed: near band (high z) drifts + spreads more than the far band
  const spread = (z) => 0.8 + zoom * (0.07 + z * 0.16);
  const dxOf = (z) => Math.sin(t * 0.05) * (5 + z * 22), dyOf = (z) => Math.cos(t * 0.04) * (4 + z * 16);
  const X = p => cx + (p.x - 0.5) * w * spread(p.z) + dxOf(p.z), Y = p => cy + (p.y - 0.5) * h * spread(p.z) + dyOf(p.z);
  ctx.lineWidth = 0.6;
  for (const [a, b] of F.edges) { const pa = F.pts[a], pb = F.pts[b]; ctx.strokeStyle = `rgba(${pa.t},${0.075 * boost})`; ctx.beginPath(); ctx.moveTo(X(pa), Y(pa)); ctx.lineTo(X(pb), Y(pb)); ctx.stroke(); }
  for (const p of F.pts) { ctx.beginPath(); ctx.arc(X(p), Y(p), p.r, 0, 2 * Math.PI, false); ctx.fillStyle = `rgba(${p.t},${Math.min(0.72, p.b * 1.7 * boost)})`; ctx.fill(); }
  // 3) connect shockwave — a faint ring expanding into the cosmos. Gated to bigger events (growth/clean,
  //    mag ≥ 1.2) so the frequent ambient curation tier never fires it.
  if (pulseAt && pulseMag >= 1.2 && !prefersReducedMotion) {
    const el = performance.now() - pulseAt;
    if (el >= 0 && el < 1600) { const p = el / 1600, rad = 20 + p * Math.max(w, h) * 0.6; ctx.strokeStyle = `rgba(251,191,36,${(1 - p) * Math.min(0.34, 0.18 * pulseMag)})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 2 * Math.PI, false); ctx.stroke(); }
  }
  // 4) ACTIVITY WEATHER — off-screen data events flare in the far-field where they're happening, so the
  //    whole galaxy shimmers with distant activity (densest = busiest). In Follow you fly toward the weather.
  if (weather.length) {
    const now = performance.now();
    for (let i = weather.length - 1; i >= 0; i--) {
      const W = weather[i], p = (now - W.startAt) / W.dur;
      if (p >= 1) { weather.splice(i, 1); continue; }
      const fade = Math.sin(Math.min(1, p) * Math.PI), rad = 3 + p * 11 * (W.mag || 1);
      const g = ctx.createRadialGradient(W.x, W.y, 0, W.x, W.y, rad);
      g.addColorStop(0, `rgba(${W.col},${0.5 * fade})`); g.addColorStop(1, `rgba(${W.col},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(W.x, W.y, rad, 0, 2 * Math.PI, false); ctx.fill();
    }
  }
  ctx.restore();
}

// "Off into the universe" tendrils: for each node whose REAL degree (entities.degree) exceeds the edges we
// show, radiate faint threads into open space — count + length scaled by the HIDDEN connections (log). A
// shared office/concept hub (degree ~1779) fans threads deep into the dark; a genuine leaf stays bare. So a
// tiny near-field view still reads as plugged into a vast graph. Honest: needs node.degree (overview carries
// it; ego gets it from main's db_query enrichment). Drawn in graph space under the nodes, guarded for NaN.
function drawTendrils(ctx, scale) {
  if (!G) return;
  const data = G.graphData(); const nodes = data.nodes || [], links = data.links || [];
  const shown = new Map(), dir = new Map();   // per node: shown-edge count + summed neighbour direction
  let sumLen = 0, nLen = 0;
  for (const l of links) {
    const s = l.source, t = l.target;
    if (!s || !t || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
    shown.set(s.id, (shown.get(s.id) || 0) + 1); shown.set(t.id, (shown.get(t.id) || 0) + 1);
    const acc = (id, dx, dy) => { const a = dir.get(id) || { x: 0, y: 0 }; a.x += dx; a.y += dy; dir.set(id, a); };
    acc(s.id, t.x - s.x, t.y - s.y); acc(t.id, s.x - t.x, s.y - t.y);
    const dl = Math.hypot(t.x - s.x, t.y - s.y); if (dl > 0) { sumLen += dl; nLen++; }
  }
  const avgLen = nLen ? sumLen / nLen : 46;   // the layout's own node-spacing → tendrils reach "a region over"
  const now = performance.now(), tt = now / 1000;
  let fireBoost = 1; if (pulseAt) { const el = now - pulseAt; if (el >= 0 && el < 1600) fireBoost = 1 + (1 - el / 1600) * 1.4; }   // dendrites fire brighter just after a batch lands
  ctx.lineCap = 'round';
  // PERF: tendrils were the dominant per-frame cost (~2.4k createLinearGradient/frame in a 320-node follow
  // view → the skip-lag). Cap to the top-N nodes by HIDDEN degree — tendrils read as "hidden connections off
  // into the universe", which lands best on the biggest hubs; leaves don't need them. ~87% fewer gradients +
  // a cleaner look. (Focal always included so the followed node keeps its reach.)
  const TENDRIL_CAP = 40;
  const eligible = [];
  for (const n of nodes) {
    const real = (typeof n.degree === 'number') ? n.degree : degreeHint.get(n.id);
    if (!(real > 0) || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    const hidden = real - (shown.get(n.id) || 0);
    if (hidden < 1) continue;
    eligible.push({ n, hidden, focal: !!n.isFocal });
  }
  if (eligible.length > TENDRIL_CAP) { eligible.sort((a, b) => (b.focal - a.focal) || (b.hidden - a.hidden)); eligible.length = TENDRIL_CAP; }
  for (const { n, hidden } of eligible) {
    const r = n.__r || 4;
    const count = Math.min(5, Math.max(1, Math.round(Math.log2(hidden + 1))));
    const len = Math.max(r + 8, avgLen * (0.85 + Math.log10(hidden + 1) * 0.5));   // scale to spacing → tail toward where a further node sits, not a fixed stub
    const d = dir.get(n.id), hasEdges = d && (d.x || d.y);
    const baseA = hasEdges ? Math.atan2(-d.y, -d.x) : (n.__tseed != null ? n.__tseed : (n.__tseed = (n.x * 12.9 + n.y * 78.2) % 6.283));   // fan away from existing edges
    // Never a full 360° burst — that reads as a dandelion, not a neuron. Even an in-view leaf (no shown
    // edges) gets a narrow seeded spray in one direction, like dendrites reaching off one side of the soma.
    const arc = hasEdges ? 1.6 : 2.3;
    const col = n.color || '#7dd3fc', lit = lighten(col, 0.4);
    // Stable per-node seed (hashed from identity, once) so the arbor is FROZEN to the soma — tips move only
    // when the node moves, never a per-frame crawl. rr(i,k) = stable per-thread pseudo-randoms off that seed.
    // NOTE: i is passed IN (the arrow can't close over the loop's block-scoped i — doing so threw a swallowed
    // ReferenceError that silently killed the whole tendril pass; build 09l regression, fixed here).
    const sd = (n.__sd != null) ? n.__sd : (n.__sd = hashSeed(n.id));
    const rr = (ii, k) => { const v = Math.sin(sd * 127.1 + ii * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
    for (let i = 0; i < count; i++) {
      const z = rr(i, 1);                               // depth: 0 = near, 1 = far — drives length/fade/width/terminal
      const a = baseA + (count > 1 ? (i / (count - 1) - 0.5) : 0) * arc + (rr(i, 2) - 0.5) * 0.5, ca = Math.cos(a), sa = Math.sin(a);
      const tlen = len * (0.7 + z * 0.85);              // deeper threads reach FURTHER off toward their distant node
      const bx = n.x + ca * r, by = n.y + sa * r, ex = n.x + ca * tlen, ey = n.y + sa * tlen;
      const sign = (i % 2) ? 1 : -1, cvx = (bx + ex) / 2 - sa * tlen * 0.1 * sign, cvy = (by + ey) / 2 + ca * tlen * 0.1 * sign;   // gentle dendrite curve
      const bez = (p) => { const q = 1 - p; return [q * q * bx + 2 * q * p * cvx + p * p * ex, q * q * by + 2 * q * p * cvy + p * p * ey]; };
      const dfade = 1 - z * 0.5;                        // far threads dimmer + thinner → they recede into space
      ctx.lineWidth = Math.max(0.4, (1.0 - z * 0.5) / scale);
      const g = ctx.createLinearGradient(bx, by, ex, ey);
      g.addColorStop(0, rgbaHex(col, 0.5 * dfade)); g.addColorStop(0.75, rgbaHex(col, 0.1 * dfade)); g.addColorStop(1, rgbaHex(col, 0.04 * dfade));
      ctx.strokeStyle = g; ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo(cvx, cvy, ex, ey); ctx.stroke();
      // (2) dendritic branching — the bigger reaches fork near the tip into little dendrite trees
      if (hidden > 8 && i % 2 === 0) {
        const f = bez(0.72), blen = tlen * 0.3;
        for (let bs = -1; bs <= 1; bs += 2) {
          const ba = a + bs * 0.5, bex = f[0] + Math.cos(ba) * blen, bey = f[1] + Math.sin(ba) * blen;
          const bg = ctx.createLinearGradient(f[0], f[1], bex, bey); bg.addColorStop(0, rgbaHex(col, 0.22)); bg.addColorStop(1, rgbaHex(col, 0));
          ctx.strokeStyle = bg; ctx.beginPath(); ctx.moveTo(f[0], f[1]); ctx.lineTo(bex, bey); ctx.stroke();
          ctx.beginPath(); ctx.arc(bex, bey, 1.1, 0, 2 * Math.PI, false); ctx.fillStyle = rgbaHex(col, 0.16); ctx.fill();
        }
      }
      const seed = sd * 6.283 + i * 1.7;   // stable phase → the terminal sits still and only twinkles
      // (4) distant terminal node — the thread fades INTO a further, dimmer, smaller node (size + alpha scaled
      // by depth z), twinkling like a synaptic terminal. This recede is what reads as 3D instead of a loose tip.
      const tw = prefersReducedMotion ? 0.8 : (0.6 + 0.4 * Math.sin(tt * 1.4 + seed));
      const trad = 1.9 - z * 1.0, ta = (0.42 - z * 0.24) * tw;
      ctx.beginPath(); ctx.arc(ex, ey, Math.max(0.7, trad), 0, 2 * Math.PI, false); ctx.fillStyle = rgbaHex(lit, Math.max(0.05, ta)); ctx.fill();
      // (1) signal pulse — a mote fires outward along the dendrite, staggered per thread; brighter after a batch lands
      if (!prefersReducedMotion) {
        const cyc = (((tt * 0.2 + seed * 0.37) % 1) + 1) % 1;
        if (cyc < 0.4) { const p = cyc / 0.4, m = bez(p), ma = Math.sin(p * Math.PI) * 0.55 * fireBoost; ctx.beginPath(); ctx.arc(m[0], m[1], 1.3, 0, 2 * Math.PI, false); ctx.fillStyle = rgbaHex(lit, Math.min(0.9, ma)); ctx.fill(); }
      }
    }
  }
}

// --- dedup ABSORB gesture ---------------------------------------------------
// When the self-curation engine folds duplicate fragments into a canonical entity (a merge landing on a
// node), we show it as the visual OPPOSITE of growth: instead of signals firing OUT, ghost "duplicate" motes
// converge INWARD along short comet-tails and collapse into the node, which then blooms brighter (it just
// absorbed the duplicates' degree). Many → one, drawn in graph space so it tracks the camera. Fired from
// onCurationMove for kind='dedup'|'merge'; a no-op (falls back to the field flare) if the anchor isn't in view.
const absorbs = [];   // active absorb animations {id, startAt, ghosts:[{ang,r0,curve}]}
const ABSORB_DUR = 1150;
function dedupAbsorb(anchor, count) {
  if (prefersReducedMotion || !G || !anchor) return false;
  const node = ((G.graphData().nodes) || []).find(n => n.id === anchor);
  if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return false;   // canonical off-screen → caller flares the field instead
  const n = Math.min(9, Math.max(2, count || 3));
  const ghosts = [];
  for (let i = 0; i < n; i++) {
    const seed = node.x * 0.13 + node.y * 0.29 + i * 2.3999;
    ghosts.push({ ang: ((seed % 6.283) + 6.283) % 6.283, r0: 52 + Math.abs(Math.sin(seed)) * 62, curve: (i % 2 ? 1 : -1) });
  }
  absorbs.push({ id: anchor, startAt: performance.now(), ghosts });
  if (absorbs.length > 12) absorbs.shift();   // cap concurrent gestures
  return true;
}
function drawAbsorbs(ctx) {
  if (!absorbs.length || !G) return;
  const now = performance.now(), nodes = (G.graphData().nodes) || [];
  for (let ai = absorbs.length - 1; ai >= 0; ai--) {
    const A = absorbs[ai], p = (now - A.startAt) / ABSORB_DUR;
    if (p >= 1) { absorbs.splice(ai, 1); continue; }
    const node = nodes.find(nn => nn.id === A.id);
    if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) { if (p > 0.25) absorbs.splice(ai, 1); continue; }
    const nx = node.x, ny = node.y, nr = node.__r || 4, col = node.color || '#7dd3fc', lit = lighten(col, 0.5);
    const ease = p * p * (3 - 2 * p);                        // smoothstep: accelerate inward
    for (const g of A.ghosts) {
      const rad = g.r0 * (1 - ease) + (nr + 1) * ease;       // converge from r0 → the soma
      const ang = g.ang + g.curve * (1 - p) * 0.6;           // slight inward spiral that straightens on arrival
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const gx = nx + ca * rad, gy = ny + sa * rad;
      const tailR = rad + Math.min(20, g.r0 * 0.28) * (1 - p);
      const tx = nx + ca * tailR, ty = ny + sa * tailR;
      const fade = Math.sin(Math.min(1, p / 0.92) * Math.PI);   // fade in, peak, fade as it lands
      const tg = ctx.createLinearGradient(tx, ty, gx, gy);
      tg.addColorStop(0, rgbaHex(col, 0)); tg.addColorStop(1, rgbaHex(lit, 0.5 * fade));
      ctx.strokeStyle = tg; ctx.lineWidth = 1.2; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(gx, gy); ctx.stroke();
      ctx.beginPath(); ctx.arc(gx, gy, 1.9, 0, 2 * Math.PI, false); ctx.fillStyle = rgbaHex(lit, 0.85 * fade); ctx.fill();
    }
    if (p > 0.45) {                                          // consolidation bloom as they collapse in
      const q = (p - 0.45) / 0.55, br = nr + 6 + q * 18;
      const bloom = ctx.createRadialGradient(nx, ny, 0, nx, ny, br);
      bloom.addColorStop(0, rgbaHex(lit, 0.5 * (1 - q))); bloom.addColorStop(1, rgbaHex(col, 0));
      ctx.fillStyle = bloom; ctx.beginPath(); ctx.arc(nx, ny, br, 0, 2 * Math.PI, false); ctx.fill();
    }
  }
}

// --- kg:activity bus — generic data-activity gestures ------------------------
// One channel visualizes every DB interaction (see docs/KG_ACTIVITY_VISUALIZATION_DESIGN.md). Each event
// {db,kind,anchor,anchor2,count,tier,epistemic} routes to a gesture: node/edge events play in GRAPH space
// on the named node(s) when they're in view; anything off-screen (most of 1.74M) becomes far-field WEATHER
// so the whole galaxy shimmers where work is happening. Stage A = P0 nodes/edges (+ merge→absorb); other
// kinds gracefully register as weather until their Stage-B gestures land.
const activities = [];   // in-view graph-space gestures {kind, startAt, dur, a, b, col, epistemic}
const weather = [];      // off-screen flares {x, y, startAt, dur, mag, col} in device px (drawn by drawFarField)
const ACT_CAP = 64;
let superNovaHoldUntil = 0;   // brief window after a supernova fly during which follow won't re-center (holds on the explosion)
function kgFindNode(name) { if (!G || name == null) return null; return ((G.graphData().nodes) || []).find(n => n.id === name) || null; }
// project a node to device-pixel screen coords + whether it's inside the viewport (graph2ScreenCoords → CSS px)
function kgProject(n, cv) {
  if (!n || !Number.isFinite(n.x) || !Number.isFinite(n.y) || !G.graph2ScreenCoords) return null;
  const p = G.graph2ScreenCoords(n.x, n.y); if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  const ratio = cv.clientWidth ? cv.width / cv.clientWidth : 1, x = p.x * ratio, y = p.y * ratio;
  return { x, y, inView: x >= 0 && x <= cv.width && y >= 0 && y <= cv.height };
}
// SQ short-term = violet, Echo long-term = sky; a node's own colour wins when it has one.
function kgActColor(evt, node) { return (node && node.color) || (evt.db === 'sidequest' ? '#a78bfa' : '#7dd3fc'); }
function kgWeatherRGB(evt) { return evt.db === 'sidequest' ? '168,139,250' : '125,211,252'; }
function fieldFlare(evt, proj) {
  const cv = document.querySelector('#graph canvas'); if (!cv) return;
  let x, y;
  if (proj && Number.isFinite(proj.x)) { x = Math.max(8, Math.min(cv.width - 8, proj.x)); y = Math.max(8, Math.min(cv.height - 8, proj.y)); }
  else { const h = hashSeed(String(evt.anchor || evt.kind || 'a')); x = cv.width * (0.1 + 0.8 * h); y = cv.height * (0.1 + 0.8 * ((h * 97.13) % 1)); }   // no position → consistent hashed spot
  weather.push({ x, y, startAt: performance.now(), dur: 1200, mag: Math.min(2.2, 1 + Math.log10((evt.count || 1) + 0.5)), col: kgWeatherRGB(evt) });
  if (weather.length > 90) weather.shift();
}
// SUPERNOVA — a massive batch of new short-term data (a bulk document/research pull) bursts as ONE dramatic
// explosion at the point it landed, instead of dozens of tiny sparks. In-view → a graph-space burst; off-screen
// (e.g. you're following the subconscious elsewhere) → a big far-field weather flare so it still registers.
function superNova(gx, gy, count) {
  if (prefersReducedMotion || !G) return;
  const mag = Math.min(3.2, 1.2 + Math.log2((count || 2)));
  const push = () => { activities.push({ kind: 'supernova', startAt: performance.now(), dur: 1500, gx, gy, mag }); if (activities.length > ACT_CAP) activities.shift(); };
  // COUPLE with the subconscious: in Follow mode a big pull FLIES the camera to the explosion (following her
  // = being taken to where data is erupting), and holds there ~1.4s so the next walk-step doesn't yank away.
  if (follow) {
    try { G.centerAt(gx, gy, 1100); if (G.resumeAnimation) G.resumeAnimation(); } catch (e) {}
    superNovaHoldUntil = performance.now() + 1400;
    push();
    return;
  }
  // Not following: full burst if the core is in view, else a big far-field weather flare where it landed.
  const cv = document.querySelector('#graph canvas');
  const proj = cv ? kgProject({ x: gx, y: gy }, cv) : null;
  if (proj && proj.inView) push();
  else fieldFlare({ db: 'sidequest', anchor: 'supernova', count: (count || 2) * 4 }, proj);
}
function drawSupernova(ctx, A, p) {
  const gx = A.gx, gy = A.gy; if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;
  const mag = A.mag || 1.5, ease = 1 - Math.pow(1 - p, 2), fade = 1 - p, R = Math.max(1, (26 + 80 * mag) * ease);
  const cg = ctx.createRadialGradient(gx, gy, 0, gx, gy, R * 0.6);   // core flash
  cg.addColorStop(0, `rgba(221,214,254,${0.6 * fade})`); cg.addColorStop(0.4, `rgba(168,139,250,${0.32 * fade})`); cg.addColorStop(1, 'rgba(168,139,250,0)');
  ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(gx, gy, R * 0.6, 0, 2 * Math.PI, false); ctx.fill();
  ctx.strokeStyle = `rgba(196,181,253,${fade * 0.7})`; ctx.lineWidth = 2 * mag * fade + 0.5;   // shockwave ring
  ctx.beginPath(); ctx.arc(gx, gy, R, 0, 2 * Math.PI, false); ctx.stroke();
  const spokes = Math.min(16, Math.round(6 * mag)); ctx.lineWidth = 1;   // radiating spokes
  for (let s = 0; s < spokes; s++) {
    const ang = (s / spokes) * 6.283 + gx * 0.01, r0 = R * 0.5, r1 = R * (0.85 + 0.25 * ((s * 7) % 3));
    ctx.strokeStyle = `rgba(196,181,253,${fade * 0.45})`;
    ctx.beginPath(); ctx.moveTo(gx + Math.cos(ang) * r0, gy + Math.sin(ang) * r0); ctx.lineTo(gx + Math.cos(ang) * r1, gy + Math.sin(ang) * r1); ctx.stroke();
  }
}
function spawnActivity(evt) {
  if (!evt || prefersReducedMotion || !G) return;
  const kind = evt.kind || '';
  if (kind === 'node.merge') { if (evt.anchor && dedupAbsorb(evt.anchor, evt.count || 3)) return; return fieldFlare(evt); }
  const cv = document.querySelector('#graph canvas');
  const a = kgFindNode(evt.anchor), b = evt.anchor2 != null ? kgFindNode(evt.anchor2) : null;
  const pa = a && cv ? kgProject(a, cv) : null, pb = b && cv ? kgProject(b, cv) : null;
  const col = kgActColor(evt, a);
  if (kind === 'edge.born' || kind === 'edge.promote') {
    if (a && b && pa && pb && pa.inView && pb.inView) { activities.push({ kind, startAt: performance.now(), dur: 850, a, b, col, epistemic: evt.epistemic }); }
    else fieldFlare(evt, pa || pb);
  } else if (kind === 'node.born' || kind === 'node.enrich') {
    if (a && pa && pa.inView) { activities.push({ kind, startAt: performance.now(), dur: kind === 'node.born' ? 750 : 640, a, col, epistemic: evt.epistemic }); }
    else fieldFlare(evt, pa);
  } else {
    fieldFlare(evt, pa);   // P1/P2 kinds (promote/match/recall/doc/news/think…) register as weather until Stage B
  }
  if (activities.length > ACT_CAP) activities.shift();
}
// GRAPH-space gestures (drawn in drawAtmosphere, under the nodes). NaN-guarded (createLinearGradient throws).
function drawActivities(ctx, scale) {
  if (!activities.length || !G) return;
  const now = performance.now();
  for (let i = activities.length - 1; i >= 0; i--) {
    const A = activities[i], p = (now - A.startAt) / A.dur;
    if (p >= 1) { activities.splice(i, 1); continue; }
    if (A.kind === 'supernova') { drawSupernova(ctx, A, p); continue; }   // no node anchor — draws at fixed graph coords
    const a = A.a; if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) { activities.splice(i, 1); continue; }
    const col = A.col || '#7dd3fc', lit = lighten(col, 0.5), r = a.__r || 4;
    if (A.kind === 'node.born') {                                  // spark: expanding ring + core flash
      const rr = r + 2 + p * 16, fade = 1 - p;
      ctx.strokeStyle = rgbaHex(lit, 0.7 * fade); ctx.lineWidth = Math.max(0.5, 1.6 / scale);
      ctx.beginPath(); ctx.arc(a.x, a.y, rr, 0, 2 * Math.PI, false); ctx.stroke();
      const g = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, r + 7);
      g.addColorStop(0, rgbaHex(lit, 0.6 * fade)); g.addColorStop(1, rgbaHex(col, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(a.x, a.y, r + 7, 0, 2 * Math.PI, false); ctx.fill();
    } else if (A.kind === 'node.enrich') {                         // one bright breath — "learned more"
      const q = Math.sin(p * Math.PI), rr = r + 1 + q * 7;
      ctx.strokeStyle = rgbaHex(lit, 0.5 * q); ctx.lineWidth = Math.max(0.5, 1.2 / scale);
      ctx.beginPath(); ctx.arc(a.x, a.y, rr, 0, 2 * Math.PI, false); ctx.stroke();
    } else {                                                       // edge.born / edge.promote — a synapse forms
      const b = A.b; if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) { activities.splice(i, 1); continue; }
      const grow = Math.min(1, p / 0.7), ex = a.x + (b.x - a.x) * grow, ey = a.y + (b.y - a.y) * grow;
      ctx.save();
      if (A.kind === 'edge.promote' && p < 0.5) ctx.setLineDash([3 / scale, 3 / scale]);   // ghost → solid
      const g = ctx.createLinearGradient(a.x, a.y, ex, ey);
      g.addColorStop(0, rgbaHex(lit, 0.75)); g.addColorStop(1, rgbaHex(lit, 0.2));
      ctx.strokeStyle = g; ctx.lineWidth = Math.max(0.6, 1.4 / scale); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.restore();
      if (grow >= 1) { const mp = (p - 0.7) / 0.3, mx = a.x + (b.x - a.x) * mp, my = a.y + (b.y - a.y) * mp;   // pulse fires along the new synapse
        ctx.beginPath(); ctx.arc(mx, my, 1.8, 0, 2 * Math.PI, false); ctx.fillStyle = rgbaHex(lit, 0.9 * (1 - mp)); ctx.fill(); }
    }
  }
}
function onActivity(evt) { if (evt) try { spawnActivity(evt); } catch (e) { warnOnce('activity', e); } }

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
  if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) {
    const col = target.color || '#FBBF24', rad = 72;
    const bg = ctx.createRadialGradient(target.x, target.y, 0, target.x, target.y, rad);
    bg.addColorStop(0, rgbaHex(col, 0.12)); bg.addColorStop(1, rgbaHex(col, 0));
    ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(target.x, target.y, rad, 0, 2 * Math.PI, false); ctx.fill();
  }
  drawTendrils(ctx, scale);   // threads from well-connected nodes reaching off into the universe
  drawAbsorbs(ctx);           // dedup: duplicate motes collapsing INTO a canonical node
  drawActivities(ctx, scale); // kg:activity — node/edge gestures (born spark, growing synapse, enrich breath)
}

function ensureGraph() {
  if (G) return G;
  G = ForceGraph()(graphEl)
    .nodeId('id').backgroundColor('#0a0b0e')
    // Keep the render loop ALWAYS live. force-graph's autoPauseRedraw pauses the loop once the sim cools;
    // if that happens while the webview is momentarily 0-size at init it never repaints → a dead black
    // canvas (the post-reboot bug). We also NEED continuous frames for the ambient far-field/nebula drift +
    // pulses. The scene is cheap (dozens of nodes + a seeded field), so a live loop is the right call here.
    .autoPauseRedraw(false)
    // Higher friction (velocityDecay) + faster alpha cooldown so the cluster settles into a HELD lattice you
    // fly through, instead of a perpetually-rearranging hairball. The "motion" should come from the camera and
    // the ambient far-field/signals, not from the nodes jostling. Physics calm → tendril tips hold still.
    .cooldownTicks(120).d3VelocityDecay(0.45).d3AlphaDecay(0.035)
    .linkColor(l => l.color).linkWidth(l => l.width)
    // A same-category glow drawn OVER the default line ('after' → force-graph keeps native arrows + the
    // directional/emitted particles that drive the connection-ripple). Category still owns COLOUR + WIDTH
    // (legend stays valid) — we only add presence against the dark ground.
    .linkCanvasObjectMode(() => 'after')
    .linkCanvasObject((l, ctx, scale) => {
      const s = l.source, t = l.target;
      if (!s || !t || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(t.x) || !Number.isFinite(t.y)) return;   // NaN passes ==null → guard finite
      // Cross-store (short-term ↔ Echo) federation threads read BRIGHTER — the visible bridge between the
      // active core and the long-term corpus (this is where match/promotion live on the map).
      const cross = l.cross || ((s.store === 'sidequest') !== (t.store === 'sidequest'));
      const base = cross ? 'rgba(196,181,253,0.85)' : (l.color || 'rgba(148,163,184,0.5)');
      const w = cross ? Math.max(1.1, (l.width || 1) * 1.6) : Math.max(0.7, (l.width || 0.6) * 1.4);
      ctx.save();
      if (cross) { ctx.shadowColor = base; ctx.shadowBlur = 6; }   // PERF: blur only the few cross-store threads; the bulk of edges skip the per-shape blur pass
      ctx.strokeStyle = base; ctx.lineWidth = w; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
      ctx.restore();
    })
    .linkDirectionalArrowLength(3).linkDirectionalArrowRelPos(1)
    // PERF (video-buffering fix): NO perpetual directional particles. The old focalId-gated `2` emitted
    // particles on the focal node's edges CONTINUOUSLY once locked on — force-graph then does extra per-frame
    // GPU work forever, which (via Electron's single shared GPU process) starved video frame delivery. That
    // cost appeared exactly "when follow locks on, even without the follow graphic" (focalId is set by ANY
    // focus/walk, independent of the Follow toggle) while plain overview (0 particles) stayed fine. The on-move
    // amber shimmer is preserved by pulse()'s one-shot G.emitParticle bursts, which FINISH and let the loop
    // fall back to the cheap ambient level instead of animating particles indefinitely.
    .linkDirectionalParticles(0)
    .linkDirectionalParticleSpeed(0.011).linkDirectionalParticleWidth(2).linkDirectionalParticleColor(() => 'rgba(251,191,36,0.9)')
    .linkLabel(l => `${l.relType} (${l.category})`)
    .onNodeHover(n => { hovered = n || null; renderHover(); if (G) G.nodeColor(G.nodeColor()); })
    .onNodeClick(n => { if (n && !n.isFocal) focus(n.id); })
    .nodePointerAreaPaint((n, color, ctx) => { ctx.beginPath(); ctx.arc(n.x, n.y, n.isFocal ? 10 : 8, 0, 2 * Math.PI, false); ctx.fillStyle = color; ctx.fill(); })
    .nodeCanvasObject((n, ctx, scale) => {
      // Non-finite positions happen transiently under Follow's data churn (a fresh node before d3 places it).
      // createRadialGradient (below) THROWS on NaN, and a throw here dies inside force-graph's rAF callback →
      // the whole render loop stops for good (the dead-black-canvas bug). arc()/stroke() tolerate NaN; the
      // gradient does not — so skip this node for this frame. It draws normally once positioned.
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return;
      // STORE LAYER: short-term (Side Quest) nodes = violet, brighter bloom, and SOLIDITY driven by epistemic
      // status (speculated/anticipated render translucent → they firm up as they're confirmed/promoted). Echo
      // corpus keeps its entity-type colour. This is what makes the active core read as a distinct layer.
      const isST = n.store === 'sidequest';
      const r = nodeRadius(n), col = n.color || (isST ? '#a78bfa' : '#7dd3fc');
      const epi = n.epistemic;
      const solidity = !isST ? 1 : ((epi === 'speculated' || epi === 'anticipated') ? 0.5 : (epi === 'told' || epi === 'read') ? 0.76 : 1);
      const bornFade = n.bornAt ? Math.min(1, (performance.now() - n.bornAt) / 450) : 1;   // new nodes materialise in
      // (3) soma breathing — a slow, subtle brightness pulse per node, like a living cell at rest
      const breathe = prefersReducedMotion ? 1 : (0.8 + 0.2 * Math.sin(performance.now() / 1000 * 0.9 + (n.__ph != null ? n.__ph : (n.__ph = (n.x * 0.7 + n.y * 0.3) % 6.283))));
      const nodeAlpha = bornFade * breathe * solidity;
      if (nodeAlpha < 1) ctx.globalAlpha = nodeAlpha;
      // lit node: a soft same-hue glow (scales with radius → hubs shine brighter) makes the disk read as a
      // lit object, then a radial gradient (light core → saturated rim) gives it depth instead of a flat fill.
      // PERF: shadowBlur is the canvas perf-killer (a per-shape offscreen blur), and it was applied to EVERY
      // node every frame → in a dense ~320-node follow view that's the residual skip-lag. Gate the glow pass to
      // the nodes that actually read as glowing — focal, hovered, sized hubs, and the short-term core — and let
      // the many small leaf nodes draw with just their (cheap) lit gradient fill below. Overview stays identical.
      const glow = n.isFocal || r >= 6 || (hovered && hovered.id === n.id);   // NOT every short-term node — the violet fill+ring distinguishes the core cheaply (perf: avoid ~90 shadowBlurs/frame)
      if (glow) {
        ctx.save();
        ctx.shadowColor = rgbaHex(col, 0.85); ctx.shadowBlur = r * (isST ? 1.7 : 1);   // core glows hotter
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI, false); ctx.fillStyle = col; ctx.fill();
        ctx.restore();
      }
      const grad = ctx.createRadialGradient(n.x - r * 0.35, n.y - r * 0.4, r * 0.12, n.x, n.y, r);
      grad.addColorStop(0, lighten(col, 0.55)); grad.addColorStop(0.55, col); grad.addColorStop(1, rgbaHex(col, 0.92));
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI, false); ctx.fillStyle = grad; ctx.fill();
      // subtle rim for definition against the glow
      ctx.lineWidth = 1 / scale; ctx.strokeStyle = 'rgba(0,0,0,0.38)'; ctx.stroke();
      if (isST) { ctx.beginPath(); ctx.arc(n.x, n.y, r + 1.5, 0, 2 * Math.PI, false); ctx.lineWidth = 1 / scale; ctx.strokeStyle = 'rgba(196,181,253,0.6)'; if (solidity < 1) ctx.setLineDash([2 / scale, 2 / scale]); ctx.stroke(); ctx.setLineDash([]); }   // violet layer-ring; dashed while speculative
      if (n.isFocal) { ctx.lineWidth = 2 / scale; ctx.strokeStyle = '#FBBF24'; ctx.stroke(); }
      // COSMETIC (demo): an expanding amber ring on the focal node for ~1.4s after each move — reads as
      // "new activity landed here". Time-based off pulseAt; the edge particles keep frames coming so it draws.
      if (n.isFocal && pulseAt) { const dt = performance.now() - pulseAt; if (dt >= 0 && dt < 1400) { const p = dt / 1400; ctx.beginPath(); ctx.arc(n.x, n.y, r + 3 + p * 22, 0, 2 * Math.PI, false); ctx.strokeStyle = `rgba(251,191,36,${(1 - p) * 0.7})`; ctx.lineWidth = 2 / scale; ctx.stroke(); } }
      if (n.overviewSource === 'recent' || n.overviewSource === 'both') { ctx.beginPath(); ctx.arc(n.x, n.y, r + 2, 0, 2 * Math.PI, false); ctx.setLineDash([2, 2]); ctx.lineWidth = 1.2 / scale; ctx.strokeStyle = '#FBBF24'; ctx.stroke(); ctx.setLineDash([]); }
      if (hovered && hovered.id === n.id) { ctx.beginPath(); ctx.arc(n.x, n.y, r * 1.8, 0, 2 * Math.PI, false); ctx.strokeStyle = 'rgba(125,211,252,0.85)'; ctx.lineWidth = 1.5 / scale; ctx.stroke(); }
      n.__r = r;   // stash for the label pass (onRenderFramePost draws labels so it can rank + de-collide)
      ctx.globalAlpha = 1;
    })
    // Labels are drawn in ONE post pass (not per-node) so we control z-order: focal/hovered/neighbors
    // first, then by prominence, each skipped if its box would overlap an already-placed label. Kills the
    // pile-up seen at overview scale where every node stamped its text on top of the others.
    // hooks wrapped so a per-frame throw on odd data can never kill the (now always-live) render loop
    .onRenderFramePre((ctx, s) => { try { drawAtmosphere(ctx, s); } catch (e) { warnOnce('atmosphere', e); } })
    .onRenderFramePost((ctx, s) => { try { drawLabels(ctx, s); } catch (e) { warnOnce('labels', e); } });
  // Force tuning: spread clusters and stop node disks stacking. Stronger bounded charge repels nodes
  // without yanking distant clusters into one thread (distanceMax caps the pull range); softer, longer
  // links give the graph room; the custom collide keeps disks off each other.
  try {
    const charge = G.d3Force('charge'); if (charge && charge.strength) charge.strength(-150).distanceMax(700);
    const link = G.d3Force('link'); if (link && link.distance) link.distance(l => 36 + (l.category === 'generic' ? 12 : 0)).strength(0.32);
    G.d3Force('collide', makeCollide(n => nodeRadius(n) + 3));
    G.d3Force('core', makeCoreForce(0.06));   // gathers the short-term layer into the central bright core
  } catch (e) {}
  const fit = () => { const w = graphEl.clientWidth, h = graphEl.clientHeight; if (w > 0 && h > 0) { G.width(w).height(h); try { if (G.resumeAnimation) G.resumeAnimation(); } catch (e) {} } };
  fit(); new ResizeObserver(fit).observe(graphEl);
  try { window.__kgGraph = G; } catch (e) {}   // read-only debug handle for live CDP inspection (dev only)
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
// Append the persistent short-term layer to whatever Echo set the mode built. Short-term nodes always show
// (they're a separate layer, not type-filtered); short-term links render when both endpoints are present, so
// cross-store federation threads appear whenever their Echo match is in view. Node objects reused → d3 keeps x/y.
function withShortTerm(nodes, links) {
  if (!shortTerm.nodes.size) return { nodes, links };
  const present = new Set(nodes.map(n => n.id));
  for (const n of shortTerm.nodes.values()) if (!present.has(n.id)) { nodes.push(n); present.add(n.id); }
  for (const m of shortTerm.links.values()) if (present.has(m.s) && present.has(m.t)) links.push({ source: m.s, target: m.t, relType: m.relType, color: m.color, width: m.width, category: m.category, cross: m.cross });
  return { nodes, links };
}
function applyFilter() {
  const useFilter = selected.size > 0;
  if (mode === 'ego') {
    // source from the PERSISTENT world (reuse node objects → d3 keeps their positions). Camera stays put;
    // setData flies it. Filtering just hides types; the objects survive so unfiltering restores positions.
    const nodes = [...world.nodes.values()].filter(n => n.isFocal || !useFilter || selected.has(n.entityType));
    const present = new Set(nodes.map(n => n.id));
    const links = [...world.links.values()].filter(m => present.has(m.s) && present.has(m.t))
      .map(m => ({ source: m.s, target: m.t, relType: m.relType, color: m.color, width: m.width, category: m.category }));
    const merged = withShortTerm(nodes, links);
    ensureGraph().graphData({ nodes: merged.nodes, links: merged.links });
    return;
  }
  const nodes = full.nodes.filter(n => n.isFocal || !useFilter || selected.has(n.entityType));
  const present = new Set(nodes.map(n => n.id));
  const links = full.links
    .map(l => ({ source: linkEnd(l.source), target: linkEnd(l.target), relType: l.relType, color: l.color, width: l.width, category: l.category }))
    .filter(l => present.has(l.source) && present.has(l.target));
  const merged = withShortTerm(nodes, links);
  ensureGraph().graphData({ nodes: merged.nodes, links: merged.links });
  if (merged.nodes.length) setTimeout(() => { try { G.zoomToFit(400, 50); if (G.resumeAnimation) G.resumeAnimation(); } catch (e) {} }, 450);
}

// Seed synthetic short-term nodes to PROVE the two-source structure renders (dev only; the real read wires
// main.js kg:shortterm over graph_entities + recent documents). Cross-links some to real in-view Echo nodes.
function seedShortTerm(count = 14) {
  if (!G) return { err: 'no graph' };
  const echoNodes = (G.graphData().nodes || []).filter(n => Number.isFinite(n.x) && n.store !== 'sidequest');
  const epis = ['witnessed', 'confirmed', 'told', 'read', 'speculated', 'anticipated'];
  const now = performance.now();
  let cx = 0, cy = 0, c = 0; for (const n of echoNodes) { cx += n.x; cy += n.y; c++; } if (c) { cx /= c; cy /= c; }
  const made = [];
  for (let i = 0; i < count; i++) {
    const epi = epis[i % epis.length], id = `short-term ${epi} ${i + 1}`;
    const n = { id, store: 'sidequest', entityType: 'shortterm', epistemic: epi, summary: `synthetic short-term memory (${epi})`, color: '#a78bfa', bornAt: now, x: cx + (Math.random() - 0.5) * 70, y: cy + (Math.random() - 0.5) * 70 };
    shortTerm.nodes.set(id, n); made.push(n);
  }
  for (let i = 1; i < made.length; i++) if (Math.random() < 0.55) { const a = made[i].id, b = made[i - 1].id; shortTerm.links.set(a + '>' + b, { s: a, t: b, relType: 'related', color: 'rgba(168,139,250,0.5)', width: 0.8, category: 'generic' }); }
  const picks = echoNodes.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(6, made.length));
  picks.forEach((e, i) => { const a = made[i % made.length].id; shortTerm.links.set('X:' + a + '>' + e.id, { s: a, t: e.id, relType: 'MATCHES', color: 'rgba(196,181,253,0.9)', width: 1.2, category: 'projected', cross: true }); });
  applyFilter();
  return { seeded_nodes: made.length, links: shortTerm.links.size, echo_in_view: echoNodes.length };
}
try { window.__kgSeedShortTerm = (n) => seedShortTerm(n || 14); window.__kgClearShortTerm = () => { shortTerm.nodes.clear(); shortTerm.links.clear(); applyFilter(); return 'cleared'; }; window.__kgShortTermN = () => shortTerm.nodes.size; } catch (e) {}

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

// Merge an ego walk into the persistent world: reuse existing node objects (position preserved), seed new
// ones next to the neighbour they connect to (so they grow outward, not fly from origin), accumulate links,
// then LRU-prune beyond the cap. Returns the focal id.
function mergeEgo(res) {
  const now = performance.now();
  const incoming = res.nodes || [], incLinks = res.links || [];
  for (const n of world.nodes.values()) n.isFocal = false;
  const focal = incoming.find(n => n.isFocal) || incoming[0] || null;
  const fId = focal ? focal.id : null;
  // seed origin for brand-new nodes: the current focal's spot if placed, else the world centroid
  let seedX = 0, seedY = 0, cnt = 0;
  for (const n of world.nodes.values()) if (Number.isFinite(n.x)) { seedX += n.x; seedY += n.y; cnt++; }
  if (cnt) { seedX /= cnt; seedY /= cnt; }
  const ef = fId && world.nodes.get(fId);
  if (ef && Number.isFinite(ef.x)) { seedX = ef.x; seedY = ef.y; }
  const connectedTo = new Map();   // incoming id → a connected incoming id (to seed near a real neighbour)
  for (const l of incLinks) { const a = linkEnd(l.source), b = linkEnd(l.target); if (a != null && b != null) { if (!connectedTo.has(a)) connectedTo.set(a, b); if (!connectedTo.has(b)) connectedTo.set(b, a); } }
  const jit = () => (Math.random() - 0.5) * 40;
  for (const inc of incoming) {
    let node = world.nodes.get(inc.id);
    if (node) { node.touchedAt = now; node.entityType = inc.entityType; node.color = inc.color; if (inc.summary) node.summary = inc.summary; if (typeof inc.degree === 'number') node.degree = inc.degree; }
    else {
      let sx = seedX, sy = seedY;
      const nbr = connectedTo.get(inc.id), nn = nbr && world.nodes.get(nbr);
      if (nn && Number.isFinite(nn.x)) { sx = nn.x; sy = nn.y; }
      node = { id: inc.id, entityType: inc.entityType, color: inc.color, summary: inc.summary || null, degree: inc.degree, bornAt: now, touchedAt: now, x: sx + jit(), y: sy + jit() };
      world.nodes.set(inc.id, node);
    }
    if (inc.id === fId) node.isFocal = true;
  }
  for (const l of incLinks) { const s = linkEnd(l.source), t = linkEnd(l.target); if (s == null || t == null) continue; const key = s + '→' + t + '::' + l.relType; if (!world.links.has(key)) world.links.set(key, { s, t, relType: l.relType, color: l.color, width: l.width, category: l.category }); }
  if (world.nodes.size > WORLD_CAP) {   // LRU trail-prune (never the focal); drop dangling links
    const arr = [...world.nodes.values()].filter(n => n.id !== fId).sort((a, b) => a.touchedAt - b.touchedAt);
    const drop = world.nodes.size - WORLD_CAP, gone = new Set();
    for (let i = 0; i < drop && i < arr.length; i++) { world.nodes.delete(arr[i].id); gone.add(arr[i].id); }
    for (const [k, m] of world.links) if (gone.has(m.s) || gone.has(m.t)) world.links.delete(k);
  }
  return fId;
}
// Fly the camera to the focal node through the persistent space (a pan, not a zoomToFit reset).
function flyToFocal() {
  if (!G) return;
  try { if (G.resumeAnimation) G.resumeAnimation(); } catch (e) {}
  setTimeout(() => { try { const f = (G.graphData().nodes || []).find(n => n.isFocal); if (f && Number.isFinite(f.x)) G.centerAt(f.x, f.y, 900); } catch (e) {} }, 300);
}

function setData(res, m) {
  mode = m;
  backBtn.hidden = (m !== 'ego');
  // error paths: never wipe the persistent world on a transient ego miss (keep flying); overview clears.
  if (!res || !res.ok) { setOverlay((res && res.error) || 'failed to load', 'fail'); if (m !== 'ego') { full = { nodes: [], links: [] }; renderPills([]); statsEl.hidden = true; } return; }
  if (res.error) { setOverlay(`${res.error}: ${submitted}`, 'warn'); if (m !== 'ego') { full = { nodes: [], links: [] }; renderPills([]); applyFilter(); statsEl.hidden = true; } return; }
  renderPills(res.availableTypes || []);
  renderLegend(res.legend || []);
  selected = new Set();
  statsEl.hidden = false;
  if (m === 'ego') {
    const wasEmpty = world.nodes.size === 0;   // first neighbourhood → frame it; later moves → fly there
    focalId = mergeEgo(res);
    for (const nn of world.nodes.values()) if (typeof nn.degree === 'number') degreeHint.set(nn.id, nn.degree);
    setOverlay(world.nodes.size ? null : 'No graph data.');
    statsEl.textContent = `ego · ${res.stats ? res.stats.related : (res.links || []).length} related · hops=${res.stats ? res.stats.hops : ''} · world ${world.nodes.size}`;
    applyFilter();
    if (wasEmpty) setTimeout(() => { try { G.zoomToFit(400, 50); if (G.resumeAnimation) G.resumeAnimation(); } catch (e) {} }, 450);
    else flyToFocal();
  } else {
    world.nodes.clear(); world.links.clear();   // leaving follow → drop the traversed map
    full = { nodes: res.nodes || [], links: res.links || [] };
    for (const nn of full.nodes) if (typeof nn.degree === 'number') degreeHint.set(nn.id, nn.degree);   // overview hubs → degree bridge
    focalId = (full.nodes.find(n => n.isFocal) || {}).id || null;
    setOverlay(full.nodes.length ? null : 'No graph data.');
    statsEl.textContent = `overview · ${(res.stats && res.stats.totalEntities || 0).toLocaleString()} nodes · ${(res.stats && res.stats.totalRelations || 0).toLocaleString()} edges`;
    applyFilter();
  }
}

async function loadOverview() {
  mode = 'overview'; submitted = ''; backBtn.hidden = true; setOverlay('Loading corpus overview…');
  try { setData(await window.sq.kg.overview(), 'overview'); } catch (e) { setOverlay(String(e.message || e), 'fail'); }
  loadShortTerm();   // fold in the Side Quest short-term layer (the bright active core) — independent of Echo
}
// TWO-SOURCE: fetch Side Quest's short-term store (local graph + recent docs) and merge it into the persistent
// `shortTerm` layer (reuse node objects by id → d3 keeps positions). It renders in EVERY view via withShortTerm
// as the violet epistemic core, gathered centrally by makeCoreForce. Bounded server-side so it stays cheap.
let __stInit = false;   // first load done? (so we don't spark all ~105 nodes on startup)
async function loadShortTerm() {
  try {
    if (!(window.sq && window.sq.kg && window.sq.kg.shortterm)) return;
    const res = await window.sq.kg.shortterm();
    if (!res || !res.ok) return;
    let cx = 0, cy = 0, c = 0;
    if (G) for (const n of (G.graphData().nodes || [])) if (Number.isFinite(n.x) && n.store !== 'sidequest') { cx += n.x; cy += n.y; c++; }
    if (!c) { cx = 0; cy = 0; }
    const now = performance.now(), seen = new Set(), fresh = [];
    for (const inc of (res.nodes || [])) {
      seen.add(inc.id);
      let node = shortTerm.nodes.get(inc.id);
      if (node) { node.entityType = inc.entityType; node.epistemic = inc.epistemic; if (inc.summary) node.summary = inc.summary; }
      else { shortTerm.nodes.set(inc.id, { id: inc.id, store: 'sidequest', entityType: inc.entityType, epistemic: inc.epistemic, summary: inc.summary || null, bornAt: now, x: cx + (Math.random() - 0.5) * 90, y: cy + (Math.random() - 0.5) * 90 }); if (__stInit) fresh.push(inc.id); }
    }
    let removed = 0;
    for (const id of [...shortTerm.nodes.keys()]) if (!seen.has(id)) { shortTerm.nodes.delete(id); removed++; }   // drop entries no longer in the buffer
    const oldLinkKeys = new Set(shortTerm.links.keys());
    shortTerm.links.clear();
    for (const l of (res.links || [])) shortTerm.links.set(l.source + '>' + l.target + '::' + l.relType, { s: l.source, t: l.target, relType: l.relType, color: 'rgba(168,139,250,0.45)', width: 0.8, category: l.category || 'derived' });
    // CHANGE-GATED: only re-render (which reheats the sim) when the layer actually changed — idle polls are free.
    const linksChanged = shortTerm.links.size !== oldLinkKeys.size || [...shortTerm.links.keys()].some(k => !oldLinkKeys.has(k));
    if (G && (fresh.length || removed || linksChanged || !__stInit)) applyFilter();
    // "exploding with activity": a BIG batch (bulk document/research pull) bursts as ONE SUPERNOVA at where it
    // landed; a small trickle sparks per-node. Only after the first load (else all ~105 startup nodes flare).
    if (__stInit && fresh.length) {
      if (fresh.length >= 8) {   // supernova: many nodes at once = a super-nova of new data
        let fx = 0, fy = 0, fc = 0;
        for (const id of fresh) { const n = shortTerm.nodes.get(id); if (n && Number.isFinite(n.x)) { fx += n.x; fy += n.y; fc++; } }
        if (fc) superNova(fx / fc, fy / fc, fresh.length);
      } else {
        let k = 0; for (const id of fresh) { if (k++ >= 14) break; try { onActivity({ db: 'sidequest', kind: 'node.born', anchor: id }); } catch (e) {} }
      }
    }
    __stInit = true;
  } catch (e) {}
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
  // BRIDGE the LIVE subconscious walk into the activity bus (renderer-only, no new channel/reboot): each
  // walk step is real Echo enrichment work, so the worked node BREATHES if it's in view, else it flares as
  // far-field weather. This makes the panel visibly react to what she's doing even before the full kg:activity
  // feed lands. (In Follow mode the growth pulse below still fires too — complementary.)
  try { onActivity({ db: 'echo', kind: 'node.enrich', anchor: p.anchor, count: 1 }); } catch (e) {}
  // growth tier: re-center on the exact node, then pulse (coalesced through the metabolism core). SKIP the
  // re-center briefly after a supernova so the camera holds on the explosion it just flew to.
  if (follow && p.anchor !== submitted && performance.now() >= superNovaHoldUntil) focus(p.anchor, { query: p.canonical || p.anchor, soft: true }).then(() => ingestPulse({ tier: 'growth', anchor: p.anchor, count: 1 })).catch(() => {});
}
// curation metabolism: frequent programmatic curation + the daily clean sweep arrive here. Inert until the
// host emits kg:curation-move — same graceful-degrade pattern as follow. Payload {tier, kind, count, items?}.
// Host contract (main.js dedup apply tick): kg:curation-move {kind:'dedup', tier, count, anchor}, one event
// per real fold. anchor = the survivor's name (matches a node.id when that canonical is in view).
function onCurationMove(p) {
  if (!p) return;
  // dedup/merge → the ABSORB gesture on the canonical (duplicates collapsing in). We ALWAYS flare the field
  // softly at the dedup (curation) tempo so an off-screen fold still registers; the absorb only fires when the
  // survivor is actually in view (dedupAbsorb no-ops otherwise). Normalising the tier here also stops a
  // null-tier dedup event from falling through to ingestPulse's 'growth' default (a too-big blast for a merge).
  if (p.kind === 'dedup' || p.kind === 'merge') {
    if (p.anchor) dedupAbsorb(p.anchor, p.count || (p.items ? p.items.length : 3));
    ingestPulse({ tier: p.tier || 'curation', anchor: p.anchor || null, count: p.count || 1 });
    return;
  }
  ingestPulse(p);
}
try { window.__kgDedup = (anchor, count) => dedupAbsorb(anchor, count || 5); window.__kgAbsorbN = () => absorbs.length; window.__kgCuration = (p) => onCurationMove(p); window.__kgActivity = (evt) => onActivity(evt); window.__kgActN = () => activities.length + weather.length; window.__kgNova = (gx, gy, count) => superNova(gx, gy, count || 20); } catch (e) {}   // dev triggers + peek for live CDP verification
followBtn.addEventListener('click', () => setFollow(!follow));
try {
  if (window.sq && window.sq.kg && typeof window.sq.kg.onFocusMove === 'function') window.sq.kg.onFocusMove(onFocusMove);
  else followBtn.disabled = true;   // older host without the live channel → toggle inert
} catch (e) { followBtn.disabled = true; }
try { if (window.sq && window.sq.kg && typeof window.sq.kg.onCurationMove === 'function') window.sq.kg.onCurationMove(onCurationMove); } catch (e) {}
// kg:activity — the generalized data-activity bus (Stage A). Inert until preload exposes onActivity + the DB
// contexts emit their feeds (reboot-gated); the renderer vocabulary is live NOW and testable via __kgActivity.
try { if (window.sq && window.sq.kg && typeof window.sq.kg.onActivity === 'function') window.sq.kg.onActivity(onActivity); } catch (e) {}
try { if (localStorage.getItem('kg.follow') === '1') setFollow(true); } catch (e) {}

loadOverview();
// LIVE short-term core: re-poll every 12s so new short-term memory (a running research project) flows into the
// core as it lands — change-gated (no re-render on idle polls) + fresh nodes spark. The webview only runs while
// the KG surface is active, so this doesn't tick in the background. window.__kgRefreshST for on-demand verify.
try { setInterval(() => { loadShortTerm(); }, 5000); window.__kgRefreshST = () => loadShortTerm(); } catch (e) {}
// Load beacon (diagnostic): confirms THIS surface build actually loaded in the webview. After a reboot,
// open the KG webview console — if this line is present the new renderer is live; if it's absent, an older
// kg.js is being served (stale checkout / wrong branch), which is why the visuals wouldn't appear.
console.info('[kg] surface build 2026-07-11z: kg:activity push bus LIVE (Slice 1) — onActivity wired to the real IPC channel');
