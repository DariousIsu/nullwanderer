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

// ---- MEMORY-ACTIVITY LOG (right dock): a live, color-coded running feed of every DB action on the kg:activity
// bus — short-term (ST, violet) + long-term (LT, sky). Fed from onActivity, so it mirrors exactly what drives
// the gestures. XSS-safe (textContent, no innerHTML); capped ring. ----
const logFeed = document.getElementById('logfeed'), logCount = document.getElementById('logcount');
const LOG_CAP = 250;
let _logN = 0;
const KIND_META = {
  'node.born': ['born', '#34d399'], 'node.enrich': ['enrich', '#2dd4bf'], 'node.merge': ['merge', '#fb923c'],
  'node.promote': ['promote', '#fbbf24'], 'node.degrade': ['degrade', '#f87171'],
  'edge.born': ['link', '#60a5fa'], 'edge.promote': ['link+', '#818cf8'], 'edge.prune': ['unlink', '#94a3b8'],
  'match.hit': ['match', '#c4b5fd'], 'recall': ['recall', '#22d3ee'], 'promote': ['promote', '#fbbf24'],
  'think': ['think', '#64748b'], 'doc.land': ['doc', '#a3e635'], 'news': ['news', '#f472b6'], 'observe': ['observe', '#a8a29e'],
  'audit.clean': ['clean', '#facc15'], 'note': ['note', '#cbd5e1'], 'reflect': ['reflect', '#f0abfc'], 'self': ['self', '#fda4af'],
  'hear': ['hear', '#a5b4fc'], 'say': ['say', '#fda4af'],
};
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
function logActivity(evt) {
  if (!logFeed || !evt || !evt.kind) return;
  const meta = KIND_META[evt.kind] || [evt.kind, '#94a3b8'];
  const st = evt.db === 'sidequest';
  const d = new Date();
  const row = document.createElement('div');
  row.className = 'logrow'; row.style.borderLeftColor = st ? '#a78bfa' : '#38bdf8';
  const mk = (cls, text, color) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; if (color) s.style.color = color; return s; };
  row.appendChild(mk('t', pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())));
  row.appendChild(mk('db ' + (st ? 'st' : 'lt'), st ? 'ST' : 'LT'));
  row.appendChild(mk('k', meta[0], meta[1]));
  let txt = evt.anchor != null ? String(evt.anchor) : '';
  if (evt.anchor2 != null) txt += ' → ' + String(evt.anchor2);
  if (evt.count && evt.count > 1) txt += ' ×' + evt.count;
  row.appendChild(mk('a', txt));
  logFeed.insertBefore(row, logFeed.firstChild);
  _logN++; if (logCount) logCount.textContent = _logN;
  while (logFeed.childElementCount > LOG_CAP) logFeed.removeChild(logFeed.lastChild);
}

// ---- 3D core force: the short-term store is a dense inner ORB pulled tight to the centre; the long-term
// corpus is pushed radially OUTWARD toward a shell so it ENVELOPS the core as a diffuse 3D cloud (not a plane
// behind it). Charge repulsion + links give the cloud its thickness/structure. SHELL is tunable. ----
// SHELL CONTAINMENT. The easing coefficient was 0.35 when the panel drew ~200 nodes. Charge repulsion is a
// many-body sum that grows with N while this spring does not, so at 1001 nodes it lost: measured live, the
// corpus settled at median radius 954 against a 320 target and the camera retreated to 4177 to see it, which
// is how 552 of 1001 nodes ended up SMALLER THAN ONE PIXEL. The structure was never wrong — short-term orb
// inside, corpus enveloping it — it was just inflated past the point of being visible.
//
// THREE BANDS, not two (Lucas: "short term needs to be better defined as a separate region, that region is
// also where Zoe personality lives"). Innermost: her personality ring — self_model rows on deterministic
// orbits around the centroid, sprung hard so the ring holds its shape. Then the short-term orb, CAPPED at
// ORB_R rather than merely pulled centreward, because a soft pull leaves stragglers at r≈318 while the corpus
// starts at 377 — statistically separate, visually one continuous field. A hard-edged orb inside an empty
// moat is what makes the region READ as a region; the membrane sphere draws that edge.
const CLOUD_SHELL = 420, ORB_R = 175, ZOE_RING = 60;
// The live centroid of the orb, written by the core force each tick — the membrane, the Zoe anchor and the
// personality orbits all follow it, so the whole region drifts as one body when the sim breathes.
const _coreCen = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
function makeCore3D(strength = 0.05) {
  let ns = [];
  function force(alpha) {
    let cx = 0, cy = 0, cz = 0, c = 0;
    for (const n of ns) if (n.store === 'sidequest' && !n.zoe && Number.isFinite(n.x)) { cx += n.x; cy += n.y; cz += (n.z || 0); c++; }
    if (c) { cx /= c; cy /= c; cz /= c; }
    _coreCen.set(cx, cy, cz);                              // membrane + anchor follow the live centroid
    for (const n of ns) {
      if (!Number.isFinite(n.x)) continue;
      const dx = n.x - cx, dy = n.y - cy, dz = (n.z || 0) - cz, d = Math.hypot(dx, dy, dz) || 1;
      if (n.zoe) {                                         // personality ring: spring to its own orbit point
        const tx = cx + n.zoeOff.x, ty = cy + n.zoeOff.y, tz = cz + n.zoeOff.z, k = strength * 6 * alpha;
        n.vx = (n.vx || 0) + (tx - n.x) * k;
        n.vy = (n.vy || 0) + (ty - n.y) * k;
        n.vz = (n.vz || 0) + (tz - (n.z || 0)) * k;
      } else if (n.store === 'sidequest') {                // inner orb: pull to centre, HARD-capped at the membrane
        n.vx = (n.vx || 0) + (cx - n.x) * strength * 1.6 * alpha;
        n.vy = (n.vy || 0) + (cy - n.y) * strength * 1.6 * alpha;
        n.vz = (n.vz || 0) + (cz - (n.z || 0)) * strength * 1.6 * alpha;
        if (d > ORB_R) { const f = (ORB_R - d) * strength * 3.2 * alpha; n.vx += (dx / d) * f; n.vy += (dy / d) * f; n.vz += (dz / d) * f; }
      } else {                                             // outer cloud: ease toward the shell radius, all directions
        const f = (CLOUD_SHELL - d) * strength * 1.1 * alpha;
        n.vx = (n.vx || 0) + (dx / d) * f;
        n.vy = (n.vy || 0) + (dy / d) * f;
        n.vz = (n.vz || 0) + (dz / d) * f;
      }
    }
  }
  force.initialize = (n) => { ns = n; };
  return force;
}
// Charge is the other half of the same problem: -40 per node is a sensible spread at 200 nodes and a blast at
// 1000. Scale it down as the cloud fills so density can rise without the galaxy inflating with it.
function chargeFor(n) { return -40 / Math.max(1, Math.sqrt(n / 250)); }

