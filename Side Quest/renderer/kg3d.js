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

// ============================================================================================================
// ACTIVITY BUS (Phase 2) — the kg:activity gestures, re-authored as GPU scene-object sprites/lines (lowest
// drag). Same event stream as the 2D surface (main.js broadcasts kg:activity to every webContents), so every
// emitter — Slices 2/2b/4 — drives this unchanged. In 3D there's no "in view" gate: a gesture just plays at the
// node's world position and is there when the camera faces it (the 2D far-field "weather" fallback disappears).
// ============================================================================================================
const scene = Graph.scene();
const VHEX = new THREE.Color(SQ_VIOLET).getHex(), SHEX = new THREE.Color(ECHO_SKY).getHex();

const SPARK_TEX = (function () {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'); const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(210,225,255,0.6)'); g.addColorStop(1, 'rgba(210,225,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
})();
function mkSprite(colorHex, opacity) {
  const m = new THREE.SpriteMaterial({ map: SPARK_TEX, color: colorHex, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  return new THREE.Sprite(m);
}
function mkLine(colorHex, opacity) {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const m = new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  return new THREE.Line(g, m);
}
const V3 = (n) => new THREE.Vector3(n.x, n.y, n.z || 0);
function findNode(id) { if (id == null) return null; return Graph.graphData().nodes.find((n) => n.id === id) || null; }
function coreCentroid3D() {
  const ns = Graph.graphData().nodes; let x = 0, y = 0, z = 0, c = 0, ax = 0, ay = 0, az = 0, ac = 0;
  for (const n of ns) { if (!Number.isFinite(n.x)) continue; ax += n.x; ay += n.y; az += (n.z || 0); ac++; if (n.store === 'sidequest') { x += n.x; y += n.y; z += (n.z || 0); c++; } }
  if (c) return new THREE.Vector3(x / c, y / c, z / c);
  if (ac) return new THREE.Vector3(ax / ac, ay / ac, az / ac);
  return new THREE.Vector3();
}

// effect pool: each is { objs:[three objects], born, dur, update(p) }. A light rAF (the fps tick) mutates them;
// three owns the actual render. Objects are added on spawn and disposed on expiry.
const effects = [];
const ACT_CAP = 220;
function addEffect(objs, dur, update) {
  for (const o of objs) scene.add(o);
  effects.push({ objs, born: performance.now(), dur, update });
  if (effects.length > ACT_CAP) { const e = effects.shift(); for (const o of e.objs) { scene.remove(o); if (o.material) o.material.dispose(); if (o.geometry) o.geometry.dispose(); } }
}
function updateEffects(now) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i], p = (now - e.born) / e.dur;
    if (p >= 1) { for (const o of e.objs) { scene.remove(o); if (o.material) o.material.dispose(); if (o.geometry) o.geometry.dispose(); } effects.splice(i, 1); continue; }
    try { e.update(p); } catch (err) { /* drop a bad effect next frame */ }
  }
}

// --- gesture vocabulary (3D scene objects) ---
function gBorn(pos, colorHex) { const s = mkSprite(colorHex, 0.9); s.position.copy(pos); s.scale.setScalar(3); addEffect([s], 750, (p) => { s.scale.setScalar(3 + p * 13); s.material.opacity = 0.9 * (1 - p); }); }
function gEnrich(pos, colorHex) { const s = mkSprite(colorHex, 0.7); s.position.copy(pos); addEffect([s], 640, (p) => { const q = Math.sin(p * Math.PI); s.scale.setScalar(3 + q * 8); s.material.opacity = 0.6 * q; }); }
function gEdge(a, b, colorHex) {
  const ln = mkLine(colorHex, 0.8), pulse = mkSprite(colorHex, 0.9); pulse.scale.setScalar(3);
  addEffect([ln, pulse], 850, (p) => { const grow = Math.min(1, p / 0.7); ln.geometry.setFromPoints([a, a.clone().lerp(b, grow)]); ln.material.opacity = 0.8 * (1 - p * 0.4); const mp = Math.min(1, p / 0.85); pulse.position.copy(a.clone().lerp(b, mp)); pulse.material.opacity = 0.9 * (1 - p); });
}
function gMatch(a, b) {   // recognition arc: core → matched corpus node
  const ln = mkLine(0xc4b5fd, 0.85), pulse = mkSprite(0xe9d5ff, 0.95), flash = mkSprite(SHEX, 0); pulse.scale.setScalar(3.5); flash.position.copy(b); flash.scale.setScalar(4);
  addEffect([ln, pulse, flash], 1000, (p) => { const grow = Math.min(1, p / 0.45); ln.geometry.setFromPoints([a, a.clone().lerp(b, grow)]); ln.material.opacity = 0.85 * (1 - p * 0.4); const mp = Math.min(1, p / 0.5); pulse.position.copy(a.clone().lerp(b, mp)); pulse.material.opacity = 0.95 * (1 - p * 0.5); if (p >= 0.5) { const q = Math.sin((p - 0.5) / 0.5 * Math.PI); flash.scale.setScalar(4 + q * 10); flash.material.opacity = 0.7 * q; } });
}
function gRecall(a) {      // inward wave: corpus node → active core
  const c = coreCentroid3D(), ln = mkLine(SHEX, 0.5), pulse = mkSprite(0xbfe0ff, 0.85); pulse.scale.setScalar(3);
  addEffect([ln, pulse], 950, (p) => { ln.geometry.setFromPoints([a, a.clone().lerp(c, p)]); ln.material.opacity = 0.5 * (1 - p); pulse.position.copy(a.clone().lerp(c, p)); pulse.material.opacity = 0.85 * (1 - p); });
}
function gPromote(a) {     // graduation arc: node → outward from core, locks in
  const c = coreCentroid3D(); let dir = a.clone().sub(c); if (dir.lengthSq() < 1e-4) dir.set(0, 1, 0); dir.normalize();
  const tgt = a.clone().add(dir.multiplyScalar(70)), ln = mkLine(SHEX, 0.6), pulse = mkSprite(0xbfe0ff, 0.9), ring = mkSprite(SHEX, 0); pulse.scale.setScalar(3); ring.position.copy(tgt); ring.scale.setScalar(4);
  addEffect([ln, pulse, ring], 1050, (p) => { const mp = Math.min(1, p / 0.8); ln.geometry.setFromPoints([a, a.clone().lerp(tgt, mp)]); pulse.position.copy(a.clone().lerp(tgt, mp)); pulse.material.opacity = 0.9 * (1 - mp * 0.5); if (p >= 0.8) { const q = Math.sin((p - 0.8) / 0.2 * Math.PI); ring.scale.setScalar(3 + q * 10); ring.material.opacity = 0.8 * q; } });
}
function gSupernova(pos, count) {
  const mag = Math.min(3.2, 1.2 + Math.log2((count || 2))), flash = mkSprite(0xbfe0ff, 0.95), ring = mkSprite(VHEX, 0); flash.position.copy(pos); flash.scale.setScalar(4); ring.position.copy(pos);
  addEffect([flash, ring], 1500, (p) => { flash.scale.setScalar(4 + p * 42 * mag); flash.material.opacity = 0.95 * (1 - p); const q = Math.sin(Math.min(1, p / 0.5) * Math.PI); ring.scale.setScalar(6 + p * 64 * mag); ring.material.opacity = 0.5 * q; });
}

