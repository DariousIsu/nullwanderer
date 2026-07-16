/* renderer/kg3d_spike.js — 3D KG spike (throwaway validation, NOT the port).
 *
 * Proves the foundation before re-authoring the 2D draw passes: 3d-force-graph renders the two-source galaxy
 * at real scale with real z-depth (violet core in FRONT, sky corpus receding BEHIND), UnrealBloom glow, and
 * gestures as GPU scene-object sprites (the lowest-drag path — no per-frame 2D canvas). HUD shows live fps.
 * Loaded standalone (no IPC) via CDP navigate; synthetic data approximates the live scale for a perf read.
 */
'use strict';
const THREE = window.THREE;

// ---- synthetic two-source data (~500 nodes, ballpark of the live overview + short-term core) ----
const NCORP = 380, NCORE = 120;
const nodes = [], links = [];
for (let i = 0; i < NCORP; i++) nodes.push({ id: 'e' + i, store: 'echo' });
for (let i = 0; i < NCORE; i++) nodes.push({ id: 's' + i, store: 'sidequest' });
const rnd = (n) => Math.floor(Math.random() * n);
for (let i = 0; i < NCORP * 1.4; i++) { const a = 'e' + rnd(NCORP), b = 'e' + rnd(NCORP); if (a !== b) links.push({ source: a, target: b }); }
for (let i = 0; i < NCORE * 1.6; i++) { const a = 's' + rnd(NCORE), b = 's' + rnd(NCORE); if (a !== b) links.push({ source: a, target: b }); }
for (let i = 0; i < 22; i++) links.push({ source: 's' + rnd(NCORE), target: 'e' + rnd(NCORP) });   // cross-store (federation-ish)

// ---- core force in 3D: short-term cluster cohesion in x/y + a z target that pushes the core to the FRONT
// and the corpus to the BACK, so the two stores separate into real depth (makeCoreForce's 3D descendant). ----
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

// ---- the graph ----
const Graph = window.ForceGraph3D()(document.getElementById('graph3d'))
  .backgroundColor('#06070b')
  .graphData({ nodes, links })
  .nodeColor((n) => (n.store === 'sidequest' ? '#a78bfa' : '#7dd3fc'))
  .nodeVal((n) => (n.store === 'sidequest' ? 2.6 : 1.3))
  .nodeOpacity(0.9)
  .nodeResolution(8)                       // low-poly spheres — cheap
  .linkColor((l) => {
    const s = typeof l.source === 'object' ? l.source : null, t = typeof l.target === 'object' ? l.target : null;
    const cross = s && t && (s.store === 'sidequest') !== (t.store === 'sidequest');
    return cross ? 'rgba(196,181,253,0.9)' : 'rgba(120,150,190,0.28)';
  })
  .linkOpacity(0.45)
  .warmupTicks(24);
Graph.d3Force('core', makeCore3D(0.05));

// ---- UnrealBloom: the glow the 2D shadowBlur faked, now a single GPU pass ----
try {
  const bloom = new window.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.3, 0.7, 0.02);
  Graph.postProcessingComposer().addPass(bloom);
} catch (e) { console.warn('[kg3d] bloom failed:', e && e.message); }

// ---- gestures as GPU scene-object sprites (the lowest-drag path) ----
const scene = Graph.scene();
function sparkTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'); const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(200,220,255,0.65)'); g.addColorStop(1, 'rgba(200,220,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
}
const SPARK_TEX = sparkTexture();
const sparks = [];
function spark(pos) {
  const m = new THREE.SpriteMaterial({ map: SPARK_TEX, color: 0xbfe0ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  const s = new THREE.Sprite(m); s.position.copy(pos); s.scale.setScalar(3); scene.add(s);
  sparks.push({ s, born: performance.now(), dur: 850 });
}
function sparkBurst(n) {
  const ns = Graph.graphData().nodes;
  for (let i = 0; i < n; i++) { const nd = ns[rnd(ns.length)]; if (nd && Number.isFinite(nd.x)) spark(new THREE.Vector3(nd.x, nd.y, nd.z || 0)); }
}

// ---- fps HUD + spark animation (a light rAF that just mutates sprite props; three owns the render loop) ----
let frames = 0, lastT = performance.now(), fps = 0;
const hud = document.getElementById('hud');
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now(); frames++;
  if (now - lastT >= 500) { fps = Math.round(frames * 1000 / (now - lastT)); frames = 0; lastT = now; hud.textContent = `3D · ${nodes.length} nodes / ${links.length} links · ${fps} fps · sparks ${sparks.length}`; }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const sp = sparks[i]; const p = (now - sp.born) / sp.dur;
    if (p >= 1) { scene.remove(sp.s); sp.s.material.dispose(); sparks.splice(i, 1); continue; }
    sp.s.scale.setScalar(3 + p * 11); sp.s.material.opacity = 0.9 * (1 - p);
  }
}
tick();

// steady ambient activity so the perf read includes live gestures
setInterval(() => sparkBurst(3), 350);

window.__kg3d = { Graph, sparkBurst, fps: () => fps, nodeCount: nodes.length, linkCount: links.length };
window.__kg3dFps = () => fps;
console.info('[kg3d] spike up — two-source galaxy, z-depth core/corpus, UnrealBloom, scene-object sparks');
