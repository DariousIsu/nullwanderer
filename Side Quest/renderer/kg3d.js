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
  // the substrate itself, finally visible: an encounter landing, and a claim being disproven
  'encounter': ['evidence', '#7dd3fc'], 'refute': ['refuted', '#f87171'],
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
// CONNECTIVITY GRADIENT (Lucas's structure, 2026-07-22): "the most connected long term set closest to the
// short term and the most dense short term sat closest to the long term… movement between them look like
// neurons passing through a membrane." Both stores now grade by how connected each object is, facing each
// other across the boundary: her richest, most-linked short-term material presses OUT to the membrane, the
// corpus's biggest hubs press IN to meet it, and the thin tails of both fall away from the interface. A
// recognition therefore fires between two dense surfaces rather than across a uniform gap — and it fills out
// both bodies, since a uniform shell wasted its whole surface on nodes of every weight at one radius.
// ONE CLOUD, TWO HALVES (Lucas, 2026-07-22: "we lost the cloud feel when we should have just felt a change in
// the cloud density… what if instead of two nested spheres we did two halves of one sphere?").
//
// The nested-shell build was a mistake I can name precisely: I answered "make the region legible" by adding a
// BOUNDARY OBJECT — a membrane mesh — and then hard-capped the orb inside it. A shaded sphere with a wireframe
// on it reads as a planet, and the cap opened a dead moat around it, so the result was two solids in a void
// instead of a cloud. Density was supposed to be the boundary and I made geometry the boundary.
//
// So: one body, split along an axis. Short-term fills one half, the corpus the other, both at the same scale,
// interpenetrating at the middle — no shell, no moat, no membrane mesh. Lucas's connectivity gradient survives
// intact and gets better: instead of grading toward a sphere's surface, each side grades toward the PLANE, so
// the two dense faces meet across the middle and recognition fires straight through the interface.
const ZOE_RING = 60;
const AX = { x: 1, y: 0, z: 0 };                 // the split axis: short-term −x, corpus +x
const CLOUD_R = 430;                             // radius of the ONE cloud both halves belong to
const R_SQ = 0.60;                               // her half is tighter — same-ish node count in less volume = DENSER
const PLANE_MIN = 0.10;                          // hubs press this close to the dividing plane
const PERP_SQ = CLOUD_R * R_SQ, PERP_EC = CLOUD_R;
const CLOUD_SHELL = CLOUD_R * 0.55;              // recognition mints land inside the corpus half
const DEG_ECHO_MAX = 3.25, DEG_SQ_MAX = Math.log10(21);   // log-degree normalisers (echo degrees reach ~1600)
// A point inside this node's own half of the sphere. Constraining only the axial coordinate (the previous
// attempt) never fills a volume — it pressed each half into a thin column, because nothing said where a node
// belonged ACROSS the axis. Every node now gets a deterministic home in its hemisphere: cube-root radius so
// the ball fills EVENLY rather than crowding the centre, a fixed angle around the axis, and an axial fraction
// set by connectivity — hubs near the dividing plane, thin tails out toward the poles. Springs pull nodes
// toward these, charge and links then push them off it, and the result reads as a cloud instead of a lattice.
// Declared above targetPoint on purpose — this file has sprung the temporal-dead-zone trap four times now.
const _midCen = { x: 0, y: 0, z: 0 };            // the middle of the whole cloud; the dividing plane runs through it
// ============================================================================================================
// SHAPE — switchable, because two unilateral picks were both rejected and this is a judgement call that
// belongs to Lucas, not to me. `localStorage.kg3d.shape` or __kg3d.shape('name'). Each returns a target point
// for a node, or null to mean "impose nothing and let the physics decide".
//   halves  — one sphere split along an axis (current)
//   corona  — dense short-term core, long-term falling off continuously outward. No band, no gap: the
//             density gradient is the only boundary. This is closest to the arrangement Lucas liked before I
//             started adding geometry to it.
//   binary  — two separate cloud masses with a bridge between them. Cross-store nodes are drawn toward the
//             midline, so the isthmus forms out of the DATA (the things that actually span both stores)
//             rather than being drawn as scenery. Crossings read hardest here.
//   free    — no positional prior at all. Charge and links alone; store is carried by colour and density.
//             The shape becomes the actual connectivity, which is how the best-looking graph viz works.
// ============================================================================================================
let SHAPE = 'halves';
try { SHAPE = localStorage.getItem('kg3d.shape') || 'halves'; } catch (e) {}
const _tp = new THREE.Vector3();
function nodeConnT(n) {                        // normalised connectivity, 0..1
  const sq = n.store === 'sidequest';
  const d = sq ? (n.localDeg || 0) : ((typeof n.degree === 'number' && n.degree > 0) ? n.degree : (n.localDeg || 0));
  return Math.max(0, Math.min(1, Math.log10(1 + d) / (sq ? DEG_SQ_MAX : DEG_ECHO_MAX)));
}
function nodeSeed(n) {
  if (!n._tp) {
    const h1 = hashSeed(String(n.id) + '#r'), h2 = hashSeed(String(n.id) + '#a'), h3 = hashSeed(String(n.id) + '#u');
    n._tp = { rf: Math.cbrt(0.10 + 0.90 * h1), ang: h2 * Math.PI * 2, jit: (h3 - 0.5) * 0.30, u: h3 };
  }
  return n._tp;
}
// CORONA: short-term is a tight bright core; the corpus is a continuous halo whose density thins outward,
// with its best-connected material nearest the core. Crucially there is NO band edge and NO gap — the two
// populations touch, and only the change in density marks where one becomes the other.
function targetCorona(n) {
  const s = nodeSeed(n), sq = n.store === 'sidequest', t = nodeConnT(n);
  const r = sq ? CLOUD_R * 0.34 * s.rf : CLOUD_R * (0.30 + (1 - t) * 0.72) * (0.72 + 0.38 * s.rf);
  const u = (s.u * 2 - 1) * 0.98, perp = r * Math.sqrt(Math.max(0, 1 - u * u));
  return _tp.set(_midCen.x + r * u, _midCen.y + Math.cos(s.ang) * perp, _midCen.z + Math.sin(s.ang) * perp);
}
// BINARY: two masses, and the bridge is made of the nodes that genuinely span both stores — a node with
// cross-store links is pulled toward the midline in proportion to how many it has, so the isthmus is DATA.
function targetBinary(n) {
  const s = nodeSeed(n), sq = n.store === 'sidequest';
  const sep = CLOUD_R * 0.62, lobe = (sq ? 0.40 : 0.62) * CLOUD_R;
  const pull = Math.max(0, Math.min(0.85, (n.crossDeg || 0) * 0.30));     // 0 = deep in its lobe, 1 = on the midline
  const cx = _midCen.x + (sq ? -sep : sep) * (1 - pull);
  const r = lobe * s.rf * (1 - pull * 0.45);
  const u = (s.u * 2 - 1) * 0.98, perp = r * Math.sqrt(Math.max(0, 1 - u * u));
  return _tp.set(cx + r * u * 0.55, _midCen.y + Math.cos(s.ang) * perp, _midCen.z + Math.sin(s.ang) * perp);
}
// BRAIN (Lucas's anatomy, 2026-07-22): "the short term memory would sit more like a cerebral cortex and the
// different memory types can be chopped up amongst the rest of the brain parts by size."
//
// This is the first arrangement with actual MEANING in it rather than an arbitrary geometry, and the anatomy
// is apt: the cortex is where live processing happens, and consolidated memory lives in the structures
// beneath it. So short-term becomes the outer mantle — a thin folded shell wrapping everything — and the
// corpus fills the interior, partitioned into lobes by entity TYPE, each lobe's volume proportional to how
// many objects of that type she actually holds. The map is then readable as anatomy: a big `person` lobe
// beside a small `committee` nucleus tells you the true shape of what she knows.
//
// Lobe centroids are placed on a Fibonacci sphere (even spacing, no clumping), largest types nearest the
// middle. Radius goes as the CUBE ROOT of the count, so it is VOLUME that encodes quantity, not radius —
// otherwise a type with 10× the nodes would look 1000× bigger.
// ============================================================================================================
// THE FOUR LOBES (Lucas, 2026-07-22): "put the Zoe Core and the Short term memory in the place of the
// Temporal lobe. and then split frontal occipital parietal and temporal into different like coloured inputs
// and then use the connections between same and across sections produce the shape. it can be noisy and messy
// so long as it reads."
//
// This is the design that finally makes sense of the whole thing, and it inverts what I had been doing: stop
// trying to SCULPT a brain out of points and instead give the graph four strongly-coloured territories in
// anatomically right places, then let the EDGES do the modelling. Links inside a lobe pull it dense; links
// across lobes become the tracts between them. The form comes out of the data's own connectivity, which is
// why it can afford to be messy — it reads from the colour blocks and the fibre bundles, not from a clean
// outline. Temporal holds her Core + short-term, which is also where the real one does memory formation.
//
// Positions are in the same unit space as brainSDF: +X forward, +Y up, ±Z hemispheres.
const LOBES = {
  frontal:   { x: 0.60, y: 0.14, z: 0, color: '#e879f9' },   // magenta — matches the plate's frontal
  parietal:  { x: -0.06, y: 0.44, z: 0, color: '#4ade80' },  // green
  occipital: { x: -0.68, y: 0.02, z: 0, color: '#a78bfa' },  // violet
  temporal:  { x: 0.14, y: -0.40, z: 0, color: '#22d3ee' },  // cyan — Zoe Core + short-term live here
};
const LOBE_ORDER = ['frontal', 'parietal', 'occipital'];      // long-term is split across these three
const typeLobe = new Map();                                   // entity type → lobe name
function lobeOf(n) {
  if (n.zoe || n.store === 'sidequest') return 'temporal';
  return typeLobe.get(n.entityType || 'unknown') || 'occipital';
}
const brainLobes = new Map();
let _lobeSig = '';
function buildBrainLobes(nodes) {
  const counts = new Map();
  for (const n of nodes) {
    if (n.zoe || n.store === 'sidequest') continue;
    const t = n.entityType || 'unknown';
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const types = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const sig = types.map(([t, c]) => t + ':' + c).join('|');
  if (sig === _lobeSig) return; _lobeSig = sig;          // only rebuild when the type mix actually changes
  // Assign each entity type to one of the three long-term lobes, greedily filling whichever is lightest, so
  // the three come out comparable in mass instead of one swallowing `person` and the others going bare.
  typeLobe.clear();
  const load = { frontal: 0, parietal: 0, occipital: 0 };
  for (const [t, c] of types) {
    const pick = LOBE_ORDER.reduce((a, b) => (load[a] <= load[b] ? a : b));
    typeLobe.set(t, pick); load[pick] += c;
  }
  brainLobes.clear();
  const total = types.reduce((s, [, c]) => s + c, 0) || 1, K = types.length || 1;
  const GA = Math.PI * (3 - Math.sqrt(5));
  types.forEach(([t, c], i) => {
    const y = K === 1 ? 0 : 1 - ((i + 0.5) / K) * 2;      // −1..1 down the sphere
    const ring = Math.sqrt(Math.max(0, 1 - y * y)), th = GA * i;
    // Bigger types sit deeper toward the middle; the long tail of small types rings the outside.
    // Held well inside the mantle. First cut let a big lobe reach r≈0.96 against a cortex at 0.92, so the two
    // blended and the shell stopped reading as a separate layer — the whole point of the anatomy. Deepest
    // structure + biggest lobe now tops out around 0.63, leaving a clear band of tissue above everything.
    const depth = CLOUD_R * (0.14 + 0.30 * (i / Math.max(1, K - 1)));
    brainLobes.set(t, {
      x: Math.cos(th) * ring * depth, y: y * depth, z: Math.sin(th) * ring * depth,
      r: Math.max(CLOUD_R * 0.05, CLOUD_R * 0.29 * Math.cbrt(c / total)),
    });
  });
}
// THE FORM, THIRD ATTEMPT — and a change of instrument, not another round of constants. Twice I tried to
// describe a brain with one analytic radius (an ellipsoid, then an ellipsoid with a flattened base and a
// frontal taper) and twice Lucas said it doesn't look like a brain. He is right, and the reason is structural:
// a brain silhouette is NOT a deformed sphere. What makes the profile instantly recognisable is
//   (1) the TEMPORAL LOBE — a separate mass jutting forward and down, with the sylvian notch above it, and
//   (2) the CEREBELLUM — a distinct smaller body tucked under the occipital pole.
// No single radius function can produce a re-entrant notch or a second body. So the shape is now a signed
// distance field of smooth-unioned parts, and nodes are MARCHED onto its surface. The creases come free from
// the smooth union, which is exactly where a real brain's fissures are.
//
// Axes: +X forward (frontal pole), +Y up, ±Z the two hemispheres. Units are fractions of CLOUD_R.
const FISSURE = 0.085;                                    // half-width of the longitudinal midline gap
function sdEllipsoid(px, py, pz, rx, ry, rz) {            // iq's bound: exact enough for a layout constraint
  const k0 = Math.hypot(px / rx, py / ry, pz / rz);
  if (k0 === 0) return -Math.min(rx, ry, rz);
  const k1 = Math.hypot(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
  return k1 === 0 ? 0 : (k0 * (k0 - 1)) / k1;
}
function smin(a, b, k) {                                  // smooth union — this is what makes it one organ
  const h = Math.max(0, k - Math.abs(a - b)) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
// Negative inside, positive outside. Built from four parts, blended with different sharpness: the temporal
// join is soft (it IS the brain) while the cerebellum keeps a tighter seam so it still reads as its own body.
// Tuned against an ASCII cross-section of the field itself rather than by reloading the app — a 1-second
// feedback loop instead of a 40-second one, which is the only reason iterating here was defensible after
// twice being told the shape was wrong. The seam widths are doing the real work: a WIDE blend fuses parts
// into one oval (which is what the first two attempts were), a TIGHT one leaves the crease that makes a
// feature legible. Hence 0.045 on the cerebellum — it has to remain visibly its own body.
function brainSDF(x, y, z) {
  let d = sdEllipsoid(x + 0.06, y - 0.16, z, 0.80, 0.56, 0.56);              // cerebrum, parietal peak set back
  d = smin(d, sdEllipsoid(x - 0.56, y + 0.02, z, 0.42, 0.44, 0.48), 0.26);   // frontal pole, below the peak
  d = smin(d, sdEllipsoid(x - 0.10, y + 0.40, z, 0.60, 0.20, 0.40), 0.09);   // temporal lobe + sylvian notch
  d = smin(d, sdEllipsoid(x + 0.62, y + 0.04, z, 0.36, 0.38, 0.44), 0.20);   // occipital
  d = smin(d, sdEllipsoid(x + 0.56, y + 0.48, z, 0.33, 0.20, 0.37), 0.045);  // cerebellum, its own body
  return d;
}
// Walk out along a direction until the field crosses zero — the surface point for that heading. Bisection is
// plenty here (~18 steps to well under a pixel) and it runs once per node, cached in the node's seed.
function brainSurface(dx, dy, dz) {
  let lo = 0.05, hi = 1.9;
  if (brainSDF(dx * hi, dy * hi, dz * hi) < 0) return hi;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) * 0.5;
    if (brainSDF(dx * mid, dy * mid, dz * mid) < 0) lo = mid; else hi = mid;
  }
  return lo;
}
function targetBrain(n) {
  const s = nodeSeed(n);
  const side = (hashSeed(String(n.id) + '#h') < 0.5) ? -1 : 1;   // which hemisphere this node belongs to
  // A LOOSE anchor in the node's lobe — deliberately loose, because the point of this design is that the
  // EDGES model the form. The anchor only says which territory a node belongs to; the link force decides
  // where inside it, packs each lobe by its own internal connectivity, and stretches the cross-lobe tracts.
  const L = LOBES[lobeOf(n)];
  // Territories have to TOUCH or they read as four separate islands rather than one organ — which is what
  // the first pass looked like. Centres pulled in and each lobe given enough spread that neighbours overlap
  // at their edges; the cross-lobe links then stitch the seams, which is the whole point of the design.
  // The constant overstated the real extent: the offsets below are bounded by (rf−0.55) and (u−0.5), so a
  // "0.46" spread only ever reached ~±0.45 of it in x and ~±0.75 in y — the lobes stayed islands with dark
  // water between them. Raised, and the centres pulled further in, so neighbours genuinely interpenetrate
  // and the cross-lobe links have something to stitch. Messy is fine; four separate blobs is not.
  const spread = (n.zoe ? 0.34 : 0.86) * CLOUD_R, pull = 0.62;
  const zc = (Math.abs(s.dz0 == null ? (s.dz0 = (hashSeed(String(n.id) + '#lz') - 0.5) * 1.4) : s.dz0) + FISSURE + 0.05) * side;
  return _tp.set(
    _midCen.x + L.x * CLOUD_R * pull + (s.rf - 0.55) * spread * Math.cos(s.ang * 2.3),
    _midCen.y + L.y * CLOUD_R * pull + (s.u - 0.5) * spread * 1.5,
    _midCen.z + zc * CLOUD_R * 0.55 + Math.sin(s.ang) * spread * 0.5
  );
}
// The previous surface-marched placement, kept for the `shell` variant of the brain (cortex-mantle style).
function targetBrainShell(n) {
  const s = nodeSeed(n);
  const side = (hashSeed(String(n.id) + '#h') < 0.5) ? -1 : 1;
  if (!s.bs) {
    // Direction is cached per node, and so is the marched surface distance — the bisection runs ONCE per
    // node, not per tick, so the field costs nothing on the hot path.
    const u = (s.u * 2 - 1) * 0.97, dyz = Math.sqrt(Math.max(0, 1 - u * u));
    let dx = u, dy = Math.cos(s.ang) * dyz, dz = Math.sin(s.ang) * dyz;
    dz = Math.abs(dz) * side;                                    // mirror into this node's hemisphere
    if (Math.abs(dz) < FISSURE) dz = side * FISSURE;             // keep the longitudinal fissure open
    const nrm = Math.hypot(dx, dy, dz) || 1;
    s.dx = dx / nrm; s.dy = dy / nrm; s.dz = dz / nrm;
    s.bs = brainSurface(s.dx, s.dy, s.dz);
  }
  if (n.store === 'sidequest') {
    // CORTEX — a thin mantle laid ON the field's surface, so it inherits the notch and the cerebellum
    // instead of approximating them. Gyri are a low-frequency ripple in the last few percent of depth.
    const fold = Math.sin(s.ang * 6.0 + s.u * 8.0) * 0.5 + Math.sin(s.ang * 3.0 - s.u * 5.0) * 0.5;
    const r = CLOUD_R * s.bs * (0.955 + fold * 0.030 + (s.rf - 0.75) * 0.045);
    return _tp.set(_midCen.x + r * s.dx, _midCen.y + r * s.dy, _midCen.z + r * s.dz);
  }
  // INTERIOR — type lobes, mirrored into both hemispheres. Each lobe centroid is pulled along its own
  // heading until it sits INSIDE the field, so no lobe can hang outside the skull the way it could when the
  // interior and the surface were described by two unrelated formulas.
  const lobe = brainLobes.get(n.entityType || 'unknown');
  if (!lobe) return targetCorona(n);
  if (lobe.bs == null) {
    const L = Math.hypot(lobe.x, lobe.y, lobe.z) || 1;
    lobe.bs = brainSurface(lobe.x / L, lobe.y / L, lobe.z / L) * CLOUD_R;
    lobe.scale = Math.min(1, (lobe.bs * 0.62) / Math.max(1, L));
  }
  const u = (s.u * 2 - 1) * 0.98, perp = lobe.r * s.rf * Math.sqrt(Math.max(0, 1 - u * u));
  const zc = (Math.abs(lobe.z * lobe.scale) + CLOUD_R * (FISSURE + 0.05)) * side;
  return _tp.set(_midCen.x + lobe.x * lobe.scale + lobe.r * s.rf * u,
    _midCen.y + lobe.y * lobe.scale + Math.cos(s.ang) * perp * 0.85,
    _midCen.z + zc + Math.sin(s.ang) * perp * 0.6);
}
function targetPoint(n) {
  if (!n._tp) {
    const h1 = hashSeed(String(n.id) + '#r'), h2 = hashSeed(String(n.id) + '#a'), h3 = hashSeed(String(n.id) + '#u');
    n._tp = { rf: Math.cbrt(0.10 + 0.90 * h1), ang: h2 * Math.PI * 2, jit: (h3 - 0.5) * 0.30 };
  }
  const sq = n.store === 'sidequest';
  const d = sq ? (n.localDeg || 0) : ((typeof n.degree === 'number' && n.degree > 0) ? n.degree : (n.localDeg || 0));
  const t = Math.max(0, Math.min(1, Math.log10(1 + d) / (sq ? DEG_SQ_MAX : DEG_ECHO_MAX)));
  const r = CLOUD_R * (sq ? R_SQ : 1) * n._tp.rf;
  let u = PLANE_MIN + (1 - t) * (0.96 - PLANE_MIN) + n._tp.jit;      // |u| = how far toward its own pole
  u = Math.max(PLANE_MIN * 0.5, Math.min(0.99, u)) * (sq ? -1 : 1);
  const perp = r * Math.sqrt(Math.max(0, 1 - u * u));
  // AX is +x, so the perpendicular plane is y/z.
  return _tp.set(_midCen.x + AX.x * r * u, _midCen.y + Math.cos(n._tp.ang) * perp, _midCen.z + Math.sin(n._tp.ang) * perp);
}
// The middle of the whole cloud, and the heart of her half — the Zoe anchor, her personality orbits, the
// thinking motes and the firing origins all ride these, so everything moves as one body as the sim breathes.
const _coreCen = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
function makeCore3D(strength = 0.05) {
  let ns = [];
  function force(alpha) {
    // The cloud's own middle — the interface plane passes through it, perpendicular to AX.
    let mx = 0, my = 0, mz = 0, m = 0, sx = 0, sy = 0, sz = 0, s = 0;
    for (const n of ns) {
      if (n.zoe || !Number.isFinite(n.x)) continue;
      mx += n.x; my += n.y; mz += (n.z || 0); m++;
      if (n.store === 'sidequest') { sx += n.x; sy += n.y; sz += (n.z || 0); s++; }
    }
    if (m) { mx /= m; my /= m; mz /= m; }
    _midCen.x = mx; _midCen.y = my; _midCen.z = mz;
    if (s) _coreCen.set(sx / s, sy / s, sz / s); else _coreCen.set(mx, my, mz);
    for (const n of ns) {
      if (!Number.isFinite(n.x)) continue;
      if (n.zoe) {                                         // personality ring: spring to its own orbit point
        const tx = _coreCen.x + n.zoeOff.x, ty = _coreCen.y + n.zoeOff.y, tz = _coreCen.z + n.zoeOff.z, k = strength * 6 * alpha;
        n.vx = (n.vx || 0) + (tx - n.x) * k;
        n.vy = (n.vy || 0) + (ty - n.y) * k;
        n.vz = (n.vz || 0) + (tz - (n.z || 0)) * k;
        continue;
      }
      // One soft spring toward the node's home point. Deliberately gentle — charge and links have to be able
      // to pull clusters off it, or the cloud freezes into the lattice the target points describe. The shape
      // comes from the targets; the LIFE comes from the forces fighting them. `free` skips this entirely.
      const p = SHAPE === 'brain' ? targetBrain(n) : SHAPE === 'corona' ? targetCorona(n) : SHAPE === 'binary' ? targetBinary(n) : SHAPE === 'free' ? null : targetPoint(n);
      if (!p) continue;
      const k = strength * 1.15 * alpha;
      n.vx = (n.vx || 0) + (p.x - n.x) * k;
      n.vy = (n.vy || 0) + (p.y - n.y) * k;
      n.vz = (n.vz || 0) + (p.z - (n.z || 0)) * k;
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
  // In the brain arrangement the colour split carries the anatomy, and it has to be read at a glance: the
  // cortex is ONE tissue (uniform violet, however its nodes happen to be typed) and the interior is a map of
  // types. Letting untyped short-term nodes fall through to grey mottled the mantle and destroyed that read.
  // In `brain`, colour IS the anatomy — four territories as four blocks, the way the plate reads. It
  // overrides the type palette on purpose: which lobe a thing lives in is the thing to see here.
  if (SHAPE === 'brain') { const L = LOBES[lobeOf(n)]; if (L) return L.color; }
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
  // …and no per-LINK geometry either. 3d-force-graph builds one THREE.Line per link, which measured live is
  // the surface's real ceiling: at 2,200 nodes, merely 800 links cost 42fps and 5,000 links collapsed it to
  // 15 — while 2,200 nodes with no links sat flat at 60. Links now render as ONE LineSegments buffer (below),
  // exactly like the node cloud. The link FORCE still runs; only the drawing is taken over.
  .linkVisibility(false)
  .linkColor(linkColor)
  .linkOpacity(0.5)
  .warmupTicks(20)
  .cooldownTime(15000);
// COMPUTE BUDGET (Lucas approved trading refresh for detail). A hard 30fps cap isn't available — this bundled
// 3d-force-graph exposes pauseAnimation but no tickFrame, so there's no way to drive the loop by hand without
// reimplementing its layout stepping. The bigger saving doesn't need one: once the layout COOLS, every node
// position is static, yet the node/link/marker buffers were still being rewritten 60 times a second — tens of
// thousands of pointless writes per second at this density. Syncing only while the engine is actually moving
// frees that entirely, and it scales with the density rather than against it.
let engineRunning = true, _stillFrames = 0, _fitOnCool = true;
try {
  Graph.onEngineStop(() => {
    engineRunning = false;
    // Frame it ONCE when the layout has actually finished. The timed fit at load runs while the connectivity
    // gradient is still sorting itself out, so it frames a shape that no longer exists. After this the camera
    // is the operator's — a surface that re-aims itself while you are reading it is worse than a loose fit.
    // (no mode test here on purpose — `mode` is declared below and this is the third temporal-dead-zone trap
    // this file has sprung on me. The one-shot flag is consumed by the initial overview cooldown anyway.)
    if (_fitOnCool) { _fitOnCool = false; fitView(1000, true); }
  });
} catch (e) {}
// TONE MAPPING = the bloom I was never allowed to have. ACES is NOT a postprocess pass — it compiles into
// each fragment shader (no render targets, ~15 ALU ops), so it cannot repeat the UnrealBloom crash that took
// down the shared GPU process. It lets node cores exceed 1.0 and roll off to warm white instead of clipping,
// which is the perceptual signature of an actual light source and most of what bloom was buying.
try {
  const r = Graph.renderer();
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.15;
} catch (e) { console.warn('[kg3d] tone mapping unavailable:', e && e.message); }
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
function fitView(ms, broadside) {
  try {
    const ns = Graph.graphData().nodes;
    const c = broadside ? new THREE.Vector3(_midCen.x, _midCen.y, _midCen.z) : coreCentroid3D();
    let R = 0;
    for (const n of ns) if (Number.isFinite(n.x)) R = Math.max(R, Math.hypot(n.x - c.x, n.y - c.y, (n.z || 0) - c.z));
    if (!R) return;
    const fov = (Graph.camera().fov || 75) * Math.PI / 180;
    const D = Math.max(320, (R * 1.12) / Math.sin(fov / 2));      // fit the bounding sphere, with a little air
    const cam = Graph.cameraPosition();
    let dx = cam.x - c.x, dy = cam.y - c.y, dz = cam.z - c.z;
    const L = Math.hypot(dx, dy, dz) || 1;
    if (L < 1e-3) { dx = 0; dy = 0.35; dz = 1; }                  // keep the operator's current angle, change only range
    // BROADSIDE: view the split from the side, so the two halves sit left and right of each other. Left to its
    // own devices the fit kept the camera looking straight DOWN the split axis, where the halves overlap into
    // one blob and the whole structure is invisible — the layout was right and the viewpoint hid it.
    if (broadside) { dx = AX.z * 0.06; dy = 0.34; dz = 1; }
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
const hotSet = new Set();                       // corpus nodes minted into view because she just RECOGNISED them
// Declared here, above the marker cloud that reads them: markerOf() consults hotLinks and buildMarkers() runs
// on the very first render, so leaving these next to the recognition code put them in the temporal dead zone
// and killed the surface at load. Same class of failure as the Zoe anchor's SPARK_TEX.
const hotLinks = new Map();                     // recognised id → { born } — cooling recognition halos
// 45s was far too quick — recognitions vanished before the picture they built could be read. A halo now
// lasts five minutes and fades on a curve that stays legible for most of it, so the corpus accumulates a
// visible map of what she has been recognising instead of blinking it away.
const HOT_TTL = 300000;
const WORLD_CAP = 320, HOT_CAP = 80;

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

// Instanced Points render cheaply (tens of thousands feasible); the limiter is the CPU force sim. Measured
// live 2026-07-22: 1,804 nodes held a flat 60fps with no dip, and the only thing stopping more was this
// constant — the cap, not the machine. Raised so the corpus request can actually fill the sky.
const NODE_CAP = 5000;
function render() {
  const ids = new Set();
  for (const id of (mode === 'overview' ? full : world.nodes)) ids.add(id);
  for (const id of shortTerm.nodes) ids.add(id);
  for (const id of zoeSet) ids.add(id);          // the personality ring is in every view — identity doesn't scope out
  for (const id of hotSet) ids.add(id);          // recognised corpus nodes stay visible while their thread cools
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
  // Local degree drives the short-term half of the gradient — those nodes carry no global `degree`, so how
  // connected a thing is HERE is the honest measure of how central it currently is to what she's working on.
  for (const o of nodes) { o.localDeg = 0; o.crossDeg = 0; }
  const byId = new Map(nodes.map((o) => [o.id, o]));
  for (const l of links) {
    const s = byId.get(l.source), t = byId.get(l.target); if (s) s.localDeg++; if (t) t.localDeg++;
    // A link whose ends live in different stores is a real span between short and long term — the `binary`
    // shape builds its bridge out of exactly these, so the isthmus is data rather than decoration.
    if (s && t && (s.store === 'sidequest') !== (t.store === 'sidequest')) { s.crossDeg++; t.crossDeg++; }
  }
  try { buildBrainLobes(nodes); } catch (e) {}   // anatomy follows the live type mix
  Graph.graphData({ nodes, links });
  engineRunning = true;                    // new data reheats the layout; resume position syncing
  try { Graph.d3Force('charge').strength(chargeFor(nodes.length)); } catch (e) {}   // spread must not grow with density
  // EDGES MODEL THE FORM (Lucas's design). In `brain` the lobe anchors only say WHICH territory a node is
  // in; the link force decides everything inside it — packing each lobe by its own connectivity and pulling
  // the cross-lobe tracts taut. So the links are given real authority here rather than the token strength
  // that was fine when a target point dictated every position.
  try {
    const lf = Graph.d3Force('link');
    if (lf && lf.strength) lf.strength(SHAPE === 'brain' ? 0.55 : 0.16);
    if (lf && lf.distance) lf.distance(SHAPE === 'brain' ? 26 : 40);
  } catch (e) {}
  try { buildNodeCloud(); } catch (e) {}   // rebuild the instanced Points cloud for the new node set
  try { buildLinkCloud(); } catch (e) {}   // …and the single-buffer edge cloud
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
  fitView(0, true);
  setTimeout(() => { if (mode === 'overview') fitView(1200, true); }, 4500);
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
// DEPTH CUEING — the single biggest reason 1,000 nodes read as flat scatter instead of a volume: there was
// none. Every node rendered at identical brightness whether it sat at the front of the cloud or the back, so
// the eye got no parallax-independent depth signal at all and the whole thing collapsed into a sheet of
// specks. Distance now fades a node toward the background (on a black ground, fading alpha IS fog) and cools
// it slightly blue, which is ordinary atmospheric perspective. The near/far band is recomputed each frame
// from the live camera distance so it holds through zooming.
// ============================================================================================================
// THE POINT SHADER. Rebuilt on research (2026-07-22) after Lucas rejected the surface twice; the root cause
// turned out not to be aesthetic at all.
//
// ⭐ COLOUR-SPACE BUG — this is what actually made it look the way it did. three.js ColorManagement has been
// on by default since r152, so `new THREE.Color('#a78bfa')` converts to LINEAR working space. Three appends
// `linearToOutputTexel()` only inside its OWN ShaderLib fragments — a hand-written ShaderMaterial gets
// nothing. So the node cloud was shipping linear values straight to an sRGB display: violet #a78bfa lost
// ~58% of its red and ~70% of its green. Every node rendered dark and over-saturated. The link buffer had
// the exact OPPOSITE error — parseLinkRGB divided sRGB bytes by 255 and wrote them into a `color` attribute,
// which LineBasicMaterial (which DOES include colorspace_fragment) then encoded a second time, pushing the
// cross-store edges to ~0.9 luminance on a 0.027 background. Dim dots, blinding white sticks: two opposite
// bugs. `#include <colorspace_fragment>` here, and an sRGB→linear conversion in buildLinkCloud.
//
// ⭐ TONE MAPPING IS THE BLOOM REPLACEMENT. ACES is not a postprocess pass — it compiles into each fragment
// shader (~15 ALU ops, no render targets), so it cannot repeat the UnrealBloom GPU-process crash. Letting
// core brightness exceed 1.0 then rolls off to warm white instead of clipping, which is the actual
// perceptual signature of a light source and most of what bloom was buying.
//
// ⭐ TWO-LOBE GLOW, procedurally. A single radial gradient always reads as a fuzzy dot; a real point-spread
// function is a tight spike PLUS a broad base (the classic real-time-glow kernel). Done in-shader, so no
// texture sampling and no 64px filtering mush. The core desaturates toward white as it brightens — that is
// what makes a point read as luminous rather than merely coloured.
//
// ⭐ FOG, attenuating rather than mixing. The stock chunk does mix(colour, fogColor, f), which is right for
// NormalBlending and wrong under Additive — mixing toward the fog colour still ADDS its luminance, so far
// points never actually recede and dense far regions accumulate a grey wash. Scaling rgb AND alpha is the
// additive-safe form. Plus a blue-shift, the chromatic half of aerial perspective.
const FOG_STRENGTH = 0.86;
const NODE_VERT = `
  attribute float size; attribute vec3 aColor; attribute float aAlpha;
  uniform float uFitDist; uniform float uSizeK;
  varying vec3 vColor; varying float vAlpha; varying float vDepth;
  void main(){
    vColor = aColor; vAlpha = aAlpha;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mvPosition.z;
    // size is a DIAMETER IN DEVICE PIXELS at the fitted distance — resolution- and DPR-independent, and it
    // stops nodes silently shrinking as the corpus grows. The floor matters: sub-pixel points alias and
    // shimmer as the camera moves, which is precisely what read as "scattered debris".
    gl_PointSize = clamp(size * uSizeK * (uFitDist / max(1.0, -mvPosition.z)), 1.6, 96.0);
    gl_Position = projectionMatrix * mvPosition;
  }`;
const NODE_FRAG = `
  uniform float uOpacity; uniform float uNear; uniform float uFar; uniform float uFogK;
  uniform float uIntensity; uniform float uCoreW; uniform float uHaloW;
  varying vec3 vColor; varying float vAlpha; varying float vDepth;
  void main(){
    float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
    if (r > 1.0) discard;
    float k = max(0.0, 1.0 - r);
    float core = pow(k, 14.0);              // the spike
    float halo = pow(k, 2.2);               // the broad base
    float a = core * uCoreW + halo * uHaloW;
    if (a < 0.004) discard;
    vec3 rgb = mix(vColor, vec3(1.0), core * 0.72);          // hot cores blow to white, halo keeps the hue
    float f = clamp((vDepth - uNear) / max(1.0, uFar - uNear), 0.0, 1.0);
    float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb = mix(rgb, vec3(lum) * vec3(0.55, 0.72, 1.0), f * 0.5);   // aerial perspective: distance cools + desaturates
    gl_FragColor = vec4(rgb * uIntensity * (1.0 + core * 2.0), a * uOpacity * vAlpha);
    gl_FragColor.rgb *= (1.0 - f * uFogK);                    // additive-safe fog
    gl_FragColor.a   *= (1.0 - f * uFogK);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
function pointMaterial(o) {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: o.opacity }, uFitDist: { value: 900.0 }, uSizeK: { value: o.sizeK },
      uNear: { value: 100.0 }, uFar: { value: 2000.0 }, uFogK: { value: FOG_STRENGTH },
      uIntensity: { value: o.intensity }, uCoreW: { value: o.coreW }, uHaloW: { value: o.haloW } },
    vertexShader: NODE_VERT, fragmentShader: NODE_FRAG,
    transparent: true, depthWrite: false, depthTest: o.depthTest !== false, blending: o.blending,
  });
}
// Additive for the cloud: THREE.Points does not sort points within one object, so NormalBlending would blend
// in arbitrary buffer order. Additive is commutative, therefore order-independent, therefore correct here —
// and with tone mapping handling the accumulation there is no white wash to fear.
const nodeMat = pointMaterial({ opacity: 1.0, sizeK: 1.0, intensity: 1.35, coreW: 1.0, haloW: 0.22, blending: THREE.AdditiveBlending });
// GLOW: a second pass over the SAME geometry, much larger and very faint. Overlapping halos accumulate into
// a soft haze exactly where nodes are dense — which is what makes a point cloud read as a continuous
// luminous VOLUME instead of a scatter of dots. One extra draw call, zero extra memory, no render targets.
const haloMat = pointMaterial({ opacity: 0.11, sizeK: 4.0, intensity: 1.0, coreW: 0.0, haloW: 1.0, blending: THREE.AdditiveBlending, depthTest: false });
// DUST — the biggest single lever for the cloud read, and nearly free. Several faint non-semantic points are
// scattered around every real node, sampled from the same spatial density. They give the space BETWEEN nodes
// substance; without them no amount of glow on a thousand points fills a volume — you just get a thousand
// glowing points. This is what Wikiverse/WikiGalaxy are actually doing: the stars you notice are a small
// fraction of the points on screen. One draw call, tiny sizes, alpha so low it never competes with data.
const dustMat = pointMaterial({ opacity: 0.085, sizeK: 1.0, intensity: 0.85, coreW: 0.25, haloW: 0.55, blending: THREE.AdditiveBlending, depthTest: false });
const DUST_PER_NODE = 5, DUST_CAP = 14000;
let dustCloud = null, dustGeo = null;
// ============================================================================================================
// CORTEX SHELL — the fix for three failed brain attempts, and the diagnosis is the useful part: the FIELD was
// right (an ASCII cross-section of brainSDF shows the sylvian notch and a separate cerebellum), but the
// SURFACE was starved. ~500 short-term nodes cannot draw a silhouette however perfectly they are placed, so
// every attempt produced a luminous blob with correct anatomy nobody could see.
//
// So the mantle stops being derived from node count. This is a dedicated shell of ~16k points sampled ON the
// field's surface — pure tissue, carrying no data, exactly like the dust it reuses the material of. The real
// short-term nodes still sit in that shell and stay brighter; this is the substance they sit IN. One extra
// draw call, built once per shape change.
// CORTEX MESH — the move to a real surface. Points can never give a silhouette: they have no edge and no
// occlusion, and every glow sprite bleeds light past the outline, which is why four attempts at sculpting
// one out of a cloud all read as a nebula. An icosphere displaced onto the field gives an actual skin.
// Drawn BackSide + additive so it reads as an envelope you see the contents THROUGH — and additive
// specifically because of the lesson the links taught: anything dim on NormalBlending paints black over the
// glow behind it. This can only ever add.
let cortexMesh = null, _meshSig = '';
function buildCortexMesh() {
  const sig = SHAPE === 'brain' ? 'brain:' + Math.round(CLOUD_R) : 'off';
  if (sig === _meshSig && cortexMesh) return;
  _meshSig = sig;
  if (cortexMesh) { scene.remove(cortexMesh); cortexMesh.geometry.dispose(); cortexMesh.material.dispose(); cortexMesh = null; }
  // OFF by default. Displaced onto the field it rendered as a large flat grey slab across the middle —
  // worse than no skin at all — and a visible artifact is not worth shipping while the lobe colours are
  // already carrying the read. Opt in with localStorage kg3d.mesh='1' while this is worked out.
  let meshOn = false; try { meshOn = localStorage.getItem('kg3d.mesh') === '1'; } catch (e) {}
  if (SHAPE !== 'brain' || !meshOn) return;
  try {
    const geo = new THREE.IcosahedronGeometry(1, 5);          // ~10k verts, even distribution, no poles
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const dx = p.getX(i), dy = p.getY(i), dz = p.getZ(i);
      // gyri: displace slightly along the normal so the skin has relief instead of reading as a balloon
      const fold = Math.sin(dx * 9.0 + dy * 7.0) * 0.5 + Math.sin(dz * 8.0 - dy * 6.0) * 0.5;
      const r = brainSurface(dx, dy, dz) * CLOUD_R * (1.0 + fold * 0.022);
      p.setXYZ(i, dx * r, dy * r, dz * r);
    }
    geo.computeVertexNormals();
    cortexMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x93a7d6, transparent: true, opacity: 0.05, side: THREE.BackSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    cortexMesh.renderOrder = -3; scene.add(cortexMesh);
  } catch (e) { console.warn('[kg3d] cortex mesh failed:', e && e.message); }
}
const SHELL_N = 16000;
let shellCloud = null, shellGeo = null, _shellSig = '';
function buildCortexShell() {
  const sig = SHAPE === 'brain' ? 'brain:' + Math.round(CLOUD_R) : 'off';
  if (sig === _shellSig && shellCloud) return;
  _shellSig = sig;
  if (shellCloud) { scene.remove(shellCloud); shellGeo.dispose(); shellCloud = null; shellGeo = null; }
  if (SHAPE !== 'brain') return;
  const N = SHELL_N, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N);
  const c = new THREE.Color(SQ_VIOLET), GA = Math.PI * (3 - Math.sqrt(5));
  let i = 0;
  for (let j = 0; j < N; j++) {
    // Fibonacci sphere for even coverage — clumping would read as noise on a surface this dense.
    const u = 1 - ((j + 0.5) / N) * 2, ring = Math.sqrt(Math.max(0, 1 - u * u)), th = GA * j;
    const side = (j % 2) ? 1 : -1;
    let dx = u, dy = Math.cos(th) * ring, dz = Math.abs(Math.sin(th) * ring) * side;
    if (Math.abs(dz) < FISSURE) dz = side * FISSURE;                  // the midline stays open
    const nrm = Math.hypot(dx, dy, dz) || 1; dx /= nrm; dy /= nrm; dz /= nrm;
    const r0 = brainSurface(dx, dy, dz);
    const h = hashSeed('sh' + j);
    // gyri: a low-frequency ripple, plus a little depth scatter so it reads as tissue rather than a membrane
    const fold = Math.sin(th * 7.0 + u * 9.0) * 0.5 + Math.sin(th * 4.0 - u * 6.0) * 0.5;
    const r = CLOUD_R * r0 * (0.955 + fold * 0.028 + (h - 0.5) * 0.055);
    pos[i * 3] = _midCen.x + r * dx; pos[i * 3 + 1] = _midCen.y + r * dy; pos[i * 3 + 2] = _midCen.z + r * dz;
    const shade = 0.42 + 0.30 * h;
    col[i * 3] = c.r * shade; col[i * 3 + 1] = c.g * shade; col[i * 3 + 2] = c.b * shade;
    size[i] = 1.5 + h * 1.6; alpha[i] = 0.26 + h * 0.30;
    i++;
  }
  shellGeo = new THREE.BufferGeometry();
  shellGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  shellGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  shellGeo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  shellGeo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  shellCloud = new THREE.Points(shellGeo, dustMat); shellCloud.frustumCulled = false; shellCloud.renderOrder = -2; scene.add(shellCloud);
}
function buildDust(ns) {
  if (dustCloud) { scene.remove(dustCloud); dustGeo.dispose(); dustCloud = null; dustGeo = null; }
  if (!ns || !ns.length) return;
  const per = Math.max(1, Math.min(DUST_PER_NODE, Math.floor(DUST_CAP / ns.length)));
  const N = ns.length * per;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N);
  const c = new THREE.Color(); let i = 0;
  // A cortex is a SURFACE, and 480 short-term nodes spread over a whole brain cannot draw one — the mantle
  // came out as a blob for want of points, not for want of shape. So in `brain` the cortex gets extra dust,
  // scattered TANGENTIALLY (spread across the surface, held tight in the radial direction) so it thickens the
  // sheet instead of blurring it inward. Dust is already declared non-semantic filler, so this adds tissue
  // without inventing a single object she doesn't hold.
  const brainCortex = SHAPE === 'brain';
  for (const n of ns) {
    if (!Number.isFinite(n.x) || n.zoe) continue;
    c.set(nodeColor(n));
    const cortex = brainCortex && n.store === 'sidequest';
    const reps = cortex ? per * 3 : per;
    const rad = Math.hypot(n.x - _midCen.x, n.y - _midCen.y, (n.z || 0) - _midCen.z) || 1;
    const ux = (n.x - _midCen.x) / rad, uy = (n.y - _midCen.y) / rad, uz = ((n.z || 0) - _midCen.z) / rad;
    for (let d = 0; d < reps; d++) {
      if (i >= DUST_CAP) break;
      const h1 = hashSeed(n.id + '#d' + d), h2 = hashSeed(n.id + '#e' + d), h3 = hashSeed(n.id + '#f' + d);
      let ox = (h1 - 0.5) * 2, oy = (h2 - 0.5) * 2, oz = (h3 - 0.5) * 2;
      if (cortex) {
        const dot = ox * ux + oy * uy + oz * uz;            // strip the radial component → tangential scatter
        ox -= dot * ux * 0.82; oy -= dot * uy * 0.82; oz -= dot * uz * 0.82;
      }
      const sp = CLOUD_R * (cortex ? 0.055 : 0.085);
      pos[i * 3] = n.x + ox * sp; pos[i * 3 + 1] = n.y + oy * sp; pos[i * 3 + 2] = (n.z || 0) + oz * sp;
      const dim = cortex ? 0.70 : 0.55;
      col[i * 3] = c.r * dim; col[i * 3 + 1] = c.g * dim; col[i * 3 + 2] = c.b * dim;
      size[i] = (cortex ? 1.5 : 1.8) + h1 * 2.0; alpha[i] = (cortex ? 0.38 : 0.30) + h2 * 0.45;
      i++;
    }
  }
  if (!i) return;
  dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, i * 3), 3));
  dustGeo.setAttribute('aColor', new THREE.BufferAttribute(col.subarray(0, i * 3), 3));
  dustGeo.setAttribute('size', new THREE.BufferAttribute(size.subarray(0, i), 1));
  dustGeo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha.subarray(0, i), 1));
  dustCloud = new THREE.Points(dustGeo, dustMat); dustCloud.frustumCulled = false; dustCloud.renderOrder = -2; scene.add(dustCloud);
}
let nodeCloud = null, haloCloud = null, nodeGeo = null, nodeIndex = [];
// The fog band tracks the camera, so it stays correct while zooming. Half-depth of the cloud sets the spread.
// Fog band + point scale both track the live camera, so depth reads correctly through zooming and a node's
// size means the same thing at any distance. Band derived from measurement: the cloud spans [D−R, D+R], and
// far ≈ D + 2.2R puts the back edge at ~70% faded — enough to read as volume, not so much that the back half
// disappears. (PyMOL's depth_cue and VMD's linear cue defaults land on the same ratio.)
function updateFogBand() {
  try {
    const cam = Graph.cameraPosition(), c = _midCen;
    const dist = Math.hypot(cam.x - c.x, cam.y - c.y, cam.z - c.z) || 900;
    const near = Math.max(1, dist - CLOUD_R * 1.10), far = dist + CLOUD_R * 2.20;
    for (const m of [nodeMat, haloMat, dustMat]) {
      if (!m) continue;
      m.uniforms.uNear.value = near; m.uniforms.uFar.value = far; m.uniforms.uFitDist.value = dist;
    }
  } catch (e) {}
}
// Base weight is structural (how connected), the bonus is evidential (how corroborated). They are genuinely
// different facts about a node and both belong on screen: a hub everyone links to but nobody sourced should
// not look like a modest object forty documents independently agree on.
// Measured on the live surface: median node was 2.7px on screen and the 10th percentile 1.8px. At that size a
// soft glow sprite is a barely-there speck, which is why the links looked like the subject and the nodes like
// dust. Everything scaled up so the cloud is made of visible bodies.
function nodePointSize(n) {
  if (n.zoe) return 7 + (n.importance || 0.6) * 6;        // personality motes, weighted by importance
  const base = n.store === 'sidequest' ? 11 : Math.max(9, Math.min(30, 10 + Math.log10((n.degree || 0) + 1) * 8));
  const enc = (n.prov && n.prov.encounters) || 0;
  return Math.min(40, base + (enc ? Math.log2(1 + enc) * 1.9 : 0));
}
function buildNodeCloud() {
  const ns = Graph.graphData().nodes; nodeIndex = ns; const N = ns.length;
  if (nodeCloud) { scene.remove(nodeCloud); if (haloCloud) scene.remove(haloCloud); nodeGeo.dispose(); nodeCloud = null; haloCloud = null; nodeGeo = null; }
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
  // Shares the SAME geometry object, so the halo can never drift out of sync with the nodes and costs no
  // extra position updates — only a second draw.
  haloCloud = new THREE.Points(nodeGeo, haloMat); haloCloud.frustumCulled = false; haloCloud.renderOrder = -1; scene.add(haloCloud);
  buildMarkers();
  try { buildDust(nodeIndex); } catch (e) {}
  try { buildCortexShell(); } catch (e) {}    // the mantle, independent of how many nodes exist
  try { buildCortexMesh(); } catch (e) {}     // …and the skin that actually carries a silhouette
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

// ---- LINK CLOUD: every edge in ONE LineSegments buffer (one draw call for the whole graph) ----
// Colour is baked per-vertex at build time from the same linkColor() rules — a cross-store federation thread
// stays bright violet, everything else its category colour. Positions re-sync each frame from the sim.
let linkGeo = null, linkLines = null, linkIndex = [];
const _lc = new THREE.Color();
function parseLinkRGB(css) {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?/i.exec(css || '');
  if (m) return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: m[4] == null ? 1 : +m[4] };
  try { _lc.set(css || '#7890be'); return { r: _lc.r, g: _lc.g, b: _lc.b, a: 1 }; } catch (e) { return { r: .47, g: .59, b: .75, a: 1 }; }
}
function buildLinkCloud() {
  if (linkLines) { scene.remove(linkLines); linkGeo.dispose(); linkLines.material.dispose(); linkLines = null; linkGeo = null; }
  linkIndex = Graph.graphData().links || [];
  const N = linkIndex.length; if (!N) return;
  const pos = new Float32Array(N * 6), col = new Float32Array(N * 6);
  for (let i = 0; i < N; i++) {
    // TWO fixes here, and together they are why the frame was a mess of white sticks.
    // (1) COLOUR SPACE: parseLinkRGB divides sRGB bytes by 255, but a `color` BufferAttribute is read as
    //     LINEAR working space, and LineBasicMaterial then encodes it to sRGB again — a double encode that
    //     pushed the cross-store edges to ~0.9 luminance on a 0.027 background. Convert properly.
    // (2) WEIGHT: the network-viz literature puts bulk edges at 5–10% alpha and lets OVERLAP density draw the
    //     structure — that is what makes a hairball read as a cobweb instead of a smudge. These were ~0.5.
    const c = parseLinkRGB(linkColor(linkIndex[i]));
    _lc.setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace);
    const cross = c.a > 0.5;                                    // federation threads keep a little more presence
    const k = cross ? 0.30 : 0.085;
    for (let v = 0; v < 2; v++) { const o = i * 6 + v * 3; col[o] = _lc.r * k; col[o + 1] = _lc.g * k; col[o + 2] = _lc.b * k; }
  }
  linkGeo = new THREE.BufferGeometry();
  linkGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  linkGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // ADDITIVE, and this is a real defect fix rather than a preference. Once edge brightness dropped to ~8.5%
  // to sit under the nodes, NormalBlending meant every edge painted a NEAR-BLACK line at 62% opacity over
  // whatever was behind it — so in dense clusters the links were DARKENING the nebula, which is why the
  // bright regions had black scribbles scrawled across them. Additive can only ever add light: a lone edge is
  // a faint thread, and overlap accumulates into a glowing filament. That accumulation is the point — it is
  // how density draws the structure instead of individual strokes drawing it.
  linkLines = new THREE.LineSegments(linkGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  linkLines.frustumCulled = false; scene.add(linkLines);
}
function updateLinkCloud() {
  if (!linkLines || !linkIndex.length) return;
  const pos = linkGeo.attributes.position.array;
  for (let i = 0; i < linkIndex.length; i++) {
    const l = linkIndex[i], s = l.source, t = l.target;
    if (!s || !t || typeof s !== 'object' || typeof t !== 'object' || !Number.isFinite(s.x) || !Number.isFinite(t.x)) continue;
    const o = i * 6;
    pos[o] = s.x; pos[o + 1] = s.y; pos[o + 2] = s.z || 0;
    pos[o + 3] = t.x; pos[o + 4] = t.y; pos[o + 5] = t.z || 0;
  }
  linkGeo.attributes.position.needsUpdate = true;
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
const REFUTED_RGB = new THREE.Color('#f87171'), STRONGID_RGB = new THREE.Color('#fcd34d'), RECOG_RGB = new THREE.Color('#c4b5fd');
let markerCloud = null, markerGeo = null, markerIndex = [], markerLive = [];
function markerOf(n) {                       // a scar outranks a badge — being wrong is the louder fact
  if (n && hotLinks.has(n.id)) return { c: RECOG_RGB, a: 0.9, k: 2.1, live: true };   // …and a live recognition outranks both
  const p = n && n.prov; if (!p) return null;
  if (p.refuted) return { c: REFUTED_RGB, a: 0.95, k: 1.55 };
  if (p.strongId) return { c: STRONGID_RGB, a: 0.34, k: 1.35 };
  return null;
}
function buildMarkers() {
  if (markerCloud) { scene.remove(markerCloud); markerGeo.dispose(); markerCloud = null; markerGeo = null; }
  markerIndex = []; markerLive = [];
  const src = [], mets = [];
  for (const n of nodeIndex) { const m = markerOf(n); if (m) { src.push(n); mets.push(m); } }
  const N = src.length; if (!N) return;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const n = src[i], m = mets[i];
    col[i * 3] = m.c.r; col[i * 3 + 1] = m.c.g; col[i * 3 + 2] = m.c.b; size[i] = nodePointSize(n) * m.k; alpha[i] = m.a;
    markerLive.push(m.live ? { base: nodePointSize(n) * m.k, a: m.a } : null);
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
function updateMarkers(now) {
  if (!markerCloud || !markerIndex.length) return;
  const pos = markerGeo.attributes.position.array;
  const alpha = markerGeo.attributes.aAlpha.array, size = markerGeo.attributes.size.array;
  let live = false;
  for (let i = 0; i < markerIndex.length; i++) {
    const n = markerIndex[i]; if (Number.isFinite(n.x)) { pos[i * 3] = n.x; pos[i * 3 + 1] = n.y; pos[i * 3 + 2] = n.z || 0; }
    const lv = markerLive[i]; if (!lv) continue;
    const rec = hotLinks.get(n.id); if (!rec) continue;
    live = true;
    // Cool over the recognition's life, with a slow breath on top so a warm node reads as CURRENTLY known
    // rather than merely decorated. Expands slightly as it fades — a ripple settling, not a light switching off.
    const age = Math.max(0, Math.min(1, (now - rec.born) / HOT_TTL)), f = 1 - age;
    const breath = 1 + Math.sin(now / 620 + i) * 0.10 * f;
    alpha[i] = lv.a * (0.18 + 0.82 * f * f) * breath;
    size[i] = lv.base * (1 + age * 0.45);
  }
  markerGeo.attributes.position.needsUpdate = true;
  if (live) { markerGeo.attributes.aAlpha.needsUpdate = true; markerGeo.attributes.size.needsUpdate = true; }
}
function updateNodeCloud() {
  if (!nodeCloud) return; const pos = nodeGeo.attributes.position.array;
  for (let i = 0; i < nodeIndex.length; i++) { const n = nodeIndex[i]; if (!Number.isFinite(n.x)) continue; pos[i * 3] = n.x; pos[i * 3 + 1] = n.y; pos[i * 3 + 2] = n.z || 0; }
  nodeGeo.attributes.position.needsUpdate = true;
}
// click-to-walk via raycast against the Points cloud (default node meshes are hidden, so onNodeClick is dead).
// A drag = orbit, a click (little movement) = pick. threshold is in world units ~ a node's screen footprint.
const _ray = new THREE.Raycaster(); _ray.params.Points.threshold = 6;
function pickAt(clientX, clientY) {
  if (!nodeCloud) return null;
  const cv = graphEl.querySelector('canvas'); if (!cv) return null; const rect = cv.getBoundingClientRect();
  const m = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  try { _ray.setFromCamera(m, Graph.camera()); const hits = _ray.intersectObject(nodeCloud); if (hits.length) return nodeIndex[hits[0].index] || null; } catch (err) {}
  return null;
}
let _downXY = null;
graphEl.addEventListener('pointerdown', (e) => { _downXY = [e.clientX, e.clientY]; });
graphEl.addEventListener('pointerup', (e) => {
  const d = _downXY; _downXY = null;
  if (!d) return;
  if (Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 5) return;   // moved → it was an orbit drag
  const n = pickAt(e.clientX, e.clientY);
  if (!n || n.id == null) { hideCard(); return; }
  showCard(n);                                   // every pick answers "what IS this?" first…
  if (!n.zoe) focus(n.id);                       // …and a corpus/short-term node still walks its neighbourhood
});

// ---- HOVER: what a node is, at a glance (Lucas: "there's no information about what any of the nodes are").
// Same raycast as picking, throttled to ~12Hz; an HTML tooltip follows the cursor. Zero scene cost.
const tipEl = document.getElementById('tip');
let _hoverAt = 0;
graphEl.addEventListener('pointermove', (e) => {
  const now = performance.now(); if (now - _hoverAt < 80) return; _hoverAt = now;
  if (_downXY) { if (tipEl) tipEl.style.display = 'none'; return; }          // orbiting — no tooltip
  const n = pickAt(e.clientX, e.clientY);
  if (!n || n.id == null) { if (tipEl) tipEl.style.display = 'none'; return; }
  if (tipEl) {
    tipEl.querySelector('.nm').textContent = n.zoe ? ('Zoe — ' + (n.entityType || 'self')) : n.id;
    tipEl.querySelector('.meta').textContent = tipLine(n);
    tipEl.style.display = 'block';
    const w = tipEl.offsetWidth, flip = e.clientX + w + 26 > window.innerWidth;
    tipEl.style.left = (flip ? e.clientX - w - 14 : e.clientX + 14) + 'px';
    tipEl.style.top = Math.min(e.clientY + 12, window.innerHeight - tipEl.offsetHeight - 8) + 'px';
  }
});
graphEl.addEventListener('pointerleave', () => { if (tipEl) tipEl.style.display = 'none'; });
function tipLine(n) {
  if (n.zoe) return 'personality · importance ' + (n.importance != null ? n.importance.toFixed(2) : '—');
  const bits = [(n.store === 'sidequest' ? 'short-term' : 'long-term'), n.entityType || 'untyped'];
  if (typeof n.degree === 'number' && n.degree > 0) bits.push(n.degree + ' connections');
  const p = n.prov;
  if (p && p.encounters) bits.push(p.encounters + ' encounter' + (p.encounters > 1 ? 's' : '') + ' / ' + p.sources + ' source' + (p.sources > 1 ? 's' : ''));
  else if (_provSupplied && n.store === 'sidequest') bits.push('no provenance on file');
  if (p && p.refuted) bits.push('⚠ refuted claim on file');
  return bits.join(' · ');
}

// ---- NODE CARD: the full answer, bottom-left. Fed entirely from data already on the node — name, type,
// summary, and the evidence line the provenance sweep attached (encounters, independence, birth, refutations).
const cardEl = document.getElementById('card');
function hideCard() { if (cardEl) cardEl.style.display = 'none'; }
function showCard(n) {
  if (!cardEl) return;
  cardEl.querySelector('.nm').textContent = n.zoe ? 'Zoe — her own ' + (n.entityType || 'self') : n.id;
  const chips = [];
  if (n.zoe) { chips.push(['personality', ZOE_COLOR[n.entityType] || ZOE_ROSE]); chips.push([n.entityType || 'self', null]); }
  else {
    chips.push([n.store === 'sidequest' ? 'short-term' : 'long-term', n.store === 'sidequest' ? SQ_VIOLET : ECHO_SKY]);
    chips.push([n.entityType || 'untyped', nodeColor(n)]);
    if (n.epistemic) chips.push([n.epistemic, null]);
    if (n.prov && n.prov.strongId) chips.push(['strong id', '#fcd34d']);
    if (n.prov && n.prov.refuted) chips.push(['refuted claim', '#f87171']);
  }
  const chipBox = cardEl.querySelector('.chips'); chipBox.textContent = '';
  for (const [label, color] of chips) { const s = document.createElement('span'); s.className = 'chip'; s.textContent = label; if (color) s.style.color = color; chipBox.appendChild(s); }
  cardEl.querySelector('.sum').textContent = n.summary || (n.zoe ? '' : 'No summary on file.');
  const ev = cardEl.querySelector('.ev'); ev.textContent = '';
  if (!n.zoe) {
    const p = n.prov, line = (html) => { const d = document.createElement('div'); d.append(...html); ev.appendChild(d); };
    const b = (t) => { const x = document.createElement('b'); x.textContent = t; return x; };
    if (p && p.encounters) {
      line([b(String(p.encounters)), ' encounter' + (p.encounters > 1 ? 's' : '') + ' across ', b(String(p.sources)), ' independent source' + (p.sources > 1 ? 's' : '') + (p.authoritative ? ' — ' + p.authoritative + ' authoritative' : ' — none authoritative')]);
      if (p.bornLane) line([document.createTextNode('first encountered via ' + p.bornLane + (p.bornHost ? ' (' + p.bornHost + ')' : ''))]);
    } else {
      line([document.createTextNode(n.store === 'sidequest' ? 'No encounters on file — nothing records where this came from yet.' : 'No local encounters — its provenance lives in Echo’s own citations.')]);
    }
    if (p && p.refuted) { const d = document.createElement('div'); d.className = 'warn'; d.textContent = p.refuted + ' disproven claim' + (p.refuted > 1 ? 's' : '') + ' on file for this object (§7 — can never win again).'; ev.appendChild(d); }
    if (typeof n.degree === 'number' && n.degree > 0) line([b(String(n.degree)), ' graph connections']);
  }
  cardEl.style.display = 'block';
}
(function () { const x = document.getElementById('cardClose'); if (x) x.addEventListener('click', hideCard); })();

// ============================================================================================================
// THE SHORT-TERM REGION (Lucas, 2026-07-22) — a REGION needs an edge, not just a statistical tendency. One
// translucent membrane sphere at ORB_R draws that edge; the orb force hard-caps its nodes inside it, leaving
// an empty moat before the corpus shell starts at ~420. Inside, at the centroid, lives ZOE: an anchor mote
// with a slow breathing pulse, orbited by her actual self_model rows (kg:self) as the innermost ring. Cost:
// one 24×16 sphere mesh + two sprites — nothing per-node, nothing post-processed.
// ============================================================================================================
// THE MEMBRANE MESH IS GONE. It was the single thing that killed the cloud: a shaded sphere with a wireframe
// on it is a planet, and everything else — the moat, the "two solids in a void" look — followed from having
// built a boundary OBJECT at all. The interface is now just where the two halves meet, marked by an
// exceedingly faint glow disc lying IN the plane rather than a skin wrapped around anything.
// NO BOUNDARY OBJECT AT ALL. The membrane sphere made it a planet; replacing it with a disc in the interface
// plane just made a black slab across the middle. The lesson finally landed: any solid I add to mark the
// division stops the thing being a cloud. Density and colour ARE the boundary — which is what Lucas said in
// the first place. Nothing is drawn here now; the interface exists only as the place the two halves meet.
let membrane = null, zoeAnchor = null, zoeHalo = null;

function zoeSprite(colorHex, opacity, scale) { const s = mkSprite(colorHex, opacity); s.scale.setScalar(scale); return s; }
function ensureZoeAnchor() {
  if (zoeAnchor) return;
  zoeAnchor = zoeSprite(new THREE.Color(ZOE_ROSE).getHex(), 0.95, 9);
  zoeHalo = zoeSprite(new THREE.Color(ZOE_ROSE).getHex(), 0.30, 22);
  scene.add(zoeAnchor); scene.add(zoeHalo);
}
function updateRegion(now) {
  if (cortexMesh) cortexMesh.position.set(_midCen.x, _midCen.y, _midCen.z);
  if (shellCloud) shellCloud.position.set(0, 0, 0);
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
// ============================================================================================================
// RECOGNITION (Lucas: "anytime we observe something she already knows it should ping long term and I would
// like to see"). match.hit events were streaming — the resolver recognises known things constantly — but the
// old gesture required BOTH endpoints to be drawn nodes, and the matched corpus object is almost never in the
// overview slice. The moment Lucas asked to see was being discarded on arrival. Now: recognition MINTS the
// known object into view at its deterministic shell position, the arc leaves the MEMBRANE toward it (the
// region speaks — the mention text was never a node and never will be), the node flashes, and a federation
// thread persists from her core to the recognised thing, cooling over 45s. The corpus visibly lights up with
// what she is currently recognising.
// ============================================================================================================
// HOW RECOGNITION PERSISTS. First cut drew a federation thread from her core to every recognised object.
// It was unmistakable and it did not scale: match.hit streams continuously, so 28 live recognitions became a
// starburst of lines across the whole scene (Lucas: "might become overwhelming... something that looks as
// obvious without overcrowding"). The signal is about the OBJECT, not about the space between — so it now
// lives ON the object: a violet halo that lights the recognised node and cools over 45s. Same information,
// no geometry crossing the field, and it rides the marker cloud that already exists — zero new draw calls.
// (hotLinks/HOT_TTL are declared with the data model above — the marker cloud reads them on the first render.)
//
// Returns the OBJECT (already positioned by the seed), not the graphData node — so the gesture can fire on
// this frame while the actual re-render is coalesced. match.hit streams continuously during a decompose
// sweep; rendering per hit rebuilt the whole point cloud each time and dropped the surface to 17fps under a
// 10-hit burst. Batching the rebuild keeps recognition instant and the frame rate flat.
let _mintTimer = null;
function scheduleMintRender() { if (_mintTimer) return; _mintTimer = setTimeout(() => { _mintTimer = null; render(); }, 240); }
function mintEcho(name) {
  if (name == null) return null;
  const known = objs.get(name);
  if (!known) {
    const h1 = hashSeed(name + '#mx'), h2 = hashSeed(name + '#my'), h3 = hashSeed(name + '#mz');
    const dir = new THREE.Vector3(h1 * 2 - 1, h2 * 2 - 1, h3 * 2 - 1); if (dir.lengthSq() < 1e-3) dir.set(0, 1, 0); dir.normalize();
    ensureObj({ id: name, store: 'echo' }, { x: _coreCen.x + dir.x * CLOUD_SHELL, y: _coreCen.y + dir.y * CLOUD_SHELL, z: _coreCen.z + dir.z * CLOUD_SHELL });
    hotSet.add(name);
    if (hotSet.size > HOT_CAP) {                 // LRU by touch — the coolest thread yields
      let oldest = null, ot = Infinity;
      for (const id of hotSet) { const o = objs.get(id); const t = o ? o.touchedAt : 0; if (t < ot) { ot = t; oldest = id; } }
      if (oldest != null) { hotSet.delete(oldest); hotLinks.delete(oldest); }
    }
    scheduleMintRender();
  }
  const o = objs.get(name);
  return (o && Number.isFinite(o.x)) ? o : null;
}
let _hotDirty = false;
function addHotLink(id) { if (id == null) return; const had = hotLinks.has(id); hotLinks.set(id, { born: performance.now() }); if (!had) _hotDirty = true; }
// Expire cooled recognitions; a change in the SET (not the fade) is what needs a marker rebuild.
function updateHotLinks(now) {
  let changed = _hotDirty; _hotDirty = false;
  for (const [id, v] of hotLinks) if (now - v.born > HOT_TTL) { hotLinks.delete(id); changed = true; }
  if (changed) buildMarkers();
}
// ---- FIRING TRACES: the axon, not a wire ----
// The permanent threads had to go, but deleting them outright threw away the thing worth keeping — Lucas
// liked the BUILD-UP, just not that it never cleared. So a recognition now fires like a neuron: the path
// lights from the membrane outward at speed, overshoots into a bright head, and the whole trace then decays
// over ~9s. Recent firings accumulate into a living constellation and clear themselves; nothing is permanent
// except the halo on the node. One fixed-size ring buffer, one draw call, no allocation per firing.
const TRACE_CAP = 160, TRACE_FIRE = 620, TRACE_TTL = 9000;
const traces = new Array(TRACE_CAP).fill(null);
let traceHead = 0, traceGeo = null, traceLines = null;
const TRACE_RGB = new THREE.Color(0xc4b5fd), TRACE_HOT = new THREE.Color(0xf5f3ff);
(function buildTraceBuffer() {
  try {
    traceGeo = new THREE.BufferGeometry();
    traceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRACE_CAP * 6), 3));
    traceGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRACE_CAP * 6), 3));
    traceLines = new THREE.LineSegments(traceGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    traceLines.frustumCulled = false; scene.add(traceLines);
  } catch (e) { console.warn('[kg3d] trace buffer failed:', e && e.message); }
})();
// A firing starts where she is and crosses the interface to the thing she recognised — so the origin is her
// own centre, not a point on some surface. The trace therefore reads as passing THROUGH the middle.
function traceOrigin() { return new THREE.Vector3(_coreCen.x, _coreCen.y, _coreCen.z); }
function addTrace(target) {
  traces[traceHead] = { a: traceOrigin(), node: target, born: performance.now() };
  traceHead = (traceHead + 1) % TRACE_CAP;
}
function updateTraces(now) {
  if (!traceLines) return;
  const pos = traceGeo.attributes.position.array, col = traceGeo.attributes.color.array;
  for (let i = 0; i < TRACE_CAP; i++) {
    const t = traces[i], o = i * 6;
    if (!t) { col[o] = col[o + 1] = col[o + 2] = col[o + 3] = col[o + 4] = col[o + 5] = 0; continue; }
    const age = now - t.born;
    if (age > TRACE_TTL) { traces[i] = null; col[o] = col[o + 1] = col[o + 2] = col[o + 3] = col[o + 4] = col[o + 5] = 0; continue; }
    const n = t.node, bx = n.x, by = n.y, bz = n.z || 0;
    if (!Number.isFinite(bx)) continue;
    // Phase 1 — the impulse races out, the line growing behind its head. Phase 2 — the full trace decays.
    const fire = Math.min(1, age / TRACE_FIRE), e = 1 - Math.pow(1 - fire, 3);
    const hx = t.a.x + (bx - t.a.x) * e, hy = t.a.y + (by - t.a.y) * e, hz = t.a.z + (bz - t.a.z) * e;
    pos[o] = t.a.x; pos[o + 1] = t.a.y; pos[o + 2] = t.a.z;
    pos[o + 3] = hx; pos[o + 4] = hy; pos[o + 5] = hz;
    const decay = age <= TRACE_FIRE ? 1 : Math.pow(Math.max(0, 1 - (age - TRACE_FIRE) / (TRACE_TTL - TRACE_FIRE)), 1.7);
    const tailK = decay * 0.16, headK = decay * (age <= TRACE_FIRE ? 1 : 0.85);   // dim at the membrane, hot at the head
    const H = age <= TRACE_FIRE ? TRACE_HOT : TRACE_RGB;
    col[o] = TRACE_RGB.r * tailK; col[o + 1] = TRACE_RGB.g * tailK; col[o + 2] = TRACE_RGB.b * tailK;
    col[o + 3] = H.r * headK; col[o + 4] = H.g * headK; col[o + 5] = H.b * headK;
  }
  traceGeo.attributes.position.needsUpdate = true; traceGeo.attributes.color.needsUpdate = true;
}
function gMatch(bNode) {   // the firing itself: a hot head racing out, arriving in a burst on the known node
  const b = V3(bNode);
  addTrace(bNode);
  const a = traceOrigin();
  const head = mkSprite(0xf5f3ff, 1.0), flash = mkSprite(0xc4b5fd, 0), ring = mkSprite(SHEX, 0);
  head.scale.setScalar(5); head.position.copy(a); flash.position.copy(b); flash.scale.setScalar(4); ring.position.copy(b); ring.scale.setScalar(3);
  addEffect([head, flash, ring], 1500, (p) => {
    const fire = Math.min(1, p / (TRACE_FIRE / 1500)), e = 1 - Math.pow(1 - fire, 3);
    head.position.copy(a.clone().lerp(b, e));
    head.scale.setScalar(5 + Math.sin(fire * Math.PI) * 5);
    head.material.opacity = fire < 1 ? 1 : Math.max(0, 1 - (p - TRACE_FIRE / 1500) / 0.35);
    if (fire >= 1) {                                  // arrival: the node answers back
      const q = Math.min(1, (p - TRACE_FIRE / 1500) / 0.62), s = Math.sin(q * Math.PI);
      flash.scale.setScalar(4 + s * 22); flash.material.opacity = 0.9 * s;
      ring.scale.setScalar(3 + q * 34); ring.material.opacity = 0.55 * (1 - q);
    }
  });
  membraneShimmer();
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
  const h = Math.random() * Math.PI * 2, v = Math.acos(2 * Math.random() - 1), r = PERP_SQ * (0.30 + 0.45 * Math.random());
  const start = c.clone().add(new THREE.Vector3(r * Math.sin(v) * Math.cos(h), r * Math.sin(v) * Math.sin(h), r * Math.cos(v)));
  const s = mkSprite(VHEX, 0.34); s.scale.setScalar(2); s.position.copy(start);
  addEffect([s], 1700, (p) => { const e = 1 - (1 - p) * (1 - p); s.position.copy(start.clone().lerp(c, e * 0.82)); const q = Math.sin(p * Math.PI); s.material.opacity = 0.34 * q; s.scale.setScalar(2 + q * 2.5); });
}
// EVIDENCE ARRIVING — a throttled burst of encounters. Scaled by how many landed in the window, so a
// decompose sweep chewing through a 1,500-encounter PDF reads as a downpour and a single stray filing reads
// as one drop. Falls INWARD from outside the cloud: evidence comes from the world, not from her.
let _tick = 0;                                 // varies the deterministic hashes between bursts
function gEvidence(count) {
  _tick++;
  const c = new THREE.Vector3(_coreCen.x, _coreCen.y, _coreCen.z);
  const k = Math.max(1, Math.min(9, Math.round(Math.log2(1 + count) * 1.6)));
  for (let i = 0; i < k; i++) {
    const h = hashSeed('ev' + i + count + _tick) * Math.PI * 2, v = Math.acos(2 * hashSeed('ew' + i + _tick) - 1);
    const dir = new THREE.Vector3(Math.sin(v) * Math.cos(h), Math.sin(v) * Math.sin(h), Math.cos(v));
    const from = c.clone().add(dir.clone().multiplyScalar(CLOUD_R * 1.45));
    const to = c.clone().add(dir.multiplyScalar(CLOUD_R * (0.45 + 0.4 * hashSeed('ex' + i + _tick))));
    const s = mkSprite(0x7dd3fc, 0.85); s.scale.setScalar(3); s.position.copy(from);
    addEffect([s], 1250 + i * 60, (p) => {
      const e = 1 - Math.pow(1 - p, 2.2);
      s.position.copy(from.clone().lerp(to, e));
      s.material.opacity = 0.85 * Math.sin(Math.min(1, p * 1.15) * Math.PI);
      s.scale.setScalar(3 + p * 2);
    });
  }
}
// REFUTED — a red pulse that collapses INTO the object rather than radiating from it, then a dark ring.
// Something she believed is being taken back, and it should not look like a discovery.
function gRefute(pos) {
  const ring = mkSprite(0xf87171, 0), core = mkSprite(0xfca5a5, 0.9);
  ring.position.copy(pos); ring.scale.setScalar(26); core.position.copy(pos); core.scale.setScalar(2);
  addEffect([ring, core], 1400, (p) => {
    ring.scale.setScalar(26 * (1 - p * 0.82));            // collapses inward
    ring.material.opacity = 0.75 * Math.sin(p * Math.PI);
    core.scale.setScalar(2 + Math.max(0, p - 0.62) * 34);
    core.material.opacity = p < 0.62 ? 0.9 : 0.9 * (1 - (p - 0.62) / 0.38);
  });
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
  const far = c.clone().add(dir.multiplyScalar(PERP_SQ * 1.9));
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
// TENDRILS ARE OFF. They were my invention for a "neuron" look — 420 short whiskers fired off hub nodes in
// deterministic random directions — and on screen they are simply scratches. They encode nothing a viewer can
// read (the direction is a hash, not data), they were among the brightest things in the frame, and with the
// nodes at 2.7px they were most of what the eye actually saw. Kept behind a flag rather than deleted only
// because the hidden-connection idea may come back as something honest (a real edge to an off-screen node).
let TENDRILS_ON = false;
try { TENDRILS_ON = localStorage.getItem('kg3d.tendrils') === '1'; } catch (e) {}
function buildTendrils(force) {
  if (!TENDRILS_ON) { if (tendrilLines) { scene.remove(tendrilLines); tendrilGeo.dispose(); tendrilLines.material.dispose(); tendrilLines = null; tendrilGeo = null; } tendrilSpecs = []; return; }
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
    else if (k === 'match.hit') {                 // she recognised a known thing — fire at it, halo it
      const t = b || mintEcho(evt.anchor2); if (t) { addHotLink(t.id); gMatch(t); }
    }
    else if (k === 'recall') {                    // a memory pulled inward — same: the known thing must be visible
      const t = a || mintEcho(evt.anchor); if (t) { addHotLink(t.id); gMatch(t); gRecall(V3(t)); }
    }
    else if (k === 'observe' && a && a.store !== 'sidequest') {   // an observation touched a drawn corpus node
      gEnrich(V3(a), new THREE.Color(nodeColor(a)).getHex()); addHotLink(a.id);
    }
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
    else if (k === 'encounter') { gEvidence(evt.count || 1); }           // evidence arriving — the substrate landing
    else if (k === 'refute') {                                           // something she held, proven wrong
      const t = a || mintEcho(evt.anchor);
      if (t) { gRefute(V3(t)); addHotLink(t.id); } else { gRefute(new THREE.Vector3(_coreCen.x, _coreCen.y, _coreCen.z)); }
    }
    // doc.land / news → ambient inflow, deferred (no emitter fires them yet)
  } catch (e) { console.warn('[kg3d] activity', e && e.message); }
}

// ---- fps HUD ----
let frames = 0, lastT = performance.now(), fps = 0;
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now(); frames++;
  updateEffects(now);
  updateFogBand();              // depth band + point scale follow the camera, so this holds through zooming
  // Position syncing only while the layout is actually moving. `_stillFrames` keeps a couple of frames of
  // sync after it stops so the last motion lands, and any reheat (new data, a mint) restarts it.
  if (engineRunning) { _stillFrames = 2; } else if (_stillFrames > 0) { _stillFrames--; }
  if (engineRunning || _stillFrames > 0) { updateNodeCloud(); updateLinkCloud(); updateTendrils(); }
  updateHotLinks(now);          // expire cooled recognitions BEFORE the markers paint this frame
  updateMarkers(now);           // halos breathe and cool on their own clock, so these always run
  updateTraces(now);
  updateRegion(now);
  if (_provDirty) { _provDirty = false; try { repaintNodeCloud(); } catch (e) {} }
  if (now - lastT >= 750) {
    fps = Math.round(frames * 1000 / (now - lastT)); frames = 0; lastT = now;
    const d = Graph.graphData();
    // "sourced" is the share of drawn nodes with at least one encounter on file. It is the honest headline
    // number for a memory that claims things are real because they were encountered — and right now it is low.
    let sourced = 0; for (const n of d.nodes) if (n.prov && n.prov.encounters) sourced++;
    const pct = d.nodes.length ? Math.round(sourced * 100 / d.nodes.length) : 0;
    const rec = hotLinks.size ? ` · ${hotLinks.size} recognised` : '';
    if (hudEl) hudEl.textContent = `3D · ${d.nodes.length} nodes / ${d.links.length} links · ${pct}% sourced${rec} · ${fps} fps`;
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
// Shape selector — Lucas picks the arrangement, live, without a reload. Re-seeds every node's home point and
// reheats, so the cloud visibly reorganises into the new shape over a few seconds.
const shapeEl = document.getElementById('shape');
if (shapeEl) {
  shapeEl.value = SHAPE;
  shapeEl.addEventListener('change', () => {
    SHAPE = shapeEl.value;
    try { localStorage.setItem('kg3d.shape', SHAPE); } catch (e) {}
    for (const n of objs.values()) n._tp = null;
    try { Graph.d3ReheatSimulation(); } catch (e) {}
    _fitOnCool = true;                       // re-frame once the new arrangement settles
  });
}
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
  markerN: () => markerIndex.length, repaint: repaintNodeCloud, fit: fitView, rebuildLinks: buildLinkCloud,
  shape: (s) => { if (s) { SHAPE = s; try { localStorage.setItem('kg3d.shape', s); } catch (e) {} for (const n of objs.values()) n._tp = null; try { Graph.d3ReheatSimulation(); } catch (e) {} } return SHAPE; },
  linkN: () => linkIndex.length,
  zoe: () => ({ ring: zoeSet.size, feeling: zoeFeeling, anchor: !!zoeAnchor, membrane: !!membrane, center: { x: Math.round(_coreCen.x), y: Math.round(_coreCen.y), z: Math.round(_coreCen.z) } }),
  loadSelf,
  recog: () => ({ minted: hotSet.size, halos: hotLinks.size, markers: markerIndex.length, ids: [...hotLinks.keys()].slice(0, 6) }),
  card: () => (cardEl && cardEl.style.display === 'block') ? { name: cardEl.querySelector('.nm').textContent, chips: [...cardEl.querySelectorAll('.chip')].map(c => c.textContent), summary: cardEl.querySelector('.sum').textContent.slice(0, 90), evidence: cardEl.querySelector('.ev').textContent.slice(0, 220) } : null,
  showCard, tip: (n) => tipLine(n),
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