// --- Slice 4 optimistic mint + coalesce, ported to 3D: a pushed birth MINTS its node into graphData near the
// core (front) so it appears + sparks instantly, and a burst >=8 coalesces into one supernova. ---
let _bornBuf = [], _bornTimer = null;
function queueBorn(evt) { _bornBuf.push(evt); if (!_bornTimer) _bornTimer = setTimeout(flushBorn, 320); }
function flushBorn() {
  _bornTimer = null; const batch = _bornBuf.splice(0); mintBorn(batch);
  const uniq = [...new Set(batch.map((e) => e.anchor).filter((a) => a != null))];
  if (uniq.length >= 8) { gSupernova(coreCentroid3D(), uniq.length); }
  else { for (const id of uniq) { const n = findNode(id); if (n) gBorn(V3(n), VHEX); } }
}
function mintBorn(batch) {
  const data = Graph.graphData(), present = new Set(data.nodes.map((n) => n.id)), c = coreCentroid3D(); let minted = 0;
  for (const e of batch) { const id = e.anchor; if (id == null || present.has(id)) continue; present.add(id); data.nodes.push({ id, store: 'sidequest', entityType: 'concept', epistemic: e.epistemic || 'told', x: c.x + (Math.random() - 0.5) * 40, y: c.y + (Math.random() - 0.5) * 40, z: c.z + (Math.random() - 0.5) * 40 }); minted++; }
  if (minted) Graph.graphData(data);
  return minted;
}

// --- dispatcher: route a kg:activity event to its gesture (find the node's world position) ---
function onActivity(evt) {
  if (!evt) return;
  try {
    const k = evt.kind;
    if (k === 'node.born') { queueBorn(evt); return; }
    const a = findNode(evt.anchor), b = evt.anchor2 != null ? findNode(evt.anchor2) : null;
    if (k === 'node.enrich') { if (a) gEnrich(V3(a), new THREE.Color(nodeColor(a)).getHex()); }
    else if (k === 'edge.born' || k === 'edge.promote') { if (a && b) gEdge(V3(a), V3(b), new THREE.Color(nodeColor(a)).getHex()); }
    else if (k === 'match.hit') { if (a && b) gMatch(V3(a), V3(b)); }
    else if (k === 'recall') { if (a) gRecall(V3(a)); }
    else if (k === 'promote') { if (a) gPromote(V3(a)); }
    else if (k === 'node.merge') { if (a) gEnrich(V3(a), VHEX); }   // absorb → a bright pull for now (full absorb: later phase)
    // think / doc.land / news → ambient, deferred to a later phase
  } catch (e) { console.warn('[kg3d] activity', e && e.message); }
}

// ---- fps HUD ----
let frames = 0, lastT = performance.now(), fps = 0;
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now(); frames++;
  updateEffects(now);
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

// ---- subscribe the live activity bus (same channel main.js broadcasts to every webContents) ----
try { if (window.sq && window.sq.kg && typeof window.sq.kg.onActivity === 'function') window.sq.kg.onActivity(onActivity); } catch (e) {}

// ---- dev handle for CDP verification ----
window.__kg3d = { Graph, reload: loadGraph, fps: () => fps, data: () => Graph.graphData(), onActivity, effectsN: () => effects.length };

loadGraph();
console.info('[kg3d] surface build phase-2: activity-bus gestures (scene objects) + Slice 4 mint/coalesce');