// ============================================================================================================
// EVIDENCE ENCODING — the object model says a thing is real because it has been ENCOUNTERED, and that each
// further independent source raises certainty. The surface used to draw all of that identically: a name one
// stray filing mentioned once sat the same size and brightness as one forty documents agree on. These three
// functions are where that stops. main attaches `prov` per node (lib/kg_provenance.js).
//
//   SIZE  = corroboration. Encounters make a node heavier, so the well-attested corpus reads as mass.
//   ALPHA = how much anyone credible has actually vouched for it, in four honest steps.
//
// The ghost step matters most and is the uncomfortable one: ~61% of local entities have NO encounter at all
// (the graph-walk mints them; nothing records where they came from). Drawing them at full strength was the
// surface asserting a confidence the data has never had. Now they show as what they are — present, unsourced.
// ============================================================================================================
const EV_GHOST = 0.34, EV_WEAK = 0.58, EV_ORDINARY = 0.84, EV_ELSEWHERE = 0.78, EV_SOLID = 1.0;
// "The backend told us nothing about evidence" and "the evidence log says nothing about this node" are
// different facts, and a surface built on that exact distinction must not collapse them. Until at least one
// payload carries provenance — an older main process, a failed handler — nothing is ghosted at all.
let _provSupplied = false;
function evidenceAlpha(n) {
  if (n && n.zoe) return EV_SOLID;                 // her own identity is not an encounter-graded claim about the world
  if (!_provSupplied) return EV_SOLID;
  const p = n && n.prov;
  if (p && p.encounters) {
    if (p.authoritative > 0) return EV_SOLID;    // an official/operator record vouched for it
    if (p.ordinary > 0) return EV_ORDINARY;      // ordinary sources only
    return EV_WEAK;                              // unknown/stated authority only — "go look" (encounters.js)
  }
  // NO LOCAL ENCOUNTER, and what that means depends entirely on which store the node is from. In the local
  // short-term store it is the real defect: the graph-walk mints entities without recording where they came
  // from, so a missing encounter genuinely means nobody knows why this exists — ghost it. For an Echo corpus
  // node it means almost nothing: 1.76M entities were bulk-imported long before this log existed and carry
  // their provenance in Echo's own citations, which this read has never looked at. Dimming those would be
  // the surface asserting absence of evidence from evidence of absence — the exact error the object model
  // exists to prevent. Measured live: it would have ghosted 473 of 525 corpus nodes on a false premise.
  return (n && n.store === 'sidequest') ? EV_GHOST : EV_ELSEWHERE;
}
function provChanged(a, b) {
  if (!a || !b) return a !== b;
  return a.encounters !== b.encounters || a.authoritative !== b.authoritative || a.ordinary !== b.ordinary || a.refuted !== b.refuted;
}
let _provDirty = false;

// ---- styling ----
// An honestly-unknown local object should not wear the confident core violet. T5 made `unknown` a real
// answer ("nobody said") rather than a silent default, so it gets its own recessive slate in both stores.
const UNKNOWN_GREY = '#6b7280';
const isUnknownType = (t) => { const s = String(t || '').toLowerCase(); return s === 'unknown' || s === ''; };
// Her personality by register — rose family anchored on the 'self' log colour, warm against the violet orb
// and the sky corpus so the innermost ring reads as a different KIND of thing, not more data.
const ZOE_ROSE = '#fda4af';
const ZOE_COLOR = { identity: '#fda4af', value: '#fbbf24', opinion: '#22d3ee', preference: '#c4b5fd', taste: '#f472b6', trait: '#2dd4bf', insight: '#94a3b8' };
function nodeColor(n) {
  if (n.zoe) return ZOE_COLOR[n.entityType] || ZOE_ROSE;
  if (n.color) return n.color;
  if (isUnknownType(n.entityType)) return UNKNOWN_GREY;
  return n.store === 'sidequest' ? SQ_VIOLET : ECHO_SKY;
}
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
  .nodeThreeObject(() => new THREE.Object3D())   // no per-node geometry at all — nodes render as ONE Points cloud (lean)
  .linkColor(linkColor)
  .linkOpacity(0.5)
  .warmupTicks(20)
  .cooldownTime(15000);
