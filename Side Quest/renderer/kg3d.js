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
const qEl = document.getElementById('q'), ddEl = document.getElementById('dd'), hopsEl = document.getElementById('hops');
const backBtn = document.getElementById('backBtn'), followBtn = document.getElementById('followBtn');
function setBack(on) { if (backBtn) backBtn.hidden = !on; }
let _overlayMsg = null;
function setOverlay(msg, ms) {
  if (!overlayEl) return; _overlayMsg = msg;
  overlayEl.style.display = msg ? 'flex' : 'none'; if (msg) overlayEl.textContent = msg;
  if (msg && ms) setTimeout(() => { if (_overlayMsg === msg) { overlayEl.style.display = 'none'; _overlayMsg = null; } }, ms);
}

const linkEnd = (e) => (e && typeof e === 'object') ? e.id : e;

// ---- 3D core force: the short-term store is a dense inner ORB pulled tight to the centre; the long-term
// corpus is pushed radially OUTWARD toward a shell so it ENVELOPS the core as a diffuse 3D cloud (not a plane
// behind it). Charge repulsion + links give the cloud its thickness/structure. SHELL is tunable. ----
const CLOUD_SHELL = 320;
function makeCore3D(strength = 0.05) {
  let ns = [];
  function force(alpha) {
    let cx = 0, cy = 0, cz = 0, c = 0;
    for (const n of ns) if (n.store === 'sidequest' && Number.isFinite(n.x)) { cx += n.x; cy += n.y; cz += (n.z || 0); c++; }
    if (c) { cx /= c; cy /= c; cz /= c; }
    for (const n of ns) {
      if (!Number.isFinite(n.x)) continue;
      const dx = n.x - cx, dy = n.y - cy, dz = (n.z || 0) - cz, d = Math.hypot(dx, dy, dz) || 1;
      if (n.store === 'sidequest') {                       // inner orb: pull hard to centre
        n.vx = (n.vx || 0) + (cx - n.x) * strength * 1.6 * alpha;
        n.vy = (n.vy || 0) + (cy - n.y) * strength * 1.6 * alpha;
        n.vz = (n.vz || 0) + (cz - (n.z || 0)) * strength * 1.6 * alpha;
      } else {                                             // outer cloud: ease toward the shell radius, all directions
        const f = (CLOUD_SHELL - d) * strength * 0.35 * alpha;
        n.vx = (n.vx || 0) + (dx / d) * f;
        n.vy = (n.vy || 0) + (dy / d) * f;
        n.vz = (n.vz || 0) + (dz / d) * f;
      }
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
  .nodeResolution(6)
  .nodeRelSize(3)
  .nodeLabel((n) => `${n.id}${n.entityType ? ' · ' + n.entityType : ''}${(n.store === 'sidequest' && n.epistemic) ? ' · ' + n.epistemic : ''}`)
  .linkColor(linkColor)
  .linkOpacity(0.5)
  .warmupTicks(20)
  .cooldownTime(15000);
Graph.d3Force('core', makeCore3D(0.05));
try { Graph.d3Force('charge').strength(-40); } catch (e) {}   // a touch more spread at corpus scale

// ---- UnrealBloom: the glow the 2D shadowBlur faked, one GPU pass ----
try {
  const bloom = new window.UnrealBloomPass(new THREE.Vector2(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2)), 0.55, 0.35, 0.2);   // HALF-RES bloom (GPU-memory saver on the shared process) + only bright cores bloom, background stays dark
  Graph.postProcessingComposer().addPass(bloom);
} catch (e) { console.warn('[kg3d] bloom failed:', e && e.message); }

// ---- Follow: camera flies to big pulls + subconscious focus-moves (being "taken to where data erupts") ----
let follow = false;
try { follow = localStorage.getItem('kg3d.follow') === '1'; } catch (e) {}
function setFollow(on) { follow = !!on; try { localStorage.setItem('kg3d.follow', on ? '1' : '0'); } catch (e) {} return follow; }
function flyTo(pos, ms) { try { Graph.cameraPosition({ x: pos.x, y: pos.y, z: pos.z + 190 }, pos, ms || 1100); } catch (e) {} }

// ============================================================================================================
// DATA MODEL (Phase 4/5) — one object store keyed by id (positions persist across walks + mode switches), an
// overview set, a persistent ego WORLD (accumulates walked neighbourhoods, LRU-capped), and the short-term
// layer (always merged as the core). render() assembles graphData for the active mode + short-term. Mirrors the
// 2D full/world/withShortTerm design so ego-walk, Follow, and the reconciler behave the same.
// ============================================================================================================
const objs = new Map();                        // id → node object (single source of truth for position)
let mode = 'overview', focalId = null, submitted = '';
const full = new Set();                         // overview node ids
const overviewLinks = [];                       // overview links
const world = { nodes: new Set(), links: new Map() };   // ego-walked ids + accumulated links
const shortTerm = { nodes: new Set(), links: new Map() };
const WORLD_CAP = 320;

function ensureObj(n, seed) {
  let o = objs.get(n.id);
  if (o) {
    if (n.entityType) o.entityType = n.entityType;
    if (n.color) o.color = n.color;
    if (n.summary) o.summary = n.summary;
    if (typeof n.degree === 'number') o.degree = n.degree;
    if (n.store) o.store = n.store;
    if (n.epistemic) o.epistemic = n.epistemic;
    o.touchedAt = performance.now();
    return o;
  }
  o = { id: n.id, store: n.store || 'echo', entityType: n.entityType, color: n.color, summary: n.summary, degree: n.degree, epistemic: n.epistemic, touchedAt: performance.now() };
  if (seed) { o.x = seed.x + (Math.random() - 0.5) * 40; o.y = seed.y + (Math.random() - 0.5) * 40; o.z = (seed.z || 0) + (Math.random() - 0.5) * 40; }
  objs.set(n.id, o);
  return o;
}

const NODE_CAP = 800;   // hard bound on rendered nodes — the SHARED GPU process also drives video + the VRM avatar,
                        // so an unbounded corpus pull can exhaust it and crash. Keep core + focal + top-degree corpus.
function render() {
  const ids = new Set();
  for (const id of (mode === 'overview' ? full : world.nodes)) ids.add(id);
  for (const id of shortTerm.nodes) ids.add(id);
  let list = []; for (const id of ids) { const o = objs.get(id); if (o) list.push(o); }
  if (list.length > NODE_CAP) {
    const rank = (o) => (o.store === 'sidequest' || o.id === focalId) ? 1e9 : (o.degree || 0);   // never drop the core/focal
    list.sort((a, b) => rank(b) - rank(a));
    list = list.slice(0, NODE_CAP);
  }
  const keep = new Set(list.map((o) => o.id));
  const nodes = []; for (const o of list) { o.isFocal = (o.id === focalId); nodes.push(o); }
  const links = [];
  const linkSrc = mode === 'overview' ? overviewLinks : [...world.links.values()];
  for (const l of linkSrc) if (keep.has(l.source) && keep.has(l.target)) links.push({ source: l.source, target: l.target, category: l.category, color: l.color, relType: l.relType });
  for (const m of shortTerm.links.values()) if (keep.has(m.s) && keep.has(m.t)) links.push({ source: m.s, target: m.t, category: m.category, relType: m.relType });
  Graph.graphData({ nodes, links });
  try { buildTendrils(); } catch (e) {}   // refresh hidden-connection tendrils for the new node set (throttled)
}

async function loadOverview() {
  mode = 'overview'; submitted = ''; focalId = null; setBack(false); setOverlay('Loading corpus…');
  try {
    const ov = await window.sq.kg.overview();
    full.clear(); overviewLinks.length = 0;
    if (ov && ov.ok) {
      for (const n of (ov.nodes || [])) { ensureObj({ id: n.id, store: 'echo', entityType: n.entityType, degree: n.degree, color: n.color, summary: n.summary }); full.add(n.id); }
      for (const l of (ov.links || [])) { const s = linkEnd(l.source), t = linkEnd(l.target); if (s != null && t != null) overviewLinks.push({ source: s, target: t, category: l.category, color: l.color }); }
    }
  } catch (e) { console.warn('[kg3d] overview failed:', e && e.message); }
  await pollShortTerm(true);                     // fold in the short-term core (render below paints both)
  setOverlay((full.size || shortTerm.nodes.size) ? null : 'No graph data (Echo engine not connected?)');
  render();
  try { Graph.zoomToFit(600, 60); } catch (e) {}
}

function mergeEgo(res) {
  const incoming = res.nodes || [], incLinks = res.links || [];
  const focal = incoming.find((n) => n.isFocal) || incoming[0] || null;
  if (focal) focalId = focal.id;
  let seed = coreCentroid3D(); const ef = focalId && objs.get(focalId);
  if (ef && Number.isFinite(ef.x)) seed = { x: ef.x, y: ef.y, z: ef.z || 0 };
  const connectedTo = new Map();
  for (const l of incLinks) { const a = linkEnd(l.source), b = linkEnd(l.target); if (a != null && b != null) { if (!connectedTo.has(a)) connectedTo.set(a, b); if (!connectedTo.has(b)) connectedTo.set(b, a); } }
  for (const n of incoming) {
    let s = seed; const nbr = connectedTo.get(n.id), no = nbr && objs.get(nbr);
    if (no && Number.isFinite(no.x)) s = { x: no.x, y: no.y, z: no.z || 0 };
    ensureObj({ id: n.id, store: n.store || 'echo', entityType: n.entityType, color: n.color, summary: n.summary, degree: n.degree }, objs.has(n.id) ? null : s);
    world.nodes.add(n.id);
  }
  for (const l of incLinks) { const s = linkEnd(l.source), t = linkEnd(l.target); if (s == null || t == null) continue; const key = s + '→' + t + '::' + (l.relType || ''); if (!world.links.has(key)) world.links.set(key, { source: s, target: t, relType: l.relType, color: l.color, category: l.category }); }
  if (world.nodes.size > WORLD_CAP) {
    const arr = [...world.nodes].filter((id) => id !== focalId).map((id) => objs.get(id)).filter(Boolean).sort((a, b) => a.touchedAt - b.touchedAt);
    let drop = world.nodes.size - WORLD_CAP;
    for (const o of arr) { if (drop-- <= 0) break; world.nodes.delete(o.id); }
  }
}

async function focus(name, opt = {}) {
  const q = opt.query || name; submitted = name;
  if (qEl) qEl.value = name; if (ddEl) ddEl.hidden = true; setOverlay('Walking the graph…');
  try {
    const res = await window.sq.kg.ego(q, Number(hopsEl ? hopsEl.value : 2));
    if (!res || !res.ok || res.error) { setOverlay((res && res.error) || 'not found', 2000); return; }
    mergeEgo(res); mode = 'ego'; setBack(true); setOverlay(null); render();
    const f = objs.get(focalId); if (f && Number.isFinite(f.x)) flyTo(V3(f), 900);
  } catch (e) { setOverlay(String(e.message || e), 2000); }
}

// short-term RECONCILER (Phase 5): re-fetch the store, add new / prune gone, refresh links. The Slice-4 mint
// gives instant new-write liveness; this backfills non-pushed writes + prunes removed ones. A pruned id keeps
// its object only if the overview or a walked world node still references it.
let _stInit = false;
async function pollShortTerm(initial) {
  try {
    if (!(window.sq && window.sq.kg && window.sq.kg.shortterm)) return false;
    const st = await window.sq.kg.shortterm(); if (!st || !st.ok) return false;
    const seen = new Set(); const c = coreCentroid3D(); let changed = false;
    for (const n of (st.nodes || [])) { seen.add(n.id); const had = shortTerm.nodes.has(n.id); ensureObj({ id: n.id, store: 'sidequest', entityType: n.entityType, epistemic: n.epistemic, summary: n.summary }, objs.has(n.id) ? null : c); shortTerm.nodes.add(n.id); if (!had) changed = true; }
    for (const id of [...shortTerm.nodes]) if (!seen.has(id)) { shortTerm.nodes.delete(id); changed = true; if (!world.nodes.has(id) && !full.has(id)) objs.delete(id); }
    shortTerm.links.clear();
    for (const l of (st.links || [])) shortTerm.links.set(l.source + '>' + l.target, { s: l.source, t: l.target, relType: l.relType, category: l.category });
    _stInit = true;
    if (changed && !initial) render();
    return changed;
  } catch (e) { return false; }
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
  if (follow) flyTo(pos, 1100);   // camera is taken to the eruption (the "flies to big pulls" behavior)
  const mag = Math.min(3.2, 1.2 + Math.log2((count || 2))), flash = mkSprite(0xbfe0ff, 0.95), ring = mkSprite(VHEX, 0); flash.position.copy(pos); flash.scale.setScalar(4); ring.position.copy(pos);
  addEffect([flash, ring], 1500, (p) => { flash.scale.setScalar(4 + p * 42 * mag); flash.material.opacity = 0.95 * (1 - p); const q = Math.sin(Math.min(1, p / 0.5) * Math.PI); ring.scale.setScalar(6 + p * 64 * mag); ring.material.opacity = 0.5 * q; });
}
function gAbsorb(pos, count) {                 // dedup merge: duplicate motes converge inward, canonical blooms
  const k = Math.min(6, 2 + (count || 2));
  for (let i = 0; i < k; i++) {
    const off = new THREE.Vector3(hashSeed('ax' + i + pos.x) * 2 - 1, hashSeed('ay' + i + pos.y) * 2 - 1, hashSeed('az' + i + pos.z) * 2 - 1).multiplyScalar(26 + 22 * hashSeed('r' + i));
    const start = pos.clone().add(off), s = mkSprite(VHEX, 0.85); s.scale.setScalar(2.5);
    addEffect([s], 1000, (p) => { const e = p * p; s.position.copy(start.clone().lerp(pos, e)); s.material.opacity = 0.85 * (1 - p * 0.6); s.scale.setScalar(2.5 * (1 - p * 0.4)); });
  }
  const bloom = mkSprite(VHEX, 0); bloom.position.copy(pos);
  addEffect([bloom], 1000, (p) => { const q = Math.sin(p * Math.PI); bloom.scale.setScalar(4 + q * 10); bloom.material.opacity = 0.7 * q; });
}
function gThink() {                            // ambient heartbeat — a faint mote drifting near the core (throttled upstream)
  const c = coreCentroid3D(), s = mkSprite(VHEX, 0.3);
  s.position.set(c.x + (Math.random() - 0.5) * 80, c.y + (Math.random() - 0.5) * 80, c.z + (Math.random() - 0.5) * 80); s.scale.setScalar(2);
  addEffect([s], 1200, (p) => { const q = Math.sin(p * Math.PI); s.material.opacity = 0.3 * q; s.scale.setScalar(2 + q * 3); });
}

// --- neuron aesthetic (Phase 6): hidden-connection TENDRILS from hubs + a distant STARFIELD. GPU-cheap in 3D
// (uncapped vs the 2D top-40 cap): one LineSegments buffer, positions refreshed each frame from node motion. ---
function hashSeed(str) { let h = 2166136261; const s = String(str); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }
let tendrilSpecs = [], tendrilGeo = null, tendrilLines = null, _tendrilAt = 0;
function buildTendrils(force) {
  const now = performance.now(); if (!force && now - _tendrilAt < 700) return; _tendrilAt = now;
  const ns = Graph.graphData().nodes;
  const hubs = ns.filter((n) => (n.degree || 0) > 6).sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 60);
  tendrilSpecs = [];
  for (const n of hubs) {
    const K = Math.max(2, Math.min(7, Math.floor(Math.log2((n.degree || 2)))));
    const baseLen = 8 + Math.log10((n.degree || 1) + 1) * 22;
    for (let i = 0; i < K; i++) {
      const h1 = hashSeed(n.id + '#' + i), h2 = hashSeed(n.id + '@' + i), h3 = hashSeed(n.id + '$' + i);
      const dir = new THREE.Vector3(h1 * 2 - 1, h2 * 2 - 1, h3 * 2 - 1); if (dir.lengthSq() < 1e-3) dir.set(0, 1, 0); dir.normalize();
      tendrilSpecs.push({ node: n, dir, len: baseLen * (0.6 + 0.6 * h1), color: new THREE.Color(nodeColor(n)) });
    }
  }
  if (tendrilLines) { scene.remove(tendrilLines); tendrilGeo.dispose(); tendrilLines.material.dispose(); tendrilLines = null; tendrilGeo = null; }
  const N = tendrilSpecs.length; if (!N) return;
  const pos = new Float32Array(N * 6), col = new Float32Array(N * 6);
  for (let i = 0; i < N; i++) { const c = tendrilSpecs[i].color; col[i * 6] = c.r; col[i * 6 + 1] = c.g; col[i * 6 + 2] = c.b; col[i * 6 + 3] = 0; col[i * 6 + 4] = 0; col[i * 6 + 5] = 0; }   // bright at hub → dark (invisible) at tip
  tendrilGeo = new THREE.BufferGeometry();
  tendrilGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  tendrilGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  tendrilLines = new THREE.LineSegments(tendrilGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(tendrilLines);
}
function updateTendrils() {
  if (!tendrilLines || !tendrilSpecs.length) return;
  const pos = tendrilGeo.attributes.position.array;
  for (let i = 0; i < tendrilSpecs.length; i++) {
    const s = tendrilSpecs[i], n = s.node; if (!Number.isFinite(n.x)) continue; const bz = n.z || 0;
    pos[i * 6] = n.x; pos[i * 6 + 1] = n.y; pos[i * 6 + 2] = bz;
    pos[i * 6 + 3] = n.x + s.dir.x * s.len; pos[i * 6 + 4] = n.y + s.dir.y * s.len; pos[i * 6 + 5] = bz + s.dir.z * s.len;
  }
  tendrilGeo.attributes.position.needsUpdate = true;
}
(function addStarfield() {
  const N = 1400, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { const r = 700 + Math.random() * 1500, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1); pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th); pos[i * 3 + 2] = r * Math.cos(ph); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x5a6a85, size: 1.1, sizeAttenuation: false, transparent: true, opacity: 0.22, depthWrite: false })));
})();

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
  const c = coreCentroid3D(); let minted = 0;
  for (const e of batch) { const id = e.anchor; if (id == null || objs.has(id)) continue; ensureObj({ id, store: 'sidequest', entityType: 'concept', epistemic: e.epistemic || 'told' }, c); shortTerm.nodes.add(id); minted++; }
  if (minted) render();
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
    else if (k === 'node.merge') { if (a) gAbsorb(V3(a), evt.count); }   // dedup absorb: duplicates collapse inward
    else if (k === 'think') { gThink(); }                                // ambient heartbeat (throttled upstream)
    // doc.land / news → ambient inflow, deferred (no emitter fires them yet)
  } catch (e) { console.warn('[kg3d] activity', e && e.message); }
}

