/* renderer/kg3d.js — the 3D Knowledge Graph surface (the port). Parallel to the 2D kg.js; loads the SAME live
 * IPC (window.sq.kg.*) so the data/emitter half carries over unchanged. Renders on 3d-force-graph (three.js /
 * WebGL) so the richness the 2D canvas had to cap — bloom, per-node glow, uncapped gestures — is GPU-cheap.
 *
 * Two-source galaxy with REAL depth: the Side Quest short-term store is the violet active core pushed to the
 * FRONT (+z); the Echo corpus recedes BEHIND (−z). Gestures render as GPU scene-object sprites (lowest drag).
 *
 * PORT STATUS — Phase 1: live two-source data + z-depth core force + UnrealBloom. (Next phases: activity-bus
 * gestures, tendrils, labels, Follow/focus, mint/coalesce.) The 2D kg.html is the untouched fallback until the
 * webview surface is swapped to load this file.
 */
'use strict';
const THREE = window.THREE;
const SQ_VIOLET = '#a78bfa', ECHO_SKY = '#7dd3fc';

const graphEl = document.getElementById('graph3d');
const overlayEl = document.getElementById('overlay');
const hudEl = document.getElementById('hud');
function setOverlay(msg) { if (!overlayEl) return; overlayEl.style.display = msg ? 'flex' : 'none'; if (msg) overlayEl.textContent = msg; }

const linkEnd = (e) => (e && typeof e === 'object') ? e.id : e;

// ---- 3D core force: short-term cohesion in x/y + a z target that splits the two stores into real depth
// (violet core to the FRONT, sky corpus receding to the BACK). The 3D descendant of makeCoreForce. ----
function makeCore3D(strength = 0.05) {
  let ns = [];
  function force(alpha) {
    let cx = 0, cy = 0, c = 0;
    for (const n of ns) if (n.store === 'sidequest' && Number.isFinite(n.x)) { cx += n.x; cy += n.y; c++; }
    if (c) { cx /= c; cy /= c; }
    for (const n of ns) {
      const tz = n.store === 'sidequest' ? 140 : -80;
      n.vz = (n.vz || 0) + (tz - (n.z || 0)) * strength * alpha;
      if (n.store === 'sidequest' && c) { n.vx = (n.vx || 0) + (cx - n.x) * strength * alpha; n.vy = (n.vy || 0) + (cy - n.y) * strength * alpha; }
    }
  }
  force.initialize = (n) => { ns = n; };
  return force;
}

// ---- styling ----
function nodeColor(n) { return n.color || (n.store === 'sidequest' ? SQ_VIOLET : ECHO_SKY); }
function nodeVal(n) {                                   // sphere size ~ degree (mirrors nodeRadius's log scale)
  if (n.store === 'sidequest') return 2.4;
  const d = n.degree || 0;
  return Math.max(1, Math.min(9, 1 + Math.log10(d + 1) * 2));
}
function linkColor(l) {
  const s = typeof l.source === 'object' ? l.source : null, t = typeof l.target === 'object' ? l.target : null;
  const cross = l.cross || (s && t && (s.store === 'sidequest') !== (t.store === 'sidequest'));
  if (cross) return 'rgba(196,181,253,0.9)';           // federation thread — bright
  return l.color || 'rgba(120,150,190,0.28)';
}

// ---- the graph instance ----
const Graph = window.ForceGraph3D()(graphEl)
  .backgroundColor('#06070b')
  .nodeColor(nodeColor)
  .nodeVal(nodeVal)
  .nodeOpacity(0.92)
  .nodeResolution(8)
  .nodeRelSize(3)
  .linkColor(linkColor)
  .linkOpacity(0.5)
  .warmupTicks(20)
  .cooldownTime(15000);
Graph.d3Force('core', makeCore3D(0.05));
try { Graph.d3Force('charge').strength(-40); } catch (e) {}   // a touch more spread at corpus scale

// ---- UnrealBloom: the glow the 2D shadowBlur faked, one GPU pass ----
try {
  const bloom = new window.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.25, 0.7, 0.02);
  Graph.postProcessingComposer().addPass(bloom);
} catch (e) { console.warn('[kg3d] bloom failed:', e && e.message); }

// ---- data load: overview (Echo corpus) + shortterm (Side Quest core), merged into one two-source set ----
async function loadGraph() {
  setOverlay('Loading corpus…');
  const nodes = [], links = [], byId = new Map();
  const add = (nd) => { if (!byId.has(nd.id)) { byId.set(nd.id, nd); nodes.push(nd); } return byId.get(nd.id); };
  try {
    const ov = await window.sq.kg.overview();
    if (ov && ov.ok) {
      for (const n of (ov.nodes || [])) add({ id: n.id, store: 'echo', entityType: n.entityType, degree: n.degree, color: n.color, summary: n.summary });
      for (const l of (ov.links || [])) { const s = linkEnd(l.source), t = linkEnd(l.target); if (s != null && t != null) links.push({ source: s, target: t, category: l.category, color: l.color }); }
    }
  } catch (e) { console.warn('[kg3d] overview failed:', e && e.message); }
  try {
    if (window.sq.kg.shortterm) {
      const st = await window.sq.kg.shortterm();
      if (st && st.ok) {
        for (const n of (st.nodes || [])) { const ex = byId.get(n.id); if (ex) { ex.store = 'sidequest'; ex.epistemic = n.epistemic; } else add({ id: n.id, store: 'sidequest', entityType: n.entityType, epistemic: n.epistemic, summary: n.summary }); }
        for (const l of (st.links || [])) { const s = l.source, t = l.target; if (byId.has(s) && byId.has(t)) links.push({ source: s, target: t, category: l.category, relType: l.relType, cross: (byId.get(s).store === 'sidequest') !== (byId.get(t).store === 'sidequest') }); }
      }
    }
  } catch (e) { console.warn('[kg3d] shortterm failed:', e && e.message); }
  Graph.graphData({ nodes, links });
  setOverlay(nodes.length ? null : 'No graph data (Echo engine not connected?)');
  return { nodes, links };
}

// ---- fps HUD ----
let frames = 0, lastT = performance.now(), fps = 0;
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now(); frames++;
  if (now - lastT >= 750) {
    fps = Math.round(frames * 1000 / (now - lastT)); frames = 0; lastT = now;
    const d = Graph.graphData();
    if (hudEl) hudEl.textContent = `3D · ${d.nodes.length} nodes / ${d.links.length} links · ${fps} fps`;
  }
}
tick();

// ---- resize ----
window.addEventListener('resize', () => { Graph.width(window.innerWidth).height(window.innerHeight); });
Graph.width(window.innerWidth).height(window.innerHeight);

// ---- dev handle for CDP verification ----
window.__kg3d = { Graph, reload: loadGraph, fps: () => fps, data: () => Graph.graphData() };

loadGraph();
console.info('[kg3d] surface build phase-1: live two-source data + z-depth core + UnrealBloom');