Graph.d3Force('core', makeCore3D(0.05));
try { Graph.d3Force('charge').strength(-40); } catch (e) {}   // a touch more spread at corpus scale

// ---- UnrealBloom is OFF BY DEFAULT. It's a heavy per-frame multi-target postprocess, and the KG surface
// shares ONE Electron GPU process with live video + the VRM avatar — a full bloom pass CRASHED that shared
// process (2026-07-12). Opt in only after proving headroom (localStorage kg3d.bloom='1'); even then half-res +
// high threshold. Without it the scene still has additive gesture/tendril glow, just no postprocessing bloom. ----
let bloomOn = false; try { bloomOn = localStorage.getItem('kg3d.bloom') === '1'; } catch (e) {}
if (bloomOn) {
  try {
    const bloom = new window.UnrealBloomPass(new THREE.Vector2(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2)), 0.55, 0.35, 0.2);
    Graph.postProcessingComposer().addPass(bloom);
  } catch (e) { console.warn('[kg3d] bloom failed:', e && e.message); }
}
// WebGL context-loss guard: a GPU hiccup on the shared process must NOT hard-crash the surface. Swallow the
// default (which would kill the context permanently) so it can restore, and re-render on recovery.
try {
  const cvEl = Graph.renderer().domElement;
  cvEl.addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.warn('[kg3d] WebGL context lost — preventing hard-crash, awaiting restore'); }, false);
  cvEl.addEventListener('webglcontextrestored', () => { console.info('[kg3d] WebGL context restored'); try { render(); } catch (e) {} }, false);
} catch (e) {}

// ---- Follow: camera flies to big pulls + subconscious focus-moves (being "taken to where data erupts") ----
let follow = false;
try { follow = localStorage.getItem('kg3d.follow') === '1'; } catch (e) {}
function setFollow(on) { follow = !!on; try { localStorage.setItem('kg3d.follow', on ? '1' : '0'); } catch (e) {} return follow; }
function flyTo(pos, ms) { try { Graph.cameraPosition({ x: pos.x, y: pos.y, z: pos.z + 190 }, pos, ms || 1100); } catch (e) {} }

// OWN FIT, because Graph.zoomToFit() is dead on this surface: it sizes the view from each node's
// nodeThreeObject, and the lean rebuild made those empty Object3Ds with no geometry to measure. It fails
// silently — it just leaves the camera wherever it was, which is why the corpus kept being viewed from 4177
// units away. Same root cause as the missing hover labels: the library can't see nodes it doesn't draw.
function fitView(ms) {
  try {
    const ns = Graph.graphData().nodes;
    const c = coreCentroid3D();
    let R = 0;
    for (const n of ns) if (Number.isFinite(n.x)) R = Math.max(R, Math.hypot(n.x - c.x, n.y - c.y, (n.z || 0) - c.z));
    if (!R) return;
    const fov = (Graph.camera().fov || 75) * Math.PI / 180;
    const D = Math.max(320, (R * 1.12) / Math.sin(fov / 2));      // fit the bounding sphere, with a little air
    const cam = Graph.cameraPosition();
    let dx = cam.x - c.x, dy = cam.y - c.y, dz = cam.z - c.z;
    const L = Math.hypot(dx, dy, dz) || 1;
    if (L < 1e-3) { dx = 0; dy = 0.35; dz = 1; }                  // keep the operator's current angle, change only range
    const k = D / (Math.hypot(dx, dy, dz) || 1);
    Graph.cameraPosition({ x: c.x + dx * k, y: c.y + dy * k, z: c.z + dz * k }, c, ms == null ? 900 : ms);
  } catch (e) {}
}

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
const zoeSet = new Set();                       // her self_model ring — outside shortTerm so the reconciler can't prune identity
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
    if (n.prov) { _provSupplied = true; if (provChanged(o.prov, n.prov)) _provDirty = true; o.prov = n.prov; }
    o.touchedAt = performance.now();
    return o;
  }
  if (n.prov) { _provSupplied = true; _provDirty = true; }
  o = { id: n.id, store: n.store || 'echo', entityType: n.entityType, color: n.color, summary: n.summary, degree: n.degree, epistemic: n.epistemic, prov: n.prov, touchedAt: performance.now() };
  if (seed) { o.x = seed.x + (Math.random() - 0.5) * 40; o.y = seed.y + (Math.random() - 0.5) * 40; o.z = (seed.z || 0) + (Math.random() - 0.5) * 40; }
  objs.set(n.id, o);
  return o;
}