// ---- fps HUD ----
let frames = 0, lastT = performance.now(), fps = 0;
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now(); frames++;
  updateEffects(now);
  updateTendrils();
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

// subconscious focus-move: she's walking the graph; brighten the touched node, and (Follow) fly the camera to it.
function onFocusMove(p) {
  if (!p || !p.anchor) return;
  const n = findNode(p.anchor);
  if (n) { gEnrich(V3(n), new THREE.Color(nodeColor(n)).getHex()); if (follow) flyTo(V3(n)); }
}

// ---- subscribe the live channels (same broadcasts main.js sends to every webContents) ----
try { if (window.sq && window.sq.kg && typeof window.sq.kg.onActivity === 'function') window.sq.kg.onActivity(onActivity); } catch (e) {}
try { if (window.sq && window.sq.kg && typeof window.sq.kg.onFocusMove === 'function') window.sq.kg.onFocusMove(onFocusMove); } catch (e) {}

// ---- search dropdown + navigation wiring ----
const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
let hits = [], activeIdx = 0, _searchT = null;
function renderDropdown() {
  if (!ddEl) return;
  if (!hits.length) { ddEl.hidden = true; return; }
  ddEl.hidden = false;
  ddEl.innerHTML = hits.map((h, i) => `<div class="hit${i === activeIdx ? ' on' : ''}" data-i="${i}"><span class="swatch" style="background:${h.color || '#7dd3fc'}"></span><span class="nm">${esc(h.name)}</span><span class="ty">${esc(h.entity_type)}</span></div>`).join('');
  ddEl.querySelectorAll('.hit').forEach((el) => el.addEventListener('mousedown', (e) => { e.preventDefault(); focus(hits[Number(el.dataset.i)].name); }));
}
if (qEl) {
  qEl.addEventListener('input', () => {
    const v = qEl.value.trim();
    if (v.length < 2) { hits = []; if (ddEl) ddEl.hidden = true; return; }
    clearTimeout(_searchT); _searchT = setTimeout(async () => { try { const r = await window.sq.kg.search(v); hits = (r && r.hits) || []; activeIdx = 0; renderDropdown(); } catch (e) { hits = []; if (ddEl) ddEl.hidden = true; } }, 160);
  });
  qEl.addEventListener('keydown', (e) => {
    if (!ddEl || ddEl.hidden || !hits.length) { if (e.key === 'Enter' && qEl.value.trim()) focus(qEl.value.trim()); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = (activeIdx + 1) % hits.length; renderDropdown(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = (activeIdx - 1 + hits.length) % hits.length; renderDropdown(); }
    else if (e.key === 'Enter') { e.preventDefault(); hits[activeIdx] ? focus(hits[activeIdx].name) : focus(qEl.value.trim()); }
    else if (e.key === 'Escape') ddEl.hidden = true;
  });
  document.addEventListener('mousedown', (e) => { if (ddEl && qEl.parentElement && !qEl.parentElement.contains(e.target)) ddEl.hidden = true; });
}
if (hopsEl) hopsEl.addEventListener('change', () => { if (mode === 'ego' && submitted) focus(submitted); });
if (backBtn) backBtn.addEventListener('click', () => { if (qEl) qEl.value = ''; loadOverview(); });
if (followBtn) {
  const paint = () => { followBtn.classList.toggle('on', follow); followBtn.innerHTML = follow ? 'Following &#9209;' : 'Follow &#9654;'; };
  paint();
  followBtn.addEventListener('click', () => { setFollow(!follow); paint(); });
}
Graph.onNodeClick((n) => { if (n && n.id != null) focus(n.id); });
setInterval(() => pollShortTerm(false), 5000);   // short-term reconciler (liveness + prune)

// ---- dev handle for CDP verification ----
window.__kg3d = { Graph, reload: loadOverview, focus, fps: () => fps, data: () => Graph.graphData(), onActivity, onFocusMove, effectsN: () => effects.length, tendrilN: () => tendrilSpecs.length, setFollow, mode: () => mode, worldN: () => world.nodes.size, camZ: () => Graph.cameraPosition().z };

loadOverview();
console.info('[kg3d] surface build phase-6: tendrils + starfield + full absorb + think ambient (baseline complete)');