const NODE_CAP = 2000;  // instanced Points render cheaply (tens of thousands feasible); the real limiter is the
                        // CPU force sim, so keep a sane bound. Keep core + focal + top-degree corpus, drop the tail.
function render() {
  const ids = new Set();
  for (const id of (mode === 'overview' ? full : world.nodes)) ids.add(id);
  for (const id of shortTerm.nodes) ids.add(id);
  for (const id of zoeSet) ids.add(id);          // the personality ring is in every view — identity doesn't scope out
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
  try { Graph.d3Force('charge').strength(chargeFor(nodes.length)); } catch (e) {}   // spread must not grow with density
  try { buildNodeCloud(); } catch (e) {}   // rebuild the instanced Points cloud for the new node set
  try { buildTendrils(); } catch (e) {}    // refresh hidden-connection tendrils (throttled)
}

async function loadOverview() {
  mode = 'overview'; submitted = ''; focalId = null; setBack(false); setOverlay('Loading corpus…');
  try {
    const ov = await window.sq.kg.overview();
    full.clear(); overviewLinks.length = 0;
    if (ov && ov.ok) {
      for (const n of (ov.nodes || [])) { ensureObj({ id: n.id, store: 'echo', entityType: n.entityType, degree: n.degree, color: n.color, summary: n.summary, prov: n.prov }); full.add(n.id); }
      for (const l of (ov.links || [])) { const s = linkEnd(l.source), t = linkEnd(l.target); if (s != null && t != null) overviewLinks.push({ source: s, target: t, category: l.category, color: l.color }); }
    }
  } catch (e) { console.warn('[kg3d] overview failed:', e && e.message); }
  await pollShortTerm(true);                     // fold in the short-term core (render below paints both)
  setOverlay((full.size || shortTerm.nodes.size) ? null : 'No graph data (Echo engine not connected?)');
  render();
  // Fit once now and again once the sim has actually settled — at load the nodes are still flying outward,
  // so a single early fit frames a cloud that no longer exists a few seconds later.
  fitView(0);
  setTimeout(() => { if (mode === 'overview') fitView(1200); }, 4500);
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
    ensureObj({ id: n.id, store: n.store || 'echo', entityType: n.entityType, color: n.color, summary: n.summary, degree: n.degree, prov: n.prov }, objs.has(n.id) ? null : s);
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
    for (const n of (st.nodes || [])) { seen.add(n.id); const had = shortTerm.nodes.has(n.id); ensureObj({ id: n.id, store: 'sidequest', entityType: n.entityType, epistemic: n.epistemic, summary: n.summary, prov: n.prov }, objs.has(n.id) ? null : c); shortTerm.nodes.add(n.id); if (!had) changed = true; }
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

// ============================================================================================================
// NODE CLOUD (lean rendering) — every node is a glow point-sprite in ONE THREE.Points object: a single draw
// call that scales to tens of thousands, far cheaper than per-node sphere meshes AND no full-screen bloom (the
// thing that crashed the shared GPU). Per-point size (hubs bigger) via a tiny ShaderMaterial; soft glow texture
// gives the neuron look with NormalBlending (no additive wash). Positions sync from the force sim each frame.
// ============================================================================================================
const NODE_TEX = (function () {
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.28, 'rgba(255,255,255,0.92)'); g.addColorStop(0.55, 'rgba(255,255,255,0.32)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
})();
const nodeMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: NODE_TEX }, uOpacity: { value: 0.96 } },
  vertexShader: 'attribute float size; attribute vec3 aColor; attribute float aAlpha; varying vec3 vColor; varying float vAlpha; void main(){ vColor=aColor; vAlpha=aAlpha; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=size*(560.0/max(1.0,-mv.z)); gl_Position=projectionMatrix*mv; }',
  fragmentShader: 'uniform sampler2D map; uniform float uOpacity; varying vec3 vColor; varying float vAlpha; void main(){ vec4 t=texture2D(map, gl_PointCoord); if(t.a<0.02) discard; gl_FragColor=vec4(vColor, t.a*uOpacity*vAlpha); }',
  transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending,
});
let nodeCloud = null, nodeGeo = null, nodeIndex = [];
// Base weight is structural (how connected), the bonus is evidential (how corroborated). They are genuinely
// different facts about a node and both belong on screen: a hub everyone links to but nobody sourced should
// not look like a modest object forty documents independently agree on.
function nodePointSize(n) {
  if (n.zoe) return 4.5 + (n.importance || 0.6) * 4;      // personality motes: small, weighted by importance
  const base = n.store === 'sidequest' ? 7 : Math.max(5, Math.min(26, 6 + Math.log10((n.degree || 0) + 1) * 8));
  const enc = (n.prov && n.prov.encounters) || 0;
  return Math.min(34, base + (enc ? Math.log2(1 + enc) * 1.7 : 0));
}
function buildNodeCloud() {
  const ns = Graph.graphData().nodes; nodeIndex = ns; const N = ns.length;
  if (nodeCloud) { scene.remove(nodeCloud); nodeGeo.dispose(); nodeCloud = null; nodeGeo = null; }
  if (!N) return;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const n = ns[i], c = new THREE.Color(nodeColor(n));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; size[i] = nodePointSize(n); alpha[i] = evidenceAlpha(n);
    if (Number.isFinite(n.x)) { pos[i * 3] = n.x; pos[i * 3 + 1] = n.y; pos[i * 3 + 2] = n.z || 0; }
  }
  nodeGeo = new THREE.BufferGeometry();
  nodeGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  nodeGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  nodeGeo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  nodeGeo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  nodeCloud = new THREE.Points(nodeGeo, nodeMat); nodeCloud.frustumCulled = false; scene.add(nodeCloud);
  buildMarkers();
}
// Provenance arrives on a later poll than the node itself, and evidence accrues while the node just sits
// there — so colour/size/alpha have to be able to change WITHOUT rebuilding the geometry (the old build was
// paint-once, which quietly froze every node at whatever was known the moment it first appeared).
function repaintNodeCloud() {
  if (!nodeCloud || !nodeGeo) return;
  const col = nodeGeo.attributes.aColor.array, size = nodeGeo.attributes.size.array, alpha = nodeGeo.attributes.aAlpha.array;
  for (let i = 0; i < nodeIndex.length; i++) {
    const n = nodeIndex[i], c = new THREE.Color(nodeColor(n));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; size[i] = nodePointSize(n); alpha[i] = evidenceAlpha(n);
  }
  nodeGeo.attributes.aColor.needsUpdate = true; nodeGeo.attributes.size.needsUpdate = true; nodeGeo.attributes.aAlpha.needsUpdate = true;
  buildMarkers();
}

// ---- MARKER RING (one extra draw call for both badges) ----
// Two things are worth calling out on the node itself rather than behind a click. A REFUTATION is the §7
// inoculation record: something we tested and disproved, and it must never quietly read as ordinary again —
// so it gets a red scar. A STRONG ID is the opposite state, an object pinned to a real register (Wikidata,
// FEC, bioguide); it is common (~20% of nodes), so it stays a faint gold hairline, present but never noisy.
const RING_TEX = (function () {
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
  x.strokeStyle = 'rgba(255,255,255,1)'; x.lineWidth = 5; x.beginPath(); x.arc(32, 32, 24, 0, Math.PI * 2); x.stroke();
  return new THREE.CanvasTexture(c);
})();
const markerMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: RING_TEX }, uOpacity: { value: 1.0 } },
  vertexShader: 'attribute float size; attribute vec3 aColor; attribute float aAlpha; varying vec3 vColor; varying float vAlpha; void main(){ vColor=aColor; vAlpha=aAlpha; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=size*(560.0/max(1.0,-mv.z)); gl_Position=projectionMatrix*mv; }',
  fragmentShader: 'uniform sampler2D map; uniform float uOpacity; varying vec3 vColor; varying float vAlpha; void main(){ vec4 t=texture2D(map, gl_PointCoord); if(t.a<0.02) discard; gl_FragColor=vec4(vColor, t.a*uOpacity*vAlpha); }',
  transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending,
});
const REFUTED_RGB = new THREE.Color('#f87171'), STRONGID_RGB = new THREE.Color('#fcd34d');
let markerCloud = null, markerGeo = null, markerIndex = [];
function markerOf(n) {                       // a scar outranks a badge — being wrong is the louder fact
  const p = n && n.prov; if (!p) return null;
  if (p.refuted) return { c: REFUTED_RGB, a: 0.95, k: 1.55 };
  if (p.strongId) return { c: STRONGID_RGB, a: 0.34, k: 1.35 };
  return null;
}
function buildMarkers() {
  if (markerCloud) { scene.remove(markerCloud); markerGeo.dispose(); markerCloud = null; markerGeo = null; }
  markerIndex = [];
  const src = [];
  for (const n of nodeIndex) { const m = markerOf(n); if (m) { src.push(n); markerIndex.push(m); } }
  const N = src.length; if (!N) return;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const n = src[i], m = markerIndex[i];
    col[i * 3] = m.c.r; col[i * 3 + 1] = m.c.g; col[i * 3 + 2] = m.c.b; size[i] = nodePointSize(n) * m.k; alpha[i] = m.a;
    if (Number.isFinite(n.x)) { pos[i * 3] = n.x; pos[i * 3 + 1] = n.y; pos[i * 3 + 2] = n.z || 0; }
  }
  markerGeo = new THREE.BufferGeometry();
  markerGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  markerGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  markerGeo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  markerGeo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  markerCloud = new THREE.Points(markerGeo, markerMat); markerCloud.frustumCulled = false; markerCloud.renderOrder = 2; scene.add(markerCloud);
  markerIndex = src;                          // positions sync from the nodes each frame
}
function updateMarkers() {
  if (!markerCloud || !markerIndex.length) return; const pos = markerGeo.attributes.position.array;
  for (let i = 0; i < markerIndex.length; i++) { const n = markerIndex[i]; if (!Number.isFinite(n.x)) continue; pos[i * 3] = n.x; pos[i * 3 + 1] = n.y; pos[i * 3 + 2] = n.z || 0; }
  markerGeo.attributes.position.needsUpdate = true;
}
function updateNodeCloud() {
  if (!nodeCloud) return; const pos = nodeGeo.attributes.position.array;
  for (let i = 0; i < nodeIndex.length; i++) { const n = nodeIndex[i]; if (!Number.isFinite(n.x)) continue; pos[i * 3] = n.x; pos[i * 3 + 1] = n.y; pos[i * 3 + 2] = n.z || 0; }
  nodeGeo.attributes.position.needsUpdate = true;
}
// click-to-walk via raycast against the Points cloud (default node meshes are hidden, so onNodeClick is dead).
// A drag = orbit, a click (little movement) = pick. threshold is in world units ~ a node's screen footprint.
const _ray = new THREE.Raycaster(); _ray.params.Points.threshold = 6;
let _downXY = null;
graphEl.addEventListener('pointerdown', (e) => { _downXY = [e.clientX, e.clientY]; });
graphEl.addEventListener('pointerup', (e) => {
  const d = _downXY; _downXY = null;
  if (!d || !nodeCloud) return;
  if (Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 5) return;   // moved → it was an orbit drag
  const cv = graphEl.querySelector('canvas'); if (!cv) return; const rect = cv.getBoundingClientRect();
  const m = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  try {
    _ray.setFromCamera(m, Graph.camera()); const hits = _ray.intersectObject(nodeCloud);
    if (hits.length) {
      const n = nodeIndex[hits[0].index]; if (!n || n.id == null) return;
      // A personality mote is HER row, not a corpus entity — show it, don't try to ego-walk Echo for it.
      if (n.zoe) { setOverlay((n.entityType || 'self') + ' — ' + (n.summary || n.id), 5200); return; }
      focus(n.id);
    }
  } catch (err) {}
});

// ============================================================================================================
// THE SHORT-TERM REGION (Lucas, 2026-07-22) — a REGION needs an edge, not just a statistical tendency. One
// translucent membrane sphere at ORB_R draws that edge; the orb force hard-caps its nodes inside it, leaving
// an empty moat before the corpus shell starts at ~420. Inside, at the centroid, lives ZOE: an anchor mote
// with a slow breathing pulse, orbited by her actual self_model rows (kg:self) as the innermost ring. Cost:
// one 24×16 sphere mesh + two sprites — nothing per-node, nothing post-processed.
// ============================================================================================================
let membrane = null, zoeAnchor = null, zoeHalo = null;
(function buildRegion() {
  try {
    const geo = new THREE.SphereGeometry(1, 24, 16);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(SQ_VIOLET), transparent: true, opacity: 0.045, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending });
    // Drawn at 1.18× the cap: centre-pull against the cap makes the orb EQUILIBRATE at the rim (measured
    // median 183 / p95 188 against ORB_R 175), so a membrane at exactly ORB_R would leave half the orb
    // studding its outside. The skin belongs just beyond where the mass actually settles.
    membrane = new THREE.Mesh(geo, mat); membrane.scale.setScalar(ORB_R * 1.18); membrane.renderOrder = 1; scene.add(membrane);
    // a whisper of an outline so the edge reads even where no corpus sits behind it. First cut was 0.10 and
    // the screenshot read as a geodesic scaffold, not a membrane — the wires were louder than the memory.
    const rim = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(SQ_VIOLET), transparent: true, opacity: 0.028, wireframe: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    rim.scale.setScalar(1.002); membrane.add(rim);
  } catch (e) { console.warn('[kg3d] membrane failed:', e && e.message); }
  // NOTE: no ensureZoeAnchor() here — it needs SPARK_TEX/mkSprite, whose `const` bindings sit below this IIFE
  // and are still in their temporal dead zone while it runs. The boot call at the bottom raises her instead.
})();

function zoeSprite(colorHex, opacity, scale) { const s = mkSprite(colorHex, opacity); s.scale.setScalar(scale); return s; }
function ensureZoeAnchor() {
  if (zoeAnchor) return;
  zoeAnchor = zoeSprite(new THREE.Color(ZOE_ROSE).getHex(), 0.95, 9);
  zoeHalo = zoeSprite(new THREE.Color(ZOE_ROSE).getHex(), 0.30, 22);
  scene.add(zoeAnchor); scene.add(zoeHalo);
}
function updateRegion(now) {
  if (membrane) membrane.position.set(_coreCen.x, _coreCen.y, _coreCen.z);
  if (zoeAnchor) {
    const b = 1 + Math.sin(now / 1400) * 0.12;             // slow breath, not a blink
    zoeAnchor.position.set(_coreCen.x, _coreCen.y, _coreCen.z); zoeAnchor.scale.setScalar(9 * b);
    zoeHalo.position.set(_coreCen.x, _coreCen.y, _coreCen.z); zoeHalo.scale.setScalar(22 * (2 - b) * 0.55 + 11);
  }
}

// Her self_model rows as the innermost ring. Deterministic orbit points (hashSeed, like the tendrils) so the
// ring is stable across reloads; category → colour; importance → size. They live OUTSIDE shortTerm.nodes
// (declared with the data model above), and clicking one shows the row instead of ego-walking Echo.
let zoeFeeling = null;
async function loadSelf() {
  try {
    if (!(window.sq && window.sq.kg && typeof window.sq.kg.self === 'function')) return;   // pre-reboot main: region + anchor only
    const r = await window.sq.kg.self();
    if (!r || !r.ok || !Array.isArray(r.rows)) return;
    zoeFeeling = r.feeling || null;
    ensureZoeAnchor();
    for (const row of r.rows) {
      const id = 'zoe: ' + (row.category || 'self') + ' #' + row.id;
      const h1 = hashSeed(id + '#a'), h2 = hashSeed(id + '#b'), h3 = hashSeed(id + '#c');
      const dir = new THREE.Vector3(h1 * 2 - 1, h2 * 2 - 1, h3 * 2 - 1); if (dir.lengthSq() < 1e-3) dir.set(0, 1, 0); dir.normalize();
      const o = ensureObj({ id, store: 'sidequest', entityType: row.category || 'insight', summary: row.content }, _coreCen);
      o.zoe = true; o.importance = row.importance || 0.6; o.zoeOff = dir.multiplyScalar(ZOE_RING * (0.72 + 0.55 * h1));
      zoeSet.add(id);
    }
    render();
  } catch (e) { /* the self layer is an enrichment; the region stands without it */ }
}

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
// ---- thinking + communicating (Lucas, 2026-07-22: "graphically show her thinking and communicating") ----
// The membrane gives these a grammar. THINKING is churn INSIDE the boundary: each throttled 'think' event is
// a mote condensing somewhere in the orb and drifting in toward her. COMMUNICATING is a crossing OF the
// boundary: 'hear' (Lucas's turn) arcs in from outside to the anchor, 'say' (her reply) arcs out from the
// anchor into the space between the stores — and the membrane itself shimmers at every crossing.
function gThink() {                            // a thought: condenses in the orb, drifts toward her
  const c = new THREE.Vector3(_coreCen.x, _coreCen.y, _coreCen.z);
  const h = Math.random() * Math.PI * 2, v = Math.acos(2 * Math.random() - 1), r = ORB_R * (0.45 + 0.5 * Math.random());
  const start = c.clone().add(new THREE.Vector3(r * Math.sin(v) * Math.cos(h), r * Math.sin(v) * Math.sin(h), r * Math.cos(v)));
  const s = mkSprite(VHEX, 0.34); s.scale.setScalar(2); s.position.copy(start);
  addEffect([s], 1700, (p) => { const e = 1 - (1 - p) * (1 - p); s.position.copy(start.clone().lerp(c, e * 0.82)); const q = Math.sin(p * Math.PI); s.material.opacity = 0.34 * q; s.scale.setScalar(2 + q * 2.5); });
}
function membraneShimmer() {                   // the boundary notices a crossing
  if (!membrane) return; const m = membrane.material, base = 0.045;
  addEffect([], 750, (p) => { m.opacity = base + Math.sin(p * Math.PI) * 0.05; });
}
const HEAR_HEX = new THREE.Color('#a5b4fc').getHex(), SAY_HEX = new THREE.Color(ZOE_ROSE).getHex();
function gCross(inward, colorHex) {            // one communication: a pulse crossing the membrane, trailed
  const c = new THREE.Vector3(_coreCen.x, _coreCen.y, _coreCen.z);
  const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
  if (dir.lengthSq() < 1e-3) dir.set(0, 1, 0); dir.normalize();
  const far = c.clone().add(dir.multiplyScalar(ORB_R * 2.5));
  const from = inward ? far : c, to = inward ? c : far;
  const pulse = mkSprite(colorHex, 0.95), trail = mkLine(colorHex, 0.55); pulse.scale.setScalar(4); pulse.position.copy(from);
  addEffect([pulse, trail], 1150, (p) => {
    const e = inward ? 1 - (1 - p) * (1 - p) : p * p;     // hears decelerate arriving; says accelerate leaving
    const pos = from.clone().lerp(to, e);
    pulse.position.copy(pos); pulse.material.opacity = 0.95 * (1 - p * 0.55);
    trail.geometry.setFromPoints([from.clone().lerp(to, Math.max(0, e - 0.16)), pos]); trail.material.opacity = 0.55 * (1 - p);
    if (inward && p > 0.86 && zoeHalo) zoeHalo.material.opacity = 0.3 + Math.sin((p - 0.86) / 0.14 * Math.PI) * 0.3;
  });
  membraneShimmer();
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
  // 'unknown', not 'concept': the optimistic mint has not been told what this is, and T5 made that a real
  // answer. Guessing `concept` here also disagreed with whatever the next kg:shortterm poll returned.
  for (const e of batch) { const id = e.anchor; if (id == null || objs.has(id)) continue; ensureObj({ id, store: 'sidequest', entityType: 'unknown', epistemic: e.epistemic || 'told' }, c); shortTerm.nodes.add(id); minted++; }
  if (minted) render();
  return minted;
}

// --- dispatcher: route a kg:activity event to its gesture (find the node's world position) ---
function onActivity(evt) {
  if (!evt) return;
  try { logActivity(evt); } catch (e) {}   // every event → the right-dock running log (independent of gesture routing)
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
    else if (k === 'self' || k === 'reflect') {                          // her identity moved — flare the anchor, refresh the ring
      const c = new THREE.Vector3(_coreCen.x, _coreCen.y, _coreCen.z);
      gEnrich(c, new THREE.Color(ZOE_ROSE).getHex());
      if (k === 'self') loadSelf();
    }
    else if (k === 'hear') { gCross(true, HEAR_HEX); }                   // Lucas's words crossing IN to her
    else if (k === 'say') { gCross(false, SAY_HEX); }                    // her reply crossing OUT of the region
    // doc.land / news → ambient inflow, deferred (no emitter fires them yet)
  } catch (e) { console.warn('[kg3d] activity', e && e.message); }
}

// ---- fps HUD ----
let frames = 0, lastT = performance.now(), fps = 0;
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now(); frames++;
  updateEffects(now);
  updateNodeCloud();
  updateMarkers();
  updateTendrils();
  updateRegion(now);
  if (_provDirty) { _provDirty = false; try { repaintNodeCloud(); } catch (e) {} }
  if (now - lastT >= 750) {
    fps = Math.round(frames * 1000 / (now - lastT)); frames = 0; lastT = now;
    const d = Graph.graphData();
    // "sourced" is the share of drawn nodes with at least one encounter on file. It is the honest headline
    // number for a memory that claims things are real because they were encountered — and right now it is low.
    let sourced = 0; for (const n of d.nodes) if (n.prov && n.prov.encounters) sourced++;
    const pct = d.nodes.length ? Math.round(sourced * 100 / d.nodes.length) : 0;
    if (hudEl) hudEl.textContent = `3D · ${d.nodes.length} nodes / ${d.links.length} links · ${pct}% sourced · ${fps} fps`;
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
// dedup/curation runs on the legacy kg:curation-move channel — fold it into the same stream (absorb gesture + log).
try { if (window.sq && window.sq.kg && typeof window.sq.kg.onCurationMove === 'function') window.sq.kg.onCurationMove((p) => { if (p) onActivity({ db: 'echo', kind: 'node.merge', anchor: p.anchor, count: p.count || 1, tier: p.tier }); }); } catch (e) {}

// ---- log dock toggle ----
const logDock = document.getElementById('logdock'), logBtn = document.getElementById('logBtn');
if (logBtn && logDock) {
  let logOpen = true; try { logOpen = localStorage.getItem('kg3d.log') !== '0'; } catch (e) {}
  const paintLog = () => { logDock.classList.toggle('hidden', !logOpen); logBtn.classList.toggle('on', logOpen); };
  paintLog();
  logBtn.addEventListener('click', () => { logOpen = !logOpen; try { localStorage.setItem('kg3d.log', logOpen ? '1' : '0'); } catch (e) {} paintLog(); });
}

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
// (click-to-walk is handled by the raycast picker on the Points cloud above — default node meshes are hidden)
setInterval(() => pollShortTerm(false), 5000);   // short-term reconciler (liveness + prune)
ensureZoeAnchor();                               // she is present regardless of whether kg:self can deliver her rows yet
loadSelf();                                      // the personality ring (kg:self); safe no-op on a pre-reboot main
setInterval(loadSelf, 300000);                   // identity moves slowly — refresh occasionally, plus on 'self' events

// ---- dev handle for CDP verification ----
window.__kg3d = { Graph, reload: loadOverview, focus, fps: () => fps, data: () => Graph.graphData(), onActivity, onFocusMove, effectsN: () => effects.length, tendrilN: () => tendrilSpecs.length, setFollow, mode: () => mode, worldN: () => world.nodes.size, camZ: () => Graph.cameraPosition().z,
  markerN: () => markerIndex.length, repaint: repaintNodeCloud, fit: fitView,
  zoe: () => ({ ring: zoeSet.size, feeling: zoeFeeling, anchor: !!zoeAnchor, membrane: !!membrane, center: { x: Math.round(_coreCen.x), y: Math.round(_coreCen.y), z: Math.round(_coreCen.z) } }),
  loadSelf,
  // Seed synthetic nodes straight into the object store. The evidence encoding is only provable with nodes
  // spanning every state (unsourced → authoritative, refuted, strong-id), and the live corpus rarely holds
  // all of them at once in one view — same reason kg:dev-activity exists for the bus.
  seed: (list) => { for (const n of (list || [])) { const o = ensureObj(n); o.x = n.x; o.y = n.y; o.z = n.z || 0; full.add(n.id); } render(); return objs.size; },
  prov: () => { const d = Graph.graphData().nodes; let sourced = 0, ghost = 0, weak = 0, refuted = 0, sid = 0, enc = 0, lo = Infinity, hi = 0;
    for (const n of d) { const a = evidenceAlpha(n); if (a === EV_GHOST) ghost++; if (a === EV_WEAK) weak++; const p = n.prov; if (p && p.encounters) { sourced++; enc += p.encounters; } if (p && p.refuted) refuted++; if (p && p.strongId) sid++; const s = nodePointSize(n); if (s < lo) lo = s; if (s > hi) hi = s; }
    return { supplied: _provSupplied, nodes: d.length, sourced, ghost, weak, refuted, strongId: sid, encounters: enc, size: d.length ? [+lo.toFixed(1), +hi.toFixed(1)] : [] }; } };

loadOverview();
try { window.__kg3d.logN = () => _logN; window.__kg3d.logRows = () => (logFeed ? logFeed.childElementCount : 0); } catch (e) {}
console.info('[kg3d] surface build lean-3: + evidence encoding (size=corroboration, alpha=vouched-for, ring=refuted/strong-id) + denser corpus request');
