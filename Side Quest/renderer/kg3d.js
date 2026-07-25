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
// THE LOG MUST NOT OUTRUN THE PICTURE SILENTLY (Lucas, 2026-07-22: "I am seeing so many more actions in the
// log than are actually taking place on the visual"). He was right, and the honest half of the fix is here:
// the dispatcher now returns a VERDICT, a row whose event drew nothing is dimmed and tagged, and the header
// counts both. A gap between the two numbers is then a readable fact about how much of her memory is off
// screen — not an unexplained mismatch between two panels that are supposed to agree.
const _act = { seen: 0, drawn: 0, byKind: new Map() };
function _tally(kind, drew) {
  _act.seen++; if (drew) _act.drawn++;
  let r = _act.byKind.get(kind); if (!r) { r = { seen: 0, drawn: 0 }; _act.byKind.set(kind, r); }
  r.seen++; if (drew) r.drawn++;
}
function logActivity(evt, verdict) {
  const drew = verdict !== 'miss' && verdict !== 'error';
  try { _tally(evt && evt.kind ? evt.kind : '?', drew); } catch (e) {}
  if (!logFeed || !evt || !evt.kind) return;
  const meta = KIND_META[evt.kind] || [evt.kind, '#94a3b8'];
  const st = evt.db === 'sidequest';
  const d = new Date();
  const row = document.createElement('div');
  row.className = 'logrow' + (drew ? '' : ' nodraw'); row.style.borderLeftColor = st ? '#a78bfa' : '#38bdf8';
  const mk = (cls, text, color) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; if (color) s.style.color = color; return s; };
  row.appendChild(mk('t', pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())));
  row.appendChild(mk('db ' + (st ? 'st' : 'lt'), st ? 'ST' : 'LT'));
  row.appendChild(mk('k', meta[0], meta[1]));
  // an event that drew nothing says so on its own row, with the reason — 'off-screen' means it named an
  // object the panel isn't holding, 'no target' means it named nothing to draw at.
  if (!drew) row.appendChild(mk('nd', verdict === 'error' ? 'error' : 'no target'));
  let txt = evt.anchor != null ? String(evt.anchor) : '';
  if (evt.anchor2 != null) txt += (evt.rel ? ' —' + String(evt.rel) + '→ ' : ' → ') + String(evt.anchor2);
  if (evt.count && evt.count > 1) txt += ' ×' + evt.count;
  row.appendChild(mk('a', txt));
  logFeed.insertBefore(row, logFeed.firstChild);
  _logN++; if (logCount) logCount.textContent = _act.drawn === _act.seen ? String(_logN) : (_act.drawn + '/' + _act.seen);
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
// VRM skin state, declared UP HERE with the other early state rather than beside its own functions: render()
// consults vrmReady to re-seat the binding, and render() lives above the VRM block. This file has sprung the
// temporal-dead-zone trap five times now, always the same way — a const declared next to the code that feels
// like it owns it, read by something that runs earlier.
let vrmModel = null, vrmReady = false, vrmOccluders = [], skinBinds = null, _vrmLoading = false, _skinT = 0;
const _vrmOff = new THREE.Vector3();                // model-centre → origin correction, kept out of position
// Link-cloud state lives up here for the same reason: the routed-link builder reads linkIndex/linkBaseCol and
// is defined above the straight cloud that owns them.
let linkGeo = null, linkLines = null, linkIndex = [], linkBaseCol = null, _linkFadeAt = 0;
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
      if (n.zoe && SHAPE === 'skin') continue;             // her identity is pinned in the heart, not orbiting
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
      // `skin` takes no spring at all: updateSkin() pins every node to its vertex with fx/fy/fz, so there is
      // no home point to pull toward — the model IS the layout.
      const p = SHAPE === 'skin' ? null : SHAPE === 'brain' ? targetBrain(n) : SHAPE === 'corona' ? targetCorona(n) : SHAPE === 'binary' ? targetBinary(n) : SHAPE === 'free' ? null : targetPoint(n);
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
// LOOK CLOSER AT A POINT ON HER. The trackball pivot sits at the cloud centre (mid-torso), so zoom dollies
// toward her belly and the head stays out of reach — "the camera is locked to zoom mid object". This re-aims
// the pivot at exactly the point given and pulls in to head-scale along the CURRENT view direction, so the
// operator's angle is preserved and the scroll wheel then zooms around THAT point. Never pushes out.
function focusPoint(p, ms) {
  try {
    const cam = Graph.cameraPosition();
    let dx = cam.x - p.x, dy = cam.y - p.y, dz = cam.z - p.z;
    const L = Math.hypot(dx, dy, dz) || 1;
    if (L < 1e-3) { dx = 0; dy = 0.2; dz = 1; }
    const dist = Math.min(L, 220);                              // pull in for a close look, never zoom out
    const k = dist / (Math.hypot(dx, dy, dz) || 1);
    Graph.cameraPosition({ x: p.x + dx * k, y: p.y + dy * k, z: p.z + dz * k }, p, ms == null ? 650 : ms);
  } catch (e) {}
}

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
  // REBIND THE SKIN WHENEVER THE NODE SET CHANGES. Without this she binds once and never again — and the
  // first bind almost always loses, because `skin` is applied at boot while kg:overview is still in flight
  // (measured 4s warm, ~15s cold). Live evidence: bound 61, all of them the self_model rows, while 1,584
  // corpus nodes stayed in the force layout. An invisible figure standing inside an unbound cloud, which is
  // exactly what it looked like. Every reload, poll and mint now re-seats her.
  if (SHAPE === 'skin' && vrmReady) {
    try { buildSkinBinding(); updateSkin(); buildRoutedLinks(); setRoutedVisible(true); } catch (e) {}
  } else { setRoutedVisible(false); }
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
// ============================================================================================================
// THE FACE (Lucas, 2026-07-22: "we use the avatar facial motions to give the cloud a face, its almost there
// anyway then the map can talk when she talks instead of the avatar").
// ============================================================================================================
// This is the one idea in this whole thread that plays to what a point cloud is actually GOOD at, and it is
// worth being precise about why — because the brain silhouette failed here repeatedly and this is the same
// surface. A brain needs an OUTLINE, and an outline needs a dense edge and occlusion, which points do not
// have. A FACE needs neither. Faces are read from LANDMARKS in the right relative positions — three dots and
// the visual system locks on before you can stop it. A cloud can do landmarks perfectly, because a landmark
// is just brightness, and brightness is per-point.
//
// So the rule that makes this safe: THE FACE MOVES NOTHING. It is additive light evaluated in SCREEN space
// and added on top of whatever each point already was. No node is displaced, no layout constant changes, and
// turning it off restores a byte-identical graph. That is the opposite of every rejected shape attempt,
// which all worked by moving data until it made a picture.
//
// Screen space, not object space, for the same reason: pareidolia happens on the retina. The face is painted
// where the eye is, so it reads at any camera angle and she keeps looking at you as the graph turns.
//
// It rides the SAME shader pair as nodes, halos and dust (one pointMaterial factory), so the dust — which is
// evenly spread — carries most of the face while the nodes, which are clumpy, carry the sparkle. That split
// matters: uneven cloud density is the main thing that could break the read.
const NODE_VERT = `
  attribute float size; attribute vec3 aColor; attribute float aAlpha;
  uniform float uFitDist; uniform float uSizeK;
  uniform vec2 uFaceCen; uniform float uFaceR; uniform float uAspect;
  varying vec3 vColor; varying float vAlpha; varying float vDepth; varying vec2 vFaceP;
  void main(){
    vColor = aColor; vAlpha = aAlpha;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mvPosition.z;
    // size is a DIAMETER IN DEVICE PIXELS at the fitted distance — resolution- and DPR-independent, and it
    // stops nodes silently shrinking as the corpus grows. The floor matters: sub-pixel points alias and
    // shimmer as the camera moves, which is precisely what read as "scattered debris".
    gl_PointSize = clamp(size * uSizeK * (uFitDist / max(1.0, -mvPosition.z)), 1.6, 96.0);
    gl_Position = projectionMatrix * mvPosition;
    // where this point falls on her face, in aspect-corrected screen space centred on the cloud
    vec2 ndc = gl_Position.xy / max(1e-4, abs(gl_Position.w));
    vFaceP = vec2((ndc.x - uFaceCen.x) * uAspect, ndc.y - uFaceCen.y) / max(1e-4, uFaceR);
  }`;
const NODE_FRAG = `
  uniform float uOpacity; uniform float uNear; uniform float uFar; uniform float uFogK;
  uniform float uIntensity; uniform float uCoreW; uniform float uHaloW;
  uniform float uFaceOn; uniform float uEye; uniform float uBrow; uniform float uMouthOpen;
  uniform float uMouthCurve; uniform float uFaceGain; uniform vec3 uFaceTint;
  varying vec3 vColor; varying float vAlpha; varying float vDepth; varying vec2 vFaceP;
  // Two eyes, two brows, one mouth — soft fields, no edges anywhere. The mouth's HEIGHT is the lip-sync
  // (amplitude → open) and its CENTRELINE bends with mouthCurve, so a smile lifts the corners rather than
  // recolouring anything. The eye wells squash vertically as they close, which is what makes a blink read.
  float faceField(vec2 p) {
    float w = 0.0;
    float eo = max(0.10, uEye);                                     // openness, blink already folded in
    vec2 e = vec2(abs(p.x) - 0.38, (p.y - 0.22) / eo);
    w = max(w, smoothstep(0.19, 0.015, length(e)));
    float by = 0.50 + uBrow * 0.07;                                 // brows ride above the eyes
    vec2 b = vec2((abs(p.x) - 0.38) / 0.24, (p.y - by) / 0.05);
    w = max(w, smoothstep(1.0, 0.55, length(b)) * 0.62);
    float mw = 0.34, mh = 0.032 + uMouthOpen * 0.26;                // <- she speaks here
    float cy = -0.34 + uMouthCurve * 0.11 * clamp(p.x * p.x / (mw * mw), 0.0, 1.0);
    vec2 m = vec2(p.x / mw, (p.y - cy) / mh);
    w = max(w, smoothstep(1.0, 0.45, length(m)));
    return w;
  }
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
    // THE FACE — added AFTER fog on purpose. She is a screen-space object, not a depth object, so a far node
    // must contribute to her as much as a near one or the features dissolve into the depth gradient. Never
    // subtractive (the lesson from a2f75d4: anything that dims paints black over the bright regions).
    //
    // MULTIPLICATIVE FIRST, and that is the whole difference between this reading as a face and reading as
    // three white slabs. The first cut ADDED flat light, which filled every feature to saturation and threw
    // away the cloud's own texture inside it — a decal laid over the graph. Scaling what is ALREADY there
    // means a bright node inside her eye gets brighter, faint dust gets a little brighter, and empty space
    // stays empty: the features come out made of the cloud, with all its grain and sparkle intact. She is the
    // graph lighting up in the shape of a face, not a face drawn on top of the graph.
    // ALPHA IS THE LEVER, not rgb — and getting that backwards cost a tuning round. Dust is drawn at 0.085
    // opacity, so under additive blending its contribution is rgb*alpha ≈ 0.04 whatever the colour is:
    // multiplying a near-black fragment cannot CREATE a feature, it can only deepen one that already exists.
    // Raising alpha is what makes the dust THICKEN into her features, and it is also what keeps the grain —
    // it is still the cloud's own points, just more present. rgb scaling then shapes the highlight inside it.
    if (uFaceOn > 0.002) {
      float fw = faceField(vFaceP) * uFaceOn;
      gl_FragColor.rgb *= (1.0 + fw * uFaceGain * 0.55);
      gl_FragColor.rgb += uFaceTint * fw * a * uFaceGain * 0.16;   // a little colour of her own
      gl_FragColor.a    = min(1.0, gl_FragColor.a * (1.0 + fw * uFaceGain * 0.75) + fw * a * 0.05);
    }
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
function pointMaterial(o) {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: o.opacity }, uFitDist: { value: 900.0 }, uSizeK: { value: o.sizeK },
      uNear: { value: 100.0 }, uFar: { value: 2000.0 }, uFogK: { value: FOG_STRENGTH },
      uIntensity: { value: o.intensity }, uCoreW: { value: o.coreW }, uHaloW: { value: o.haloW },
      // face state — one set per material, all written together by updateFace() each frame
      uFaceCen: { value: new THREE.Vector2(0, 0) }, uFaceR: { value: 0.6 }, uAspect: { value: 1.6 },
      uFaceOn: { value: 0 }, uEye: { value: 1 }, uBrow: { value: 0 }, uMouthOpen: { value: 0 },
      uMouthCurve: { value: 0.12 }, uFaceGain: { value: o.faceGain == null ? 2.0 : o.faceGain },
      uFaceTint: { value: new THREE.Color(0xffc8e4) } },
    vertexShader: NODE_VERT, fragmentShader: NODE_FRAG,
    transparent: true, depthWrite: false, depthTest: o.depthTest !== false, blending: o.blending,
  });
}
// Additive for the cloud: THREE.Points does not sort points within one object, so NormalBlending would blend
// in arbitrary buffer order. Additive is commutative, therefore order-independent, therefore correct here —
// and with tone mapping handling the accumulation there is no white wash to fear.
// faceGain per layer: the DUST carries her (it is evenly spread, so the features come out smooth), the halo
// gives the features their bloom, and the NODES are deliberately the weakest — they are clumpy, and letting
// them dominate would make the face a map of cloud density instead of a face.
const nodeMat = pointMaterial({ opacity: 1.0, sizeK: 1.0, intensity: 1.35, coreW: 1.0, haloW: 0.22, blending: THREE.AdditiveBlending, faceGain: 1.9 });
// GLOW: a second pass over the SAME geometry, much larger and very faint. Overlapping halos accumulate into
// a soft haze exactly where nodes are dense — which is what makes a point cloud read as a continuous
// luminous VOLUME instead of a scatter of dots. One extra draw call, zero extra memory, no render targets.
const haloMat = pointMaterial({ opacity: 0.11, sizeK: 4.0, intensity: 1.0, coreW: 0.0, haloW: 1.0, blending: THREE.AdditiveBlending, depthTest: false, faceGain: 4.2 });
// DUST — the biggest single lever for the cloud read, and nearly free. Several faint non-semantic points are
// scattered around every real node, sampled from the same spatial density. They give the space BETWEEN nodes
// substance; without them no amount of glow on a thousand points fills a volume — you just get a thousand
// glowing points. This is what Wikiverse/WikiGalaxy are actually doing: the stars you notice are a small
// fraction of the points on screen. One draw call, tiny sizes, alpha so low it never competes with data.
const dustMat = pointMaterial({ opacity: 0.085, sizeK: 1.0, intensity: 0.85, coreW: 0.25, haloW: 0.55, blending: THREE.AdditiveBlending, depthTest: false, faceGain: 7.0 });
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
  if (SHAPE === 'skin') return;                      // nothing beyond her — no haze scattered off her surface
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
    // ZOOM-OUT BLOWOUT. Halos are additive, so pulling the camera back packs more of them into every pixel
    // and the whole graph flares into a white blob — the glow that reads beautifully up close is exactly
    // what destroys it at range. Fade the halo and the dust as the view widens; the node cores keep their
    // brightness, so structure survives while the haze backs off.
    const zoom = Math.max(0.28, Math.min(1, (CLOUD_R * 2.3) / Math.max(1, dist)));
    haloMat.uniforms.uOpacity.value = 0.11 * zoom;
    dustMat.uniforms.uOpacity.value = 0.085 * (0.45 + 0.55 * zoom);
  } catch (e) {}
}
// ---- HER FACE: state, driven by the SAME module the avatar runs ------------------------------------------
// `lib/avatar_state.js` is UMD and already smoke-tested, so loading it here gives the graph the identical
// expression presets, the identical amplitude→mouth smoothing and the identical blink clock the avatar face
// uses. That is what Lucas asked for literally — the avatar's facial motions, on the map — and it means the
// two surfaces can never drift into being two different faces.
const AS = (typeof window !== 'undefined' && window.AvatarState) || null;
// DEFAULT OFF. Lucas, on seeing it: "the face is actually terrifying." He is right — the painted face fills
// the eye and mouth patches with additive light, and a filled bright eye is a skull, not a face. The VRM skin
// supersedes it with drawn line-art features and a real head to hang them on. Kept behind the toggle because
// it is the only face available when the model is absent, but it is no longer what anyone sees by default.
let FACE_ON = false; try { FACE_ON = localStorage.getItem('kg3d.face') === '1'; } catch (e) {}
const face = {
  strength: 0,            // 0..1 — how present she is; ramps up to speak, falls back to a resting trace
  target: 0,
  mouthOpen: 0,
  cur: { brow: 0, eye: 1, mouthCurve: 0.12, gazeY: 0 },
  tgt: (AS && AS.expressionPreset('neutral')) || { brow: 0, eye: 1, mouthCurve: 0.12, gazeY: 0 },
  speakUntil: 0, speakFrom: 0, analyser: null, buf: null, audioEl: null, audioCtx: null,
};
const FACE_REST = 0.16;   // she is faintly there when idle; speaking brings her forward
function faceExpression(name) { if (AS) face.tgt = AS.expressionPreset(name); }
// REAL lip-sync when the TTS wav is reachable, a synthesised envelope when it is not — and the fallback is
// not a stopgap: `speakThroughCompanion` bails out entirely unless the companion window is VISIBLE, so with
// the avatar hidden (which Lucas has explicitly put on the table for compute) there is no audio to analyse
// and the envelope is the only signal there will ever be.
function faceSpeak(text) {
  const ms = Math.max(900, Math.min(18000, String(text || '').length * 62));
  face.speakFrom = performance.now(); face.speakUntil = face.speakFrom + ms;
  face.target = 1;
}
function faceAttachAudio(url) {
  try {
    if (!url) return false;
    const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return false;
    face.audioCtx = face.audioCtx || new Ctx();
    const el = new Audio(url); el.crossOrigin = 'anonymous';
    const src = face.audioCtx.createMediaElementSource(el);
    const an = face.audioCtx.createAnalyser(); an.fftSize = 512;
    src.connect(an);                       // NOT connected to destination — the companion is the one speaking
    face.analyser = an; face.buf = new Uint8Array(an.fftSize); face.audioEl = el;
    el.muted = true;                       // belt and braces: this element must never be audible
    el.play().catch(() => {});
    el.addEventListener('ended', () => { face.analyser = null; face.buf = null; });
    face.target = 1; face.speakFrom = performance.now(); face.speakUntil = face.speakFrom + 60000;
    return true;
  } catch (e) { return false; }
}
const _faceCen = new THREE.Vector3(), _faceTint = new THREE.Color();
/*
 * TWO FACES SHARE THIS STATE AND ONLY ONE OF THEM HAS A TOGGLE.
 *
 * `FACE_ON` belongs to the PAINTED CLOUD face — the screen-space light folded into the point shader, default
 * OFF because a filled bright eye reads as a skull. But `updateVRMFace` drives the MODEL's visemes from
 * `face.mouthOpen` and its expression from `face.cur`, and this function used to `return` on !FACE_ON before
 * computing either. So the model blinked (that clock is inline) and never once opened its mouth: her lip-sync
 * was hostage to a switch that belongs to a different face.
 *
 * The state is a handful of scalars — free to keep current whether or not anything reads it. Only the
 * projection and the uniform push below are actually conditional.
 */
function updateFace(now) {
  try {
    // --- mouth: real amplitude if we have the wav, otherwise a syllable-rate envelope over the estimate ---
    let rms = 0, smooth;
    if (face.analyser) {
      face.analyser.getByteTimeDomainData(face.buf);
      let s = 0; for (let i = 0; i < face.buf.length; i++) { const v = (face.buf[i] - 128) / 128; s += v * v; }
      rms = Math.sqrt(s / face.buf.length);
    } else if (now < face.speakUntil) {
      const t = (now - face.speakFrom) / 1000;
      // A syllable rate with a slow wobble, so it never falls into a mechanical rhythm. Two things this has
      // to get right, both learned by MEASURING the resulting curve rather than reading the code:
      //   1. Emit RMS, the same scale the analyser branch produces, because both feed one shared
      //      amplitudeToMouth (gain 1.9, max 0.95). The old form carried a 0.30 FLOOR and peaked at 0.64 —
      //      after that gain it sat clamped at 0.79-0.95 forever. That is a jaw hanging open, not speech.
      //   2. Smooth it LIGHTLY. amplitudeToMouth exists to tame jittery wav RMS; this envelope is already
      //      smooth, and putting it through the same filter flattened the syllables back out (0.42-0.90 with
      //      zero full closes). Same reason you don't run a clean signal through a noise gate.
      // Measured as shipped: 0.08-0.92 with ~8 open/close cycles in 2.5s ≈ 3.2/sec, a conversational rate.
      rms = 0.52 * Math.abs(Math.sin(t * 11.5)) * (0.55 + 0.45 * Math.abs(Math.sin(t * 2.3 + 1.1)));
      smooth = { attack: 0.75, decay: 0.55 };
    }
    face.mouthOpen = AS ? AS.amplitudeToMouth(rms, face.mouthOpen, smooth) : Math.max(0, face.mouthOpen * 0.8 + rms * 0.2);
    const speaking = now < face.speakUntil || !!face.analyser;
    if (!speaking) face.target = FACE_REST;
    face.strength += (face.target - face.strength) * (face.target > face.strength ? 0.10 : 0.022);
    // --- expression easing + blink, from the avatar's own model ---
    for (const k of ['brow', 'eye', 'mouthCurve', 'gazeY']) face.cur[k] += ((face.tgt[k] || 0) - face.cur[k]) * 0.09;
    const blink = AS ? AS.blinkMultiplier(now) : 1;
    // ---- everything ABOVE is shared state (the VRM reads it). Everything BELOW is the painted cloud face. ----
    if (!FACE_ON) {
      if (nodeMat && nodeMat.uniforms.uFaceOn.value !== 0) for (const m of [nodeMat, haloMat, dustMat]) if (m) m.uniforms.uFaceOn.value = 0;
      return;
    }
    // --- where she sits on screen: project the cloud centre, size her to its extent, so she stays on the
    // cloud through pan and zoom instead of floating in a fixed screen box ---
    _faceCen.set(_midCen.x, _midCen.y, _midCen.z);
    const cam = Graph.camera(); if (!cam) return;
    const ndc = _faceCen.clone().project(cam);
    const camPos = Graph.cameraPosition();
    const dist = Math.hypot(camPos.x - _midCen.x, camPos.y - _midCen.y, camPos.z - _midCen.z) || 900;
    const fovR = (cam.fov || 50) * Math.PI / 180;
    const halfH = Math.tan(fovR / 2) * dist;                 // world half-height of the viewport at the cloud
    const faceR = Math.max(0.12, (CLOUD_R * 0.92) / Math.max(1, halfH));   // in NDC-y units
    const aspect = (window.innerWidth || 1) / (window.innerHeight || 1);
    for (const m of [nodeMat, haloMat, dustMat]) {
      if (!m) continue;
      const u = m.uniforms;
      u.uFaceOn.value = face.strength;
      u.uFaceCen.value.set(ndc.x, ndc.y); u.uFaceR.value = faceR; u.uAspect.value = aspect;
      u.uEye.value = Math.max(0.06, face.cur.eye * blink);
      u.uBrow.value = face.cur.brow; u.uMouthCurve.value = face.cur.mouthCurve;
      u.uMouthOpen.value = face.mouthOpen;
    }
  } catch (e) {}
}
// ============================================================================================================
// VRM SKIN — her own model, wearing the graph as its surface.
// ============================================================================================================
// Lucas, 2026-07-22: "I wonder if we could replace the 'skin' of the avatar model with the node and
// connections overlay." This is the answer to the thing I said was unsolvable three attempts running. My own
// note read: "points have no edge and no occlusion, so a glowing cloud reads as a nebula regardless of
// placement" — and every fix I tried was a way to make points imply a surface they could never imply. A MESH
// already is one. data/avatars/zoe.vrm has the silhouette, the occlusion, the landmarks and the rig, all of
// it authored, and the SDF/marching-cubes work I was heading toward was reinventing a worse version of a file
// already sitting in the repo.
//
// What makes it a skin rather than a backdrop: each node BINDS to a vertex of the model and is pinned to that
// vertex's DEFORMED position every frame. `getVertexPosition` applies morph targets and then bone skinning,
// so when the 'aa' viseme fires, the 1,436 face vertices it moves carry their nodes with them — measured, not
// assumed. Her links then span between bound nodes on their own, which is the "connections overlay": the
// wireframe over her face is real memory structure, not decoration.
//
// The mesh itself is drawn as a DEPTH-ONLY occluder (colorWrite false). Invisible, but it writes depth, so
// nodes on the far side of her head are hidden by the near side. That single line is the thing a point cloud
// could never do for itself, and it is what makes the figure read as solid instead of as a swarm.
// v3 = the Blender face-shape pass (cheeks −6.5% round→oval, chin +4mm, eyes/nose/mouth untouched), exported
// through the VRM addon and verified: visemes, humanoid and material names identical, geometry measured to
// 0.1mm of the Blender numbers. The COMPANION window still loads zoe.vrm — swapping that shared file is
// Lucas's call, and this constant keeps the two decisions separate. Falls back if v3 is ever removed.
// NEW ZOE — a proper adult base (Reallusion Character Creator character "Beth") converted to VRM in Blender:
// CC armature → VRM humanoid (21 bones), 148 CC morphs → VRM expressions (aa/ih/ou/ee/oh/blink/happy), naked
// (shoes + underwear removed), her own rigged hair kept. Lucas: "proportion mapping isn't going to work…
// convert the best of those two to what Zoe is supposed to look like." The deform-the-VRoid-mesh line (v1-v5)
// is retired — the ceiling was the childish low-poly base itself. Fallback chain ends at the original VRoid.
// zoe_beth_mod = the same model plus the MODESTY COVERAGE built as real geometry in Blender (two cups + briefs,
// cut clear of the heart) carrying a baked edge-distance in COLOR_0 for its trace lines. Falls back to the
// pre-coverage build if it is ever missing, so a bad export can never leave her without a body.
const VRM_URL = '../data/avatars/zoe_beth_mod.vrm';
const VRM_FALLBACK = '../data/avatars/zoe_beth.vrm';
// ANATOMY CARRIES MEANING (Lucas, 2026-07-22): "Short term memory can be the head, everything that is Zoe can
// be the heart, and the rest of the body is everything else." That turns the figure from a shape the data
// happens to sit on into a CLAIM about the data — the same principle as density-is-the-boundary, finally with
// an anatomy to say it in. Where a node lands is now determined by what it IS, never by a hash:
//   head  ← short-term memory (sq.db): what she is holding right now, behind the eyes
//   heart ← every `zoe` row (self_model): her identity, and nothing else is allowed in there
//   body  ← the Echo corpus: everything she knows, carried
const REGION = { head: [], heart: [], body: [] };
let featureAnchors = null;          // eye/mouth vertex sets, found from the model's OWN morph targets
const HEART_R = 0.11;               // metres in model space — a fist, about right for a heart
async function loadVRM() {
  if (vrmModel || _vrmLoading) return vrmModel;
  if (!window.GLTFLoader || !window.VRMLoaderPlugin) { console.warn('[kg3d] VRM loader absent — rebuild vendor/kg3d.bundle.js'); return null; }
  _vrmLoading = true;
  try {
    const loader = new window.GLTFLoader();
    loader.register((p) => new window.VRMLoaderPlugin(p));
    let gltf;
    try { gltf = await loader.loadAsync(VRM_URL); }
    catch (e) { console.warn('[kg3d] VRM v3 missing, falling back:', e && e.message); gltf = await loader.loadAsync(VRM_FALLBACK); }
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('no VRM payload in the gltf');
    // Same rest pose the companion uses: relax the default T-pose to arms-at-sides. Verified necessary — the
    // first bound render put her arms straight out, which reads as a mannequin rather than a person, and the
    // spread also wastes most of the frame's width on empty space between the arms and the body.
    try {
      const setBone = (name, z, x) => { const b = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode(name); if (b) b.rotation.set(x || 0, 0, z); };
      // one source of truth with the animation player: clips ADD onto exactly this resting pose
      for (const [bn, r] of Object.entries(BASE_POSE)) setBone(bn, r[2], r[0]);
      vrm.update(0.016);                            // push the pose into the skeleton before anything is bound
    } catch (e) {}
    // Scale the 1.69-unit model into the graph's own world so she stands at cloud scale.
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const h = Math.max(0.01, box.max.y - box.min.y);
    const k = (CLOUD_R * 2.35) / h;
    vrm.scene.scale.setScalar(k);
    vrm.scene.updateMatrixWorld(true);
    // Keep the centering offset rather than baking it into position — placeVRM rewrites position every time
    // the cloud middle moves, and would otherwise throw the centering away and leave her standing ON the
    // origin instead of centred in it.
    const b2 = new THREE.Box3().setFromObject(vrm.scene);
    _vrmOff.copy(b2.getCenter(new THREE.Vector3())).sub(vrm.scene.position).negate();
    vrm.scene.visible = false;                      // hidden until the skin shape is actually chosen
    // Depth-only occluders: one per unique geometry, so the far side of her is hidden by the near side.
    // NAKED, BY MATERIAL NAME (Lucas: "you can drop the geometry of the clothing and shoes, just design
    // naked"). The VRoid material names say exactly what each slice is, so this needs no geometry guessing:
    // *_CLOTH is the tops, bottoms, one-piece and both shoe slices; the EYE/brow/lash/eyeline/mouth slices are
    // the facial detail I already draw myself, and leaving them in put a second set of real eyes underneath my
    // drawn ones. What survives is SKIN and HAIR — her form, and nothing worn over it.
    // CLOTHING ONLY. My first pass also dropped the eye, brow, lash, eyeline and mouth slices on the theory
    // that I was drawing those myself — and the close-up showed what that actually produces: a ragged black
    // hole across her face with two white ovals hovering in it. Torn, not stylised. Her real features are far
    // better than anything I can draw over them, they already blink and lip-sync on the rig, and the Cortana
    // reference is a fully readable human face. So the geometry stays and gets SHADED; only clothes go.
    // Drop the eye overlays whose look lived entirely in their (now-stripped) alpha textures: the occlusion cup
    // and tear line drew opaque BLACK over the eyes and the cornea an opaque WHITE dome. The EYELASH mesh STAYS
    // now — its real diffuse+opacity texture is restored (data/avatars/tex/eyelash.png), so it draws as real
    // alpha lash strands instead of black wings; the node-art lashes are retired.
    const DROP = /_CLOTH|Eye_Occlusion|Tearline|Cornea/i;
    const seen = new Set();
    vrm.scene.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const name = (mats[0] && mats[0].name) || '';
      o.userData.matName = name;
      if (DROP.test(name)) { o.visible = false; return; }          // not drawn, not bound, not occluding
      o.material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true });
      o.renderOrder = -5;                           // depth laid down before the additive clouds draw
      o.frustumCulled = false;
      if (!seen.has(o.geometry.uuid)) { seen.add(o.geometry.uuid); vrmOccluders.push(o); }
    });
    scene.add(vrm.scene);
    vrmModel = vrm; vrmReady = true;
    // reproportion FIRST, so every anchor, exclusion radius and region downstream describes the corrected
    // body rather than the one that was in the file.

    reproportion(); findFeatures(); buildRegions(); buildDrawnFeatures();   // buildFaceStyle retired — real lashes now
    console.log('[kg3d] VRM skin ready —', vrmOccluders.length, 'meshes, scale', k.toFixed(1),
      '| head', REGION.head.length, 'heart', REGION.heart.length, 'body', REGION.body.length);
    return vrm;
  } catch (e) { console.warn('[kg3d] VRM load failed:', e && e.message); return null; }
  finally { _vrmLoading = false; }
}
// WHERE HER EYES AND MOUTH ARE, ASKED OF THE MODEL RATHER THAN GUESSED. Fire an expression, diff every
// vertex against rest, and the vertices that moved ARE the feature — 'aa' finds the mouth, 'blink' finds the
// eyelids. No magic coordinates, no per-model tuning, and it stays correct if the avatar is ever replaced.
// Searches EVERY face mesh, not the first one. The original file shared one 4,286-vert buffer across all
// eight face primitives, so any of them contained every vertex and sampling faces[0] worked by accident. The
// Blender VRM exporter splits primitives into their own buffers (skin = 2,266 verts, mouth, iris, …), so a
// feature now lives only on the mesh whose expression moves it — 'blink' moves nothing on the mouth primitive.
// Sampling faces[0] against the v3 export returned eyes:0 and silently dropped the eye exclusion zones.
// A "face mesh" is one the expressions actually deform. VRoid names them `Face_*`; CC merges the face into
// `CC_Base_Body` and drives it with 148 morph targets. Detecting by MORPH COUNT catches both and needs no
// per-avatar names — the >5 floor admits VRoid's 57 and CC's 148/114/119 rigs but rejects the 2-morph eyeball.
function isFaceMesh(m) {
  return /^Face/.test(m.name || '') || (m.morphTargetInfluences && m.morphTargetInfluences.length > 5);
}
// …but that morph-count test is far too broad to decide EXAGGERATION. On the CC model every body slice carries
// the same 148 morphs, so arms, legs, hair and nails all read as "face" and had their motion amplified 3.2x.
// Static, that was invisible; once the body ANIMATED, measured arm-bound nodes were flung up to 4.8 units off
// her surface — the glowing columns hanging beside her arms. Exaggeration exists to make lip-sync legible, so
// gate it on the mesh that actually carries the face.
function isFaceSkin(m) {
  const n = String((m.userData && m.userData.matName) || m.name || '');
  return /Std_Skin_Head|^Face/i.test(n);
}
function findFeatures() {
  const em = vrmModel.expressionManager; if (!em) return;
  const faces = vrmOccluders.filter(isFaceMesh);
  if (!faces.length) return;
  const zero = () => { for (const k of ['aa', 'blink', 'happy']) { try { em.setValue(k, 0); } catch (e) {} } };
  const sample = (mesh, expr) => {
    zero();
    if (expr) { try { em.setValue(expr, 1); } catch (e) {} }
    try { vrmModel.update(0.016); } catch (e) {}
    vrmModel.scene.updateMatrixWorld(true);
    const N = mesh.geometry.attributes.position.count;
    const out = new Float32Array(N * 3), v = new THREE.Vector3();
    for (let i = 0; i < N; i++) { try { mesh.getVertexPosition(i, v); } catch (e) {} out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z; }
    return out;
  };
  // For one expression: the mesh where it moves the MOST total distance owns the feature.
  const findOn = (expr, top) => {
    let best = null;
    for (const mesh of faces) {
      const rest = sample(mesh, null), d = sample(mesh, expr), idx = [];
      let sum = 0;
      const N = mesh.geometry.attributes.position.count;
      for (let i = 0; i < N; i++) {
        const dx = d[i * 3] - rest[i * 3], dy = d[i * 3 + 1] - rest[i * 3 + 1], dz = d[i * 3 + 2] - rest[i * 3 + 2];
        const m = dx * dx + dy * dy + dz * dz;
        if (m > 1e-12) { idx.push([i, m]); sum += Math.sqrt(m); }
      }
      if (!best || sum > best.sum) { idx.sort((a, b) => b[1] - a[1]); best = { mesh, rest, ids: idx.slice(0, top).map((p) => p[0]), sum }; }
    }
    return best;
  };
  const M = findOn('aa', 40), L = findOn('blink', 80);
  if (!M || !M.ids.length) return;
  const cen = (b, ids) => { const c = new THREE.Vector3(); for (const i of ids) c.add(new THREE.Vector3(b.rest[i * 3], b.rest[i * 3 + 1], b.rest[i * 3 + 2])); return ids.length ? c.divideScalar(ids.length) : c; };
  const mc = cen(M, M.ids);
  const lids = L ? L.ids : [];
  const left = lids.filter((i) => L.rest[i * 3] < mc.x), right = lids.filter((i) => L.rest[i * 3] >= mc.x);
  const spread = (b, ids, c) => { let r = 0; for (const i of ids) r = Math.max(r, Math.hypot(b.rest[i * 3] - c.x, b.rest[i * 3 + 1] - c.y, b.rest[i * 3 + 2] - c.z)); return r; };
  const lc = cen(L || M, left), rc = cen(L || M, right);
  featureAnchors = {
    mesh: M.mesh, eyeMesh: L ? L.mesh : M.mesh, mouth: M.ids, left, right,
    mouthR: spread(M, M.ids, mc) || 0.02, eyeR: Math.max(spread(L || M, left, lc), spread(L || M, right, rc)) || 0.015,
    rest: { mouth: mc, left: lc, right: rc },
  };
  zero();
  try { vrmModel.update(0.016); } catch (e) {}
}
// Classify every vertex once, in model space, using the RIG's own joints — the neck bone is where the head
// starts and the chest bone is where the heart sits, both authored into the file. Deriving those from y
// fractions of the bounding box would be a guess that breaks on any other avatar.
function buildRegions() {
  REGION.head.length = 0; REGION.heart.length = 0; REGION.body.length = 0;
  const H = vrmModel.humanoid;
  const bone = (n) => { try { const b = H && H.getNormalizedBoneNode(n); if (!b) return null; const p = new THREE.Vector3(); b.getWorldPosition(p); return p; } catch (e) { return null; } };
  vrmModel.scene.updateMatrixWorld(true);
  const neck = bone('neck') || bone('head');
  const chest = bone('upperChest') || bone('chest') || bone('spine');
  const inv = new THREE.Matrix4().copy(vrmModel.scene.matrixWorld).invert();
  const neckL = neck ? neck.clone().applyMatrix4(inv) : null;
  const chestL = chest ? chest.clone().applyMatrix4(inv) : null;
  const toLocal = new THREE.Matrix4(), v = new THREE.Vector3();
  // Exclusion zones around the drawn features, lifted into MODEL space so every mesh is tested in the same
  // coordinate system. Testing only the face mesh in its own space left 9-15 nodes sitting inside each eye:
  // HAIR hangs over the face, and hair vertices were never checked at all. Radii are generous — a node just
  // outside the outline still reads as debris in her eye.
  const fa = featureAnchors;
  const ex = [];
  let mouthL = null;
  if (fa) {
    // per-feature matrices: the mouth and the eyelids can live on DIFFERENT primitives (the v3 exporter
    // splits buffers per material), so each anchor is lifted through its own mesh's transform
    const mm = new THREE.Matrix4().multiplyMatrices(inv, fa.mesh.matrixWorld);
    const em2 = new THREE.Matrix4().multiplyMatrices(inv, (fa.eyeMesh || fa.mesh).matrixWorld);
    mouthL = fa.rest.mouth.clone().applyMatrix4(mm);
    ex.push([fa.rest.left.clone().applyMatrix4(em2), fa.eyeR * 2.6],
      [fa.rest.right.clone().applyMatrix4(em2), fa.eyeR * 2.6],
      [mouthL, fa.mouthR * 3.0]);
  }
  // THE HEART, PLACED PROPERLY (Lucas: "you don't know where the heart lives… center of her chest between the
  // neck line and the top of the bust, shaped a little smarter to style"). Front direction comes from the
  // mouth (it sits in front of the neck); the centre sits high, between neck and chest, pushed to the front
  // surface. Then a real 2D HEART silhouette (the valentine implicit) in the chest plane, front-hemisphere
  // only — a stylised heart on her sternum, not a fist-sized sphere sprawling down her belly.
  const up = new THREE.Vector3(0, 1, 0);
  let frontDir = null, rightDir = null, heartC = null;
  if (neckL && chestL) {
    frontDir = mouthL ? new THREE.Vector3(mouthL.x - neckL.x, 0, mouthL.z - neckL.z) : new THREE.Vector3(0, 0, 1);
    if (frontDir.lengthSq() < 1e-6) frontDir.set(0, 0, 1); frontDir.normalize();
    rightDir = new THREE.Vector3().crossVectors(frontDir, up).normalize();
    heartC = neckL.clone().lerp(chestL, 0.42);                    // high — just under the neckline
    heartC.add(frontDir.clone().multiplyScalar(0.075));           // out to the chest surface
  }
  // THE SUIT'S CUT, TAKEN FROM THE RIG. The neckline sits just under the neck joint and the hem just under the
  // hips, so the garment is skin-tight and correctly placed on ANY avatar rather than at guessed y fractions.
  const hipsB = bone('hips') || bone('spine');
  const hipsL = hipsB ? hipsB.clone().applyMatrix4(inv) : null;
  if (neckL && chestL) {
    shellUniforms.uSuitNeck.value = neckL.y - (neckL.y - chestL.y) * 0.30;     // collar, a little below the neck
    shellUniforms.uSuitCen.value.copy(chestL);
    if (frontDir) shellUniforms.uSuitFront.value.copy(frontDir);
  }
  if (hipsL) shellUniforms.uSuitHem.value = hipsL.y - (neckL ? (neckL.y - hipsL.y) * 0.10 : 0.06);
  const HEART_RX = 0.058, HEART_RY = 0.060;                       // half-width / half-height of the heart
  function inHeart(p) {
    if (!heartC) return false;
    const dx = p.x - heartC.x, dy = p.y - heartC.y, dz = p.z - heartC.z;
    if (dx * frontDir.x + dy * frontDir.y + dz * frontDir.z < -0.02) return false;   // front hemisphere only
    const hx = (dx * rightDir.x + dy * rightDir.y + dz * rightDir.z) / HEART_RX;      // horizontal
    const hy = (dy + HEART_RY * 0.30) / HEART_RY;                                     // vertical, shifted so the point sits low
    const a = hx * hx + hy * hy - 1.0;
    return a * a * a - hx * hx * hy * hy * hy < 0.0;               // valentine-heart implicit
  }
  for (const m of vrmOccluders) {
    const N = m.geometry.attributes.position.count;
    toLocal.multiplyMatrices(inv, m.matrixWorld);
    // ALL hair is short-term (Lucas: "the head and hair are short term memory"). Long hair hangs below the
    // neck, so the y>neck test alone left the lower strands classified as body; force the whole hair mesh to
    // the head region.
    const isHair = matKind(m.userData && m.userData.matName) === 1;
    // the coverage takes NO node seats — nodes stay on her skin and glow through it, which is the whole point
    const isCover = matKind(m.userData && m.userData.matName) === 7;
    // The same classification is written as a per-vertex ATTRIBUTE, so her surface can be shaded by what each
    // part of her MEANS. 0 body/face · 1 hair (short-term) · 2 heart. One pass, two consumers: the binding picks
    // seats from the arrays, the shell reads the attribute — they can never disagree about which part is which.
    const reg = new Float32Array(N);
    // …and her MODEL-space position per vertex, which is what lets the suit be cut by real body coordinates
    // (a fixed neckline/hem that stays put while she moves, instead of anything screen- or world-relative).
    const bod = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      try { m.getVertexPosition(i, v); } catch (e) { continue; }
      v.applyMatrix4(toLocal);
      bod[i * 3] = v.x; bod[i * 3 + 1] = v.y; bod[i * 3 + 2] = v.z;
      // FACE = BODY COLOUR, HAIR = SHORT-TERM (Lucas: "the face is still the same colour as the hair and not the
      // body"). Only HAIR carries the short-term violet; every skin vertex — face included — is corpus/body sky.
      // The eye and mouth patches are still excluded from BINDING (no node sits in an eye socket) but they shade
      // as body too, so the face reads as one skin surface instead of a violet mask seamed along the jaw.
      if (isCover) { reg[i] = 0; continue; }                                                                // coverage: no seats
      if (isHair) { reg[i] = 1; REGION.head.push({ mesh: m, vi: i, x: v.x, y: v.y, z: v.z }); continue; }   // hair = short-term
      if (ex.length && ex.some(([c, r]) => v.distanceTo(c) < r)) { reg[i] = 0; continue; }   // eyes + mouth: no bind, shade as face/body
      if (inHeart(v)) { reg[i] = 2; REGION.heart.push({ mesh: m, vi: i, x: v.x, y: v.y, z: v.z }); continue; }   // heart, high on the chest
      reg[i] = 0; REGION.body.push({ mesh: m, vi: i, x: v.x, y: v.y, z: v.z });                // ALL skin, face and body, is the corpus
    }
    m.geometry.setAttribute('aRegion', new THREE.BufferAttribute(reg, 1));
    m.geometry.setAttribute('aBody', new THREE.BufferAttribute(bod, 3));
  }
  // SPATIALLY EVEN SEATS. The raw pools hold every classified vertex, so dense mesh (fingers, toes, face)
  // held far more seats than smooth mesh (thighs, upper arms) — random binding then packed nodes into hands,
  // feet and head while the limbs stayed empty (measured: legs 20-32 nodes vs hips/hands 422). Voxel-downsample
  // each pool so every ~2.5cm cell of her body offers a similar number of seats regardless of how finely it is
  // modelled. Nodes now spread by SURFACE, not by vertex density — limbs fill in, extremities stop clustering.
  REGION.body = voxelEven(REGION.body, 0.028, 2);
  REGION.head = voxelEven(REGION.head, 0.020, 3);   // finer on the head — more surface detail to sit on
  REGION.heart = REGION.heart;                       // heart is tiny; leave it dense
  applyShellMaterial();
}
// Keep up to `perCell` seats per spatial cell, chosen deterministically so the seat set is stable across
// reloads. Cuts the over-dense clusters down to the same seat density as everywhere else.
function voxelEven(pool, cell, perCell) {
  if (!pool.length) return pool;
  const cells = new Map();
  for (const s of pool) {
    const key = Math.round(s.x / cell) + ',' + Math.round(s.y / cell) + ',' + Math.round(s.z / cell);
    let arr = cells.get(key); if (!arr) { arr = []; cells.set(key, arr); }
    if (arr.length < perCell) arr.push(s);
  }
  const out = []; for (const arr of cells.values()) for (const s of arr) out.push(s);
  return out;
}
// ============================================================================================================
// THE SHELL — her surface, coloured by the graph's own scheme instead of her skin and clothing textures.
// ============================================================================================================
// Lucas: "is it not possible to just make the avatar 3d and use the existing node and connection schemes to
// color her instead of the skin cloths textures?" Yes, and it is the right call: 1,650 nodes spread over a
// 30,000-vertex body is one point per eighteen vertices, which can never read as a solid figure however it is
// tuned. The mesh should carry the FORM and the nodes should be the highlights on it, not the whole substance.
//
// Region colours come straight from the anatomy: her head glows short-term violet, her heart Zoe rose, her
// body corpus sky — the same palette the cloud already uses, so the figure and the graph are visibly one
// system. FRESNEL does the work: facing surfaces stay near black and glancing ones light up, so she reads as
// a lit contour rather than a painted mannequin, and the eye and mouth patches are held dark on purpose so
// the drawn outlines have something to read against.
//
// Built with onBeforeCompile on a stock material rather than a bare ShaderMaterial. A SkinnedMesh with 57
// morph targets needs the whole skinning + morph pipeline in its vertex shader; three generates all of it for
// its own materials and none of it for a hand-written one, so patching is both shorter and correct.
// heart is a WARM, INVITING RED (Lucas), not the muddy rose it was. head short-term violet, body corpus sky.
const SHELL_COL = { body: 0x7dd3fc, head: 0xa78bfa, heart: 0xff4d5e };
let SHELL_ON = true; try { SHELL_ON = localStorage.getItem('kg3d.shell') !== '0'; } catch (e) {}
const shellUniforms = {
  uBody: { value: new THREE.Color(SHELL_COL.body) }, uHead: { value: new THREE.Color(SHELL_COL.head) },
  uHeart: { value: new THREE.Color(SHELL_COL.heart) },
  // uBase raised 0.055→0.14: the face is a flat, forward-facing surface, so fresnel (which needs a grazing
  // angle) barely fires on it and it read much darker than the curved body. A higher ambient floor lifts the
  // face to match the body without washing out the rim.
  uBase: { value: 0.14 }, uRim: { value: 1.2 }, uPow: { value: 2.4 }, uPulse: { value: 0 }, uScan: { value: 1 },
  // THE HOLOGRAM SUIT (Lucas, the Cortana trick): "stylize her to be naked while still looking clothed …
  // lines and light … nothing flowing, just skin tight … it will help subtle out the nipples a little."
  // Not geometry — the garment is PAINTED on her own surface, bounded by a real neckline and hem taken from
  // the rig's own joints, so it is skin-tight by construction and moves with her.
  // OFF. The shader-painted version was wrong (Lucas: "it's terrible, there's no way you set that up in
  // blender") — a garment cut by y-planes and fract() math is the same fakery the eyes and lashes already
  // failed at. The real suit is being built as GEOMETRY in Blender; this stays off until that lands.
  uSuitOn: { value: 0 }, uSuitAmt: { value: 0.85 },
  uSuitNeck: { value: 1.35 }, uSuitHem: { value: 0.78 }, uSuitScoop: { value: 0.055 },
  uSuitFront: { value: new THREE.Vector3(0, 0, 1) }, uSuitCen: { value: new THREE.Vector3(0, 1.1, 0) },
};
// Each slice is shaded by WHAT IT IS, read off the VRoid material name. Skin takes the region colour and the
// fresnel; hair goes solid so it reads as a mass and gives her a silhouette; the eyes are lit hard because a
// face without legible eyes is a mannequin; brow/lash/eyeline stay dark to draw the eye shape, which is the
// job they already do in the model. This is the Cortana read: translucent body, structure showing through,
// but a human face on top of it rather than a hole.
// Handles BOTH the VRoid (`EyeIris`, `_HAIR`, `FaceMouth`) and the Reallusion CC (`Std_Cornea`, `Std_Eye_L`,
// `Hair_Transparency`, `Std_Upper_Teeth`) naming, so the same shell shades either avatar. Order matters —
// the specific eye-detail patterns are tested before the broad iris match so a lash isn't read as an iris.
function matKind(name) {
  const n = String(name || '');
  if (/EyeHighlight/i.test(n)) return 4;
  if (/Cornea/i.test(n)) return 4;                                       // CC clear cornea → catchlight
  if (/Eyelash|Eyebrow|Eyeline|Tearline|Eye_?Occlusion|FaceBrow|FaceEyelash|FaceEyeline/i.test(n)) return 5;
  if (/EyeWhite|Sclera/i.test(n)) return 2;
  if (/EyeIris|Std_Eye_[LR]/i.test(n)) return 3;                         // VRoid iris | CC eyeball
  if (/Teeth|Tongue|FaceMouth/i.test(n)) return 6;
  if (/_HAIR|Hair_|Scalp/i.test(n)) return 1;
  if (/Modesty/i.test(n)) return 7;                                      // the coverage geometry
  return 0;                                           // skin (Std_Skin_*, Std_Nails, VRoid Body/Face SKIN)
}
// THE REAL Reallusion eye + lash maps (Lucas: the procedural iris + node-art lashes read as lazy/terrible —
// "fix it in Blender"). The VRM kept its UVs when its textures were stripped, so the full-res maps loaded
// straight from the app map correctly onto the same geometry. flipY:false = the glTF/VRM UV origin.
const _texLoader = new THREE.TextureLoader();
function _loadTex(url, srgb) { const t = _texLoader.load(url); t.flipY = false; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }
const EYE_TEX_L = _loadTex('../data/avatars/tex/eye_l.jpg', true);
const EYE_TEX_R = _loadTex('../data/avatars/tex/eye_r.jpg', true);
const LASH_TEX = _loadTex('../data/avatars/tex/eyelash.png', true);
// THE EYEBALL — the real iris, tinted GREEN, on a CLEAN sclera. The eye texture is the whole eyeball UV (iris
// centred, veiny sclera around it). We take the iris fibre detail from it but paint the sclera in her hair
// colour instead of the bloodshot white (Lucas: "doesn't need the blood shot white"), and lay a subtle ring
// of connection-NODES over the iris (Lucas: "circuit boards or mini connecting nodes could be good"). Built on
// MeshBasicMaterial so the SkinnedMesh keeps its skinning + morph pipeline (a bare ShaderMaterial gets none).
function makeEyeMaterial(m) {
  const name = (m.userData && m.userData.matName) || '';
  const tex = /Std_Eye_R|_R(_|$)/.test(name) ? EYE_TEX_R : EYE_TEX_L;
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, map: tex });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uHead = shellUniforms.uHead;
    sh.uniforms.uEyeTex = { value: tex };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec2 vEyeUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n vEyeUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n uniform vec3 uHead;\n uniform sampler2D uEyeTex;\n varying vec2 vEyeUv;')
      .replace('#include <dithering_fragment>', `
        vec2 d = vEyeUv - vec2(0.5);
        float rr = length(d);
        float ang = atan(d.y, d.x);
        float lum = dot(texture2D(uEyeTex, vEyeUv).rgb, vec3(0.299, 0.587, 0.114));
        vec3 irisG = vec3(lum) * vec3(0.34, 1.05, 0.52) * 1.55;             // real fibres, tinted green
        float ring = smoothstep(0.014, 0.0, abs(rr - 0.095));              // a ring inside the iris…
        float nodes = ring * smoothstep(0.45, 0.96, 0.5 + 0.5 * sin(ang * 20.0));   // …studded with nodes
        irisG += vec3(0.35, 1.0, 0.55) * nodes * 0.65;
        float irisM = smoothstep(0.125, 0.100, rr);                        // iris disc vs sclera (matches the map)
        vec3 col = mix(uHead * 0.9, irisG, irisM);                         // clean hair-colour sclera, no veins
        gl_FragColor = vec4(col, 1.0);
        #include <dithering_fragment>`);
  };
  mat.needsUpdate = true;
  return mat;
}
// THE LASHES — the real alpha strands. The png's alpha channel is the lash mask; discard everything else and
// paint the strands a soft cool tone so they READ as fine lashes on her dark, glowing face (a literal dark
// lash would vanish). Blinks + head-turn come free: the mesh is skinned + morph-driven like the lids.
function makeLashMaterial(m) {
  const mat = new THREE.MeshBasicMaterial({ map: LASH_TEX, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n')
      .replace('#include <dithering_fragment>', `
        // The strands are THIN and anti-aliased: the map has only 46 fully-opaque pixels, so a 0.30 cutoff
        // discarded every lash. Cut only true background and lift the partial alpha so fine strands read.
        float la = texture2D(map, vMapUv).a;
        if (la < 0.04) discard;
        float a = clamp(la * 1.7, 0.0, 1.0);
        gl_FragColor = vec4(vec3(0.60, 0.66, 0.82) * a, a);                // soft cool lash strands
        #include <dithering_fragment>`);
  };
  mat.needsUpdate = true;
  return mat;
}
// THE MODESTY COVERAGE (Lucas: "that's perfect shape … integrated so it doesn't block nodes and connections
// from view … good detail, maybe some trace lines on the edges"). Real geometry from Blender, shaded as LIGHT:
// additive with NO depth write, so it can only ever add glow — a node or a routed link behind it still reads
// straight through. Its trace lines come from a distance-to-edge baked into COLOR_0 in Blender, so they follow
// the true boundary of the cut instead of a shader guess.
function makeModestyMaterial() {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec3 vMN;\n varying vec3 vMP;')
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\n vMN = transformedNormal;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n vMP = mvPosition.xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n varying vec3 vMN;\n varying vec3 vMP;')
      .replace('#include <dithering_fragment>', `
        float d = vColor.r;                                    // 0 at the cut edge → 1 at 16mm inside
        float rim  = smoothstep(0.34, 0.0, d);                 // piping along the boundary
        float line = smoothstep(0.070, 0.0, abs(d - 0.55));    // a finer second trace inside it
        float fres = pow(1.0 - abs(dot(normalize(vMN), normalize(-vMP))), 2.0);
        float glow = rim * 1.15 + line * 0.65 + fres * 0.45;
        // It has to actually READ as coverage — at 0.085 it was invisible against her already-bright body and
        // she just looked nude with stray lines. Brightness costs nothing here: additive + no depth write means
        // nodes and links still come through it whatever this is set to.
        float fill = 0.34;
        vec3 col = vec3(0.46, 0.74, 1.0) * (fill + glow);
        gl_FragColor = vec4(col, min(1.0, fill + glow));
        #include <dithering_fragment>`);
  };
  mat.needsUpdate = true;
  return mat;
}
function applyShellMaterial() {
  for (const m of vrmOccluders) {
    const kind = matKind(m.userData && m.userData.matName);
    // real textured facial features instead of the graph shell (the rest of her stays the shell)
    if (kind === 3) { m.material = makeEyeMaterial(m); m.material.colorWrite = SHELL_ON; continue; }
    if (kind === 5) { m.material = makeLashMaterial(m); m.material.colorWrite = SHELL_ON; continue; }
    if (kind === 7) { m.material = makeModestyMaterial(); m.material.colorWrite = SHELL_ON; continue; }
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, shellUniforms);
      sh.uniforms.uKind = { value: kind };
      // The TORSO is its own mesh (Std_Skin_Body) — arms and legs are separate. Scoping the suit to that mesh
      // is exact, where any lateral-radius test would have painted the hem straight across her arms.
      sh.uniforms.uSuitMesh = { value: /Std_Skin_Body/i.test(String((m.userData && m.userData.matName) || '')) ? 1 : 0 };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n attribute float aRegion;\n attribute vec3 aBody;\n varying float vRegion;\n varying vec3 vBody;\n varying vec3 vVN;\n varying vec3 vVP;\n varying float vMY;')
        .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\n vRegion = aRegion;\n vBody = aBody;\n vVN = transformedNormal;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n vVP = mvPosition.xyz;\n vMY = (modelMatrix * vec4(transformed, 1.0)).y;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n uniform vec3 uBody; uniform vec3 uHead; uniform vec3 uHeart;\n uniform float uBase; uniform float uRim; uniform float uPow; uniform float uPulse; uniform float uKind; uniform float uScan;\n uniform float uSuitOn; uniform float uSuitAmt; uniform float uSuitNeck; uniform float uSuitHem; uniform float uSuitScoop; uniform float uSuitMesh;\n uniform vec3 uSuitFront; uniform vec3 uSuitCen;\n varying float vRegion; varying vec3 vBody; varying vec3 vVN; varying vec3 vVP; varying float vMY;')
        .replace('#include <dithering_fragment>', `
          // heart is region 2 ONLY; region 3 (eye/mouth exclusion) must not read as heart or the CC face goes
          // maroon (its mouth morph moves a wide area, so ~400 face verts land in region 3).
          vec3 rc = (vRegion > 1.5 && vRegion < 2.5) ? uHeart * (1.0 + uPulse * 0.9)
                  : vRegion > 0.5 ? uHead : uBody;
          float fres = pow(1.0 - abs(dot(normalize(vVN), normalize(-vVP))), uPow);
          float amt = uBase + fres * uRim;
          vec3 outc;
          if (uKind < 0.5)      outc = rc * amt;                                    // skin
          else if (uKind < 1.5) outc = rc * (0.16 + fres * 0.75);                   // hair: a readable mass
          // Eyes lit enough to READ (Lucas: "eyes might help") but not blown to skull-orbs: a soft blue-white
          // sclera, a brighter cyan iris, a crisp catchlight. At full-body scale they read as eyes; up close
          // they hold as eyes rather than glowing balls.
          else if (uKind < 2.5) outc = uHead * 0.85;                                // sclera → hair colour
          // THE EYEBALL, SHADED PROCEDURALLY (Lucas: "green iris like before and the whites would match the
          // hair colour"). The stripped texture took the sclera/iris/pupil split with it, so it is rebuilt from
          // the geometry: the disc facing the viewer is the green iris with a dark pupil at its centre, the ring
          // around it is the hair-coloured white, and a glassy catchlight keeps the eye wet rather than dead.
          else if (uKind < 3.5) {
            // THE DATA-IRIS (Lucas's reference: a green iris made of glowing nodes + radial connections). Her
            // eye is built from the graph like the rest of her: dense radial connection-fibres running out from
            // the pupil, a ring of nodes near the rim, a centre-to-rim gradient and a dark limbal ring, a small
            // round pupil and a bright catchlight. facing is the view-radial coordinate, ang the screen angle.
            vec3  N = normalize(vVN);
            float facing = abs(dot(N, normalize(-vVP)));
            float rad = sqrt(max(0.0, 1.0 - facing * facing));                      // 0 at centre → grows to the rim
            float ang = atan(N.y, N.x);
            vec3  sclera = uHead * 0.80;                                            // whites take the HAIR colour
            float irisM = smoothstep(0.70, 0.79, facing);                          // a LARGE iris, filling the eye
            float pupil = smoothstep(0.958, 0.982, facing);                        // a small round pupil
            float t = clamp((rad - 0.19) / 0.52, 0.0, 1.0);                        // 0 at the pupil edge → 1 at the iris rim
            float fibre = 0.55 + 0.45 * sin(ang * 46.0);                           // fine radial connection-fibres
            fibre = mix(0.62, 1.18, pow(max(0.0, fibre), 1.6));
            float ring = smoothstep(0.11, 0.0, abs(t - 0.78));                     // a band near the rim…
            float nodes = ring * smoothstep(0.15, 0.9, 0.5 + 0.5 * sin(ang * 22.0));   // …studded with nodes
            float grad = mix(0.42, 1.15, smoothstep(0.0, 0.45, t)) * mix(1.0, 0.55, smoothstep(0.72, 1.0, t));
            vec3  green = vec3(0.10, 0.80, 0.38);
            vec3  iris = green * (grad * fibre) + green * nodes * 1.5;
            iris *= 1.0 - smoothstep(0.86, 1.0, t) * 0.55;                          // dark limbal ring at the edge
            outc = mix(sclera, iris, irisM);
            outc = mix(outc, vec3(0.01, 0.02, 0.02), pupil);
            outc += vec3(0.92, 0.97, 1.0) * pow(max(0.0, facing - 0.55), 5.0) * 0.35;   // bright glassy catchlight
          }
          else if (uKind < 4.5) outc = vec3(0.9, 0.95, 1.0);                        // catchlight (VRoid highlight)
          else if (uKind < 5.5) outc = rc * 0.10;                                   // brow / lash / eyeline
          else                  outc = mix(rc, vec3(1.0, 0.62, 0.72), 0.65) * 0.85; // lips
          // --- THE HOLOGRAM SUIT: clothes made of her own light (Lucas's Cortana note) ---
          // A garment reads by its EDGES, so the neckline and hem are drawn as bright seams and the panel
          // between them carries a fine contour weave. Torso mesh only; the heart (region 2) is left clear so
          // her identity still burns through the cloth.
          if (uKind < 0.5 && uSuitMesh > 0.5 && uSuitOn > 0.5 && vRegion < 0.5) {
            vec3 rel = vBody - uSuitCen;
            float fz = dot(normalize(vec3(rel.x, 0.0, rel.z) + vec3(1e-5)), uSuitFront);   // +1 front, -1 back
            float neckY = uSuitNeck - max(0.0, fz) * uSuitScoop;                           // scooped at the front
            float panel = smoothstep(uSuitHem - 0.010, uSuitHem + 0.010, vBody.y)
                        * (1.0 - smoothstep(neckY - 0.010, neckY + 0.010, vBody.y));
            if (panel > 0.001) {
              float hb = abs(fract(vBody.y * 105.0) - 0.5) * 2.0;                          // contour weave
              float hl = smoothstep(0.74, 1.0, hb);
              float ang = atan(rel.x, rel.z);
              float vb = abs(fract(ang * 2.2) - 0.5) * 2.0;                                // vertical seams
              float vl = smoothstep(0.93, 1.0, vb);
              float weave = max(hl * 0.65, vl);
              vec3 suitC = mix(rc, vec3(0.60, 0.80, 1.0), 0.42);
              outc = mix(outc, suitC * (0.50 + weave * 1.45), panel * uSuitAmt);
            }
            float edge = smoothstep(0.008, 0.0, abs(vBody.y - uSuitHem));
            edge = max(edge, smoothstep(0.008, 0.0, abs(vBody.y - neckY)));
            outc += vec3(0.55, 0.85, 1.0) * edge * 0.85 * uSuitAmt;                        // the seams
          }
          // a slow horizontal banding, the one borrowed cue that reads instantly as "projected, not filmed"
          outc *= 1.0 + uScan * 0.16 * sin(vMY * 0.14);
          gl_FragColor = vec4(outc, 1.0);
          #include <dithering_fragment>`);
    };
    mat.needsUpdate = true;
    m.material = mat;
    m.material.colorWrite = SHELL_ON;                 // off → depth-only occluder, exactly as before
  }
}
function setShell(on) {
  SHELL_ON = !!on;
  try { localStorage.setItem('kg3d.shell', SHELL_ON ? '1' : '0'); } catch (e) {}
  for (const m of vrmOccluders) if (m.material) m.material.colorWrite = SHELL_ON;
}
// DRAWN, NOT BUILT OUT OF NODES (Lucas: "the face is actually terrifying — what if the eyes and the mouth are
// not nodes, but just drawn to look like them"). He is right about the failure and right about the fix. Nodes
// are bright blobs; two bright blobs where eyes belong is a skull, and no amount of tuning rescues that,
// because the thing reading as wrong is the FILLED-NESS. A real eye is mostly dark with a lit edge.
// So the features are LINE ART: lens-shaped outlines, drawn, with the node cloud excluded from those patches
// entirely. Three line loops, no fill, nothing glowing where a pupil should be.
let drawnFeatures = null;
function lensLoop(segments, hOpen) {                // an eye/mouth outline: two arcs meeting at the corners
  const pts = [];
  for (let i = 0; i <= segments; i++) { const t = -1 + 2 * (i / segments); pts.push(new THREE.Vector3(t, Math.pow(Math.max(0, 1 - t * t), 0.55) * hOpen, 0)); }
  for (let i = segments; i >= 0; i--) { const t = -1 + 2 * (i / segments); pts.push(new THREE.Vector3(t, -Math.pow(Math.max(0, 1 - t * t), 0.80) * hOpen * 0.34, 0)); }
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  return g;
}
function buildDrawnFeatures() {
  if (!featureAnchors || drawnFeatures) return;
  const mk = (hex, w) => new THREE.LineBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, linewidth: w || 1 });
  // THEY READ AS SPECTACLES AT 0.62. A closed lens that tall is a circle, two of them side by side are
  // glasses, and drawn in bright white they were the loudest thing on her face. An eye is WIDE and shallow
  // with a lifted upper lid; 0.30 with the lower arc at a third of that gives the almond. Colour pulled well
  // off white so they sit in the face instead of hovering in front of it.
  const eyeGeo = lensLoop(22, 0.30), mouthGeo = lensLoop(24, 1.0);
  const eyeL = new THREE.Line(eyeGeo, mk(0x8fd0ff)), eyeR = new THREE.Line(eyeGeo.clone(), mk(0x8fd0ff));
  const mouth = new THREE.Line(mouthGeo, mk(ZOE_ROSE));
  for (const o of [eyeL, eyeR, mouth]) { o.frustumCulled = false; o.renderOrder = 6; o.visible = false; scene.add(o); }
  drawnFeatures = { eyeL, eyeR, mouth };
}
// The features ride the mesh: their positions are the live average of the very vertices that define them, so
// they follow head turn, skinning and morphs without a single hard-coded offset.
const _fp = new THREE.Vector3(), _fq = new THREE.Quaternion();
function anchorPos(ids, out) {
  const m = featureAnchors.mesh; out.set(0, 0, 0);
  if (!ids.length) return out;
  for (const i of ids) { try { m.getVertexPosition(i, _fp); out.add(_fp); } catch (e) {} }
  return out.divideScalar(ids.length).applyMatrix4(m.matrixWorld);
}
function updateDrawnFeatures(now) {
  if (!drawnFeatures || !featureAnchors) return;
  // OFF. Her own eyes and mouth are back and they blink and lip-sync on the rig, so drawn outlines on top are
  // a second set of features fighting the real ones. The anchor-finding stays — it is what keeps NODES out of
  // her eye sockets, which was always the part that mattered.
  const show = false;
  for (const k of ['eyeL', 'eyeR', 'mouth']) drawnFeatures[k].visible = show;
  if (!show) return;
  const head = vrmModel.humanoid && vrmModel.humanoid.getNormalizedBoneNode('head');
  if (head) head.getWorldQuaternion(_fq); else _fq.identity();
  const s = (vrmModel.scene.scale.x || 1);
  const blink = AS ? AS.blinkMultiplier(now) : 1;
  const set = (obj, ids, baseR, openY) => {
    anchorPos(ids, obj.position);
    obj.quaternion.copy(_fq);
    obj.scale.set(baseR * s * 2.0, Math.max(0.04, openY) * baseR * s * 2.0, 1);
  };
  // 1.35, not 2.0: the outline was drawn wider than the socket it sits in, which is most of why it read as
  // eyewear rather than as an eye.
  set(drawnFeatures.eyeL, featureAnchors.left, featureAnchors.eyeR * 1.35 / 2.0, Math.max(0.08, blink));
  set(drawnFeatures.eyeR, featureAnchors.right, featureAnchors.eyeR * 1.35 / 2.0, Math.max(0.08, blink));
  // the mouth OPENS with her voice — the one feature that has to move to read as speech
  set(drawnFeatures.mouth, featureAnchors.mouth, featureAnchors.mouthR, 0.12 + face.mouthOpen * 1.5);
}
// ============================================================================================================
// FAKE STYLE-NODES ON THE FACE — the lashes, made of nodes + connections like the rest of her (Lucas).
// ============================================================================================================
// The solid eyelash mesh is dropped (it drew as heavy black wings); the lash line is redrawn as node-art:
// a bright mote at the base of each lash with a fine connection "wisp" that trails off to a dead end. It rides
// the upper-lid vertices (found by the blink diff), so it blinks and turns WITH her. First of the north-star's
// "fake nodes for style on the face" — and the same trick will seed the conversational ripple later.
let faceStyle = null;
const LASH_COL = new THREE.Color(0xc9b8ff);        // lash node-art: a light violet, tied to her hair/sclera
function buildFaceStyle() {
  if (faceStyle) { scene.remove(faceStyle.rootPts); scene.remove(faceStyle.wispLines); faceStyle.rootGeo.dispose(); faceStyle.wispGeo.dispose(); faceStyle = null; }
  if (!featureAnchors) return;
  const mesh = featureAnchors.eyeMesh || featureAnchors.mesh; if (!mesh) return;
  const v = new THREE.Vector3();
  const worldOf = (i) => { mesh.getVertexPosition(i, v); return v.clone().applyMatrix4(mesh.matrixWorld); };
  const lashes = [];
  for (const pair of [['L', featureAnchors.left], ['R', featureAnchors.right]]) {
    const eye = pair[0], ids = pair[1]; if (!ids || !ids.length) continue;
    const pts = ids.map((i) => ({ i, p: worldOf(i) }));
    const cen = new THREE.Vector3(); for (const q of pts) cen.add(q.p); cen.divideScalar(pts.length);
    const upper = pts.filter((q) => q.p.y >= cen.y).sort((a, b) => a.p.x - b.p.x);   // the upper lid = the lash line
    const src = upper.length ? upper : pts;
    const step = Math.max(1, Math.floor(src.length / 18));                            // a fuller lash line, even along the lid
    for (let k = 0; k < src.length; k += step) lashes.push({ i: src[k].i, eye });
  }
  const N = lashes.length; if (!N) return;
  const rootGeo = new THREE.BufferGeometry(); rootGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  const wispGeo = new THREE.BufferGeometry();
  wispGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3));
  wispGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 6), 3));
  const rootPts = new THREE.Points(rootGeo, new THREE.PointsMaterial({ map: SPARK_TEX, color: LASH_COL.getHex(), size: 8, sizeAttenuation: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
  const wispLines = new THREE.LineSegments(wispGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
  rootPts.frustumCulled = false; wispLines.frustumCulled = false; rootPts.renderOrder = 7; wispLines.renderOrder = 7;
  scene.add(rootPts); scene.add(wispLines);
  faceStyle = { lashes, mesh, rootGeo, rootPts, wispGeo, wispLines, N, _sized: 0 };
  updateFaceStyle(performance.now());
}
const _fsV = new THREE.Vector3(), _fsQ = new THREE.Quaternion(), _fsUp = new THREE.Vector3(), _fsDir = new THREE.Vector3(), _fsRight = new THREE.Vector3(), _fsTmp = new THREE.Vector3();
function updateFaceStyle() {
  if (!faceStyle) return;
  const on = SHAPE === 'skin' && vrmReady;
  faceStyle.rootPts.visible = on; faceStyle.wispLines.visible = on;
  if (!on) return;
  const mesh = faceStyle.mesh, L = faceStyle.lashes;
  const head = vrmModel.humanoid && vrmModel.humanoid.getNormalizedBoneNode('head');
  if (head) head.getWorldQuaternion(_fsQ); else _fsQ.identity();
  _fsUp.set(0, 1, 0).applyQuaternion(_fsQ);                                          // her up, so wisps splay up even when she turns
  // live root world positions + per-eye centre
  const world = new Array(L.length); const cenL = new THREE.Vector3(), cenR = new THREE.Vector3(); let nL = 0, nR = 0;
  for (let k = 0; k < L.length; k++) {
    mesh.getVertexPosition(L[k].i, _fsV); _fsV.applyMatrix4(mesh.matrixWorld); world[k] = _fsV.clone();
    if (L[k].eye === 'L') { cenL.add(_fsV); nL++; } else { cenR.add(_fsV); nR++; }
  }
  if (nL) cenL.divideScalar(nL); if (nR) cenR.divideScalar(nR);
  let eyeR = 1; for (let k = 0; k < world.length; k++) eyeR = Math.max(eyeR, world[k].distanceTo(L[k].eye === 'L' ? cenL : cenR));
  const len = eyeR * 1.05;
  // each eye's lashes sweep up-and-OUTWARD (toward the temple), never toward the nose — a consistent sweep reads
  // as lashes where a radial fan from the eye centre read as a sunburst. `_fsRight` is her right in world space.
  _fsRight.set(1, 0, 0).applyQuaternion(_fsQ);
  const midX = cenL.clone().add(cenR).multiplyScalar(0.5);
  const sideL = Math.sign(cenL.clone().sub(midX).dot(_fsRight)) || -1;
  const sideR = Math.sign(cenR.clone().sub(midX).dot(_fsRight)) || 1;
  const rp = faceStyle.rootGeo.attributes.position.array, wp = faceStyle.wispGeo.attributes.position.array, wc = faceStyle.wispGeo.attributes.color.array;
  for (let k = 0; k < world.length; k++) {
    const w = world[k], c = L[k].eye === 'L' ? cenL : cenR;
    rp[k * 3] = w.x; rp[k * 3 + 1] = w.y; rp[k * 3 + 2] = w.z;
    // up (0.92) + outward toward the temple (0.42) + a gentle fan from the lash's own offset (0.16)
    _fsDir.copy(_fsUp).multiplyScalar(0.92).addScaledVector(_fsRight, (L[k].eye === 'L' ? sideL : sideR) * 0.42);
    _fsTmp.copy(w).sub(c); if (_fsTmp.lengthSq() > 1e-6) _fsDir.addScaledVector(_fsTmp.normalize(), 0.16);
    _fsDir.normalize();
    const o = k * 6;
    wp[o] = w.x; wp[o + 1] = w.y; wp[o + 2] = w.z;
    wp[o + 3] = w.x + _fsDir.x * len; wp[o + 4] = w.y + _fsDir.y * len; wp[o + 5] = w.z + _fsDir.z * len;
    wc[o] = LASH_COL.r; wc[o + 1] = LASH_COL.g; wc[o + 2] = LASH_COL.b;                // bright at the root…
    wc[o + 3] = 0; wc[o + 4] = 0; wc[o + 5] = 0;                                        // …dead end at the tip
  }
  faceStyle.rootGeo.attributes.position.needsUpdate = true;
  faceStyle.wispGeo.attributes.position.needsUpdate = true; faceStyle.wispGeo.attributes.color.needsUpdate = true;
  const wantSize = Math.max(3, eyeR * 0.5);
  if (Math.abs(faceStyle._sized - wantSize) > 0.5) { faceStyle.rootPts.material.size = wantSize; faceStyle._sized = wantSize; }
}
// ============================================================================================================
// ROUTED LINKS — a connection travels along her, never across the gap beside her.
// ============================================================================================================
// Lucas: "you'll need to plan the connection points on a curve to match the body contour and if something
// connects across limbs you'll need to route it the long way through the body and not in the space between."
// Exactly right, and it is two different problems wearing one coat:
//
//   NEAR pairs sit on the same part of her, and a straight segment between them cuts UNDER the surface —
//   through the arm rather than along it. Bowing the midpoint out to the average surface radius puts the
//   curve back on her skin, so short links read as contour lines.
//
//   FAR pairs are the ones that made a skirt. A straight hand-to-knee chord is a bright wire hanging in the
//   air beside her body. Routed through the SKELETON instead — hand → forearm → upper arm → shoulder → chest
//   → hips → thigh → knee — it becomes an interior path, which is both what he asked for and what a nerve
//   actually does. The bones are already in the file; nothing here is invented geometry.
const BONE_PARENT = {
  hips: null, spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck',
  leftShoulder: 'upperChest', leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightShoulder: 'upperChest', rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg',
};
let bonePos = null;                                 // bone name → world position, refreshed with her
function refreshBones() {
  if (!vrmModel || !vrmModel.humanoid) { bonePos = null; return; }
  bonePos = new Map();
  for (const name of Object.keys(BONE_PARENT)) {
    try {
      const b = vrmModel.humanoid.getNormalizedBoneNode(name);
      if (!b) continue;
      const p = new THREE.Vector3(); b.getWorldPosition(p); bonePos.set(name, p);
    } catch (e) {}
  }
  // A missing optional joint would silently break every path that crosses it; fall its children up instead.
  for (const [k, par] of Object.entries(BONE_PARENT)) { if (bonePos.has(k) && par && !bonePos.has(par)) bonePos.set(par, bonePos.get(k).clone()); }
}
function nearestBone(p) {
  if (!bonePos || !bonePos.size) return null;
  let best = null, bd = Infinity;
  for (const [n, bp] of bonePos) { const d = p.distanceToSquared(bp); if (d < bd) { bd = d; best = n; } }
  return best;
}
function bonePath(a, b) {                           // a → common ancestor → b, the long way round
  if (!a || !b) return [];
  if (a === b) return [a];
  const up = (n) => { const c = []; let x = n, guard = 0; while (x && guard++ < 12) { c.push(x); x = BONE_PARENT[x]; } return c; };
  const ca = up(a), cb = up(b);
  const set = new Set(cb);
  let common = null;
  for (const n of ca) if (set.has(n)) { common = n; break; }
  if (!common) return [a, b];
  const left = []; for (const n of ca) { left.push(n); if (n === common) break; }
  const right = []; for (const n of cb) { if (n === common) break; right.push(n); }
  right.reverse();
  return left.concat(right);
}
let routedGeo = null, routedLines = null;
const ROUTE_SAMPLES = 12;                           // points per link; 11 segments
const SKIN_LINK_BOOST = 5.0;                        // routed links on her body read at full presence, not hairball-dim
function buildRoutedLinks() {
  if (routedLines) { scene.remove(routedLines); routedGeo.dispose(); routedLines.material.dispose(); routedLines = null; routedGeo = null; }
  if (SHAPE !== 'skin' || !vrmReady || !linkIndex || !linkIndex.length) return;
  refreshBones();
  if (!bonePos || !bonePos.size) return;
  const segs = ROUTE_SAMPLES - 1, N = linkIndex.length;
  const pos = new Float32Array(N * segs * 6), col = new Float32Array(N * segs * 6);
  const A = new THREE.Vector3(), B = new THREE.Vector3(), mid = new THREE.Vector3(), dir = new THREE.Vector3();
  let w = 0;
  for (let i = 0; i < N; i++) {
    const l = linkIndex[i], s = l.source, t = l.target;
    if (!s || !t || typeof s !== 'object' || !Number.isFinite(s.x) || !Number.isFinite(t.x)) { w += segs * 6; continue; }
    A.set(s.x, s.y, s.z || 0); B.set(t.x, t.y, t.z || 0);
    const ba = nearestBone(A), bb = nearestBone(B);
    const path = bonePath(ba, bb);
    const pts = [A.clone()];
    if (path.length <= 1) {
      // same bone: bow the midpoint out to the surface so the curve lies ON her, not inside her
      const bp = bonePos.get(ba) || mid.set(0, 0, 0);
      mid.addVectors(A, B).multiplyScalar(0.5);
      dir.subVectors(mid, bp);
      const r = (A.distanceTo(bp) + B.distanceTo(bp)) * 0.5;
      if (dir.lengthSq() > 1e-6) pts.push(bp.clone().add(dir.normalize().multiplyScalar(r)));
    } else {
      for (const n of path) { const bp = bonePos.get(n); if (bp) pts.push(bp.clone()); }   // interior, through her
    }
    pts.push(B.clone());
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    const sampled = curve.getPoints(segs);
    // colour carries over from the straight cloud, and long routes still fade — a path through her body
    // should read as a deep trace, not as the brightest thing on screen
    const cb = i * 6;
    // Bright enough to READ on her body (Lucas: "I see no edge connections"). The straight-cloud brightness
    // (~0.085) is tuned for a dense hairball where overlap accumulates into filament; on her skin the routed
    // links are sparse contour lines and need a real boost, or they vanish into the shell. Long interior routes
    // still fade relative to short surface ones, just not to nothing.
    const kr = (path.length > 2 ? 0.6 : 1.0) * SKIN_LINK_BOOST;
    for (let j = 0; j < segs; j++) {
      const p0 = sampled[j], p1 = sampled[j + 1];
      pos[w] = p0.x; pos[w + 1] = p0.y; pos[w + 2] = p0.z;
      pos[w + 3] = p1.x; pos[w + 4] = p1.y; pos[w + 5] = p1.z;
      for (let v = 0; v < 3; v++) { col[w + v] = (linkBaseCol ? linkBaseCol[cb + v] : 0.2) * kr; col[w + 3 + v] = (linkBaseCol ? linkBaseCol[cb + 3 + v] : 0.2) * kr; }
      w += 6;
    }
  }
  routedGeo = new THREE.BufferGeometry();
  routedGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  routedGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // depthTest OFF on purpose. The links route the long way THROUGH her body (Lucas), which put them behind her
  // own front surface — so depth-testing hid every interior trace inside her and the connections vanished ("I
  // see no edge connections"). Drawn without the depth test and added over the dark shell, they glow THROUGH
  // her like a nervous system: the corpus's connections are visible running inside the body they compose.
  routedLines = new THREE.LineSegments(routedGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
  routedLines.frustumCulled = false; scene.add(routedLines);
}
function setRoutedVisible(on) {
  if (routedLines) routedLines.visible = on;
  if (linkLines) linkLines.visible = !on;           // the straight cloud steps aside; both would double-draw
}
// ============================================================================================================
// PROPORTIONS — reading as a woman rather than as a child.
// ============================================================================================================
// Lucas: "The original avatar looked ok in that childish anime way, this will need some real feature curves to
// read woman and not child." The two signatures are measurable rather than a matter of taste, which is why
// this is worth doing in code instead of arguing about:
//
//   HEAD-TO-BODY RATIO. Stylised anime sits near 6.5 heads tall; adult human figure drawing uses 7.5-8. That
//   single number does more work than any facial detail, because it is read from the silhouette at any
//   distance — including the full-body framing this surface actually uses.
//   EYE SCALE. VRoid eyes are enormous by design; large eyes set low in a short face is the neotenous cue the
//   eye reads as "child" before it reads anything else.
//
// Both are applied to the model at load — bone scale for the head, a geometry edit for the eyes — so
// everything downstream (binding, regions, features) measures the corrected body.
const HEAD_K = 0.86;
function reproportion() {
  // VRoid-ONLY. This shrinks the head to fix VRoid's ~6.5-head child proportion; the CC/Beth body is already
  // an adult 7.5-head figure, so shrinking her head would BREAK correct proportions. Gate on a VRoid face
  // mesh being present (CC has none), so the same load path leaves an adult model untouched.
  const isVRoid = vrmOccluders.some((m) => /^Face/.test(m.name || ''));
  if (!isVRoid) return;
  // 1. HEAD. Scaling the head bone shrinks the skull and everything skinned to it (hair included) while the
  //    body keeps its length, which raises the head count without touching a single vertex.
  try {
    const hb = vrmModel.humanoid && vrmModel.humanoid.getNormalizedBoneNode('head');
    if (hb) hb.scale.setScalar(HEAD_K);
  } catch (e) {}
  // 2. EYES — ATTEMPTED AND REVERTED, and the failure is worth recording rather than retrying.
  //    Scaling eye-region vertices toward each eye's centre (with the morph deltas scaled to match) collapsed
  //    her eyes to two pinpricks and left a blank mask. The vertex maths was not obviously wrong; the problem
  //    is that the eight Face slices do not share one vertex layout, so a centre measured on one slice pulls
  //    the others toward the wrong point — and there is no way to SEE that from inside a renderer. Reshaping a
  //    rigged, morph-targeted face by scripting vertex arithmetic, with no viewport, no symmetry, no
  //    proportional falloff and no undo, is the wrong instrument for the job. It belongs in a modelling tool,
  //    edited once and re-exported, not recomputed on every load. See the Blender note in the session summary.
  try { vrmModel.update(0.016); } catch (e) {}
  vrmModel.scene.updateMatrixWorld(true);
}
function placeVRM() {                               // keep her centred on the live cloud middle
  if (!vrmModel) return;
  vrmModel.scene.position.set(_midCen.x + _vrmOff.x, _midCen.y + _vrmOff.y, _midCen.z + _vrmOff.z);
  vrmModel.scene.updateMatrixWorld(true);
}
// Bind each node to a vertex. Deterministic from the node id, so an object keeps its place on her body across
// reloads instead of the whole surface reshuffling every time the corpus refreshes.
// A node's REGION is decided by what it is; only its seat WITHIN that region is hashed. So an object cannot
// drift from her head to her arm because the corpus reloaded — but it keeps a stable seat across reloads.
function regionOf(n) {
  if (n.zoe) return 'heart';                        // self_model — her identity, and only ever this
  if (n.store === 'sidequest') return 'head';       // short-term: what she is holding right now
  return 'body';                                    // the Echo corpus: everything she knows, carried
}
function buildSkinBinding() {
  if (!vrmReady) { skinBinds = null; return 0; }
  const nodes = Graph.graphData().nodes;
  if (!nodes.length || !REGION.body.length) { skinBinds = null; return 0; }
  skinBinds = [];
  const counts = { head: 0, heart: 0, body: 0 };
  for (const n of nodes) {
    let r = regionOf(n);
    let pool = REGION[r];
    if (!pool || !pool.length) { r = 'body'; pool = REGION.body; }     // an empty region falls back, never drops a node
    const v = pool[Math.floor(hashSeed(n.id + '#seat') * pool.length) % pool.length];
    counts[r]++;
    // Only FACE binds get exaggerated. The morph targets live on the face mesh; hair and body move by bone
    // skinning and VRM spring physics, which never settle exactly back to rest — measured 3.85 units of
    // residual drift at rest, and amplifying that would give her permanently twitching hair. Magnify the
    // expression, leave the physics honest.
    skinBinds.push({ node: n, mesh: v.mesh, vi: v.vi, region: r, rest: new THREE.Vector3(), exag: isFaceSkin(v.mesh) });
  }
  captureSkinRest();
  skinBinds._counts = counts;
  return skinBinds.length;
}
// Rest pose per bound vertex, captured with every expression at zero. Deformation is then measured against
// it and AMPLIFIED — because at true scale it does not read: measured, opening the mouth fully moves 221 of
// 1,600 bound nodes by at most 4.6 units on a figure 1,007 units tall, which is about four screen pixels.
// Anatomically correct and visually invisible. Exaggerating the delta keeps every node exactly where it
// belongs at rest and only magnifies what MOVES, so she is still herself — just talking legibly.
let SKIN_EXAG = 3.2;
function captureSkinRest() {
  if (!vrmReady || !skinBinds) return;
  const em = vrmModel.expressionManager, saved = {};
  if (em) for (const k of ['aa', 'blink', 'happy']) { try { saved[k] = em.getValue(k); em.setValue(k, 0); } catch (e) {} }
  try { vrmModel.update(0.016); } catch (e) {}
  vrmModel.scene.updateMatrixWorld(true);
  for (const b of skinBinds) { try { b.mesh.getVertexPosition(b.vi, b.rest); } catch (e) {} }
  if (em) for (const k of Object.keys(saved)) { try { em.setValue(k, saved[k]); } catch (e) {} }
  try { vrmModel.update(0.016); } catch (e) {}
}
const _vtmp = new THREE.Vector3();
// Pinned, not sprung: fx/fy/fz are d3-force's fixed-position fields, so the simulation stops fighting the
// mesh and the features stay crisp. A soft spring here would blur her face into an approximate cloud again,
// which is the whole failure this replaces.
function updateSkin() {
  if (SHAPE !== 'skin' || !vrmReady || !skinBinds) return;
  vrmModel.scene.updateMatrixWorld(true);
  for (const b of skinBinds) {
    const n = b.node;
    try { b.mesh.getVertexPosition(b.vi, _vtmp); } catch (e) { continue; }
    // rest + (deformed − rest) × K, in the mesh's own space so it is unaffected by where she is placed
    if (b.exag && SKIN_EXAG !== 1) _vtmp.sub(b.rest).multiplyScalar(SKIN_EXAG).add(b.rest);
    _vtmp.applyMatrix4(b.mesh.matrixWorld);
    n.x = n.fx = _vtmp.x; n.y = n.fy = _vtmp.y; n.z = n.fz = _vtmp.z;
  }
}
function releaseSkin() {                            // let the forces have the nodes back
  for (const n of Graph.graphData().nodes) { n.fx = null; n.fy = null; n.fz = null; }
  if (vrmModel) vrmModel.scene.visible = false;
}
// Her expressions run through the VRM's own rig, from the same face state the painted face uses — so the
// mouth on the model and the mouth on the cloud are the same mouth, moving on one signal.
// ============================================================================================================
// ANIMATION TRACKS — a menu of body clips, deterministically triggered and drivable from outside.
// ============================================================================================================
// Lucas's stated path: "a full menu of animations that can be both deterministically triggered and taken over
// completely by a small cloud LLM giving the program more interactive control of the body."
//
// So a clip is DATA, not code: a named set of per-bone keyframes the player blends. Anything that can name a
// clip can move her — the activity bus today, a cloud call tomorrow — with no new code per animation.
//
// Rotations are in the VRM NORMALIZED humanoid space (the canonical rest where every bone is identity at
// T-pose). That is the same space her resting A-pose is written in, so clips ADD onto that base instead of
// redefining her arms. Blender-authored VRMA lands in this same space, so it can be loaded straight into this
// player later — that needs @pixiv/three-vrm-animation in the bundle, which is why the player is deliberately
// format-agnostic rather than built around any one clip source.
const BASE_POSE = {
  leftUpperArm: [0, 0, -1.25], rightUpperArm: [0, 0, 1.25],
  leftLowerArm: [0, 0, -0.15], rightLowerArm: [0, 0, 0.15],
};
// keyframes are [timeSeconds, [x,y,z] radians]; the player eases between them and loops on `dur`
const ANIM_CLIPS = {
  // BREATHING — the one that matters most: a still figure reads as a mannequin. Chest lifts, shoulders follow
  // a beat later, spine counter-settles, head drifts. 5.2s ≈ a resting respiratory rate.
  idle: { loop: true, dur: 5.2, tracks: {
    chest:         [[0, [0, 0, 0]], [2.1, [-0.045, 0, 0]], [5.2, [0, 0, 0]]],
    spine:         [[0, [0, 0, 0]], [2.2, [0.022, 0, 0]],  [5.2, [0, 0, 0]]],
    leftShoulder:  [[0, [0, 0, 0]], [2.4, [0, 0, -0.055]], [5.2, [0, 0, 0]]],
    rightShoulder: [[0, [0, 0, 0]], [2.4, [0, 0, 0.055]],  [5.2, [0, 0, 0]]],
    head:          [[0, [0, 0, 0]], [2.6, [0.018, 0.030, 0]], [5.2, [0, 0, 0]]],
    neck:          [[0, [0, 0, 0]], [2.6, [0.012, -0.018, 0]], [5.2, [0, 0, 0]]],
  } },
  // LISTENING — she settles and tips toward the speaker: less motion, not more.
  listen: { loop: true, dur: 6.0, tracks: {
    chest:         [[0, [0, 0, 0]], [2.4, [-0.030, 0, 0]], [6.0, [0, 0, 0]]],
    head:          [[0, [0.05, 0.10, 0.06]], [3.0, [0.07, 0.13, 0.08]], [6.0, [0.05, 0.10, 0.06]]],
    neck:          [[0, [0.03, 0.05, 0.03]], [3.0, [0.04, 0.07, 0.04]], [6.0, [0.03, 0.05, 0.03]]],
  } },
  // SPEAKING — the body talks too: small head punctuation and a shoulder that carries the phrase.
  speak: { loop: true, dur: 2.6, tracks: {
    head:          [[0, [0, 0, 0]], [0.6, [-0.035, -0.045, 0]], [1.4, [0.030, 0.040, 0]], [2.6, [0, 0, 0]]],
    neck:          [[0, [0, 0, 0]], [0.7, [-0.020, -0.025, 0]], [1.5, [0.018, 0.022, 0]], [2.6, [0, 0, 0]]],
    chest:         [[0, [0, 0, 0]], [1.3, [-0.030, 0, 0]], [2.6, [0, 0, 0]]],
    leftShoulder:  [[0, [0, 0, 0]], [1.3, [0, 0, -0.035]], [2.6, [0, 0, 0]]],
    rightShoulder: [[0, [0, 0, 0]], [1.3, [0, 0, 0.035]],  [2.6, [0, 0, 0]]],
  } },
  // THINKING — head tilts up and away, and she goes quieter than idle.
  think: { loop: true, dur: 7.0, tracks: {
    head:          [[0, [-0.06, -0.12, -0.05]], [3.5, [-0.09, -0.16, -0.07]], [7.0, [-0.06, -0.12, -0.05]]],
    neck:          [[0, [-0.03, -0.06, -0.02]], [3.5, [-0.05, -0.08, -0.03]], [7.0, [-0.03, -0.06, -0.02]]],
    chest:         [[0, [0, 0, 0]], [3.5, [-0.020, 0, 0]], [7.0, [0, 0, 0]]],
  } },

  // ---- VARIANTS. A director model choosing between four obvious options buys only latency; RANGE is what
  // makes it earn its place. These are the same four intents at different weights, plus real gestures, so
  // "how she says it" becomes a decision rather than a lookup. ----

  // a slower, emptier breath — so a long idle does not loop visibly identically
  idle_settle: { loop: true, dur: 6.8, tracks: {
    chest:         [[0, [0, 0, 0]], [2.9, [-0.030, 0, 0]], [6.8, [0, 0, 0]]],
    spine:         [[0, [0, 0, 0]], [3.0, [0.014, 0, 0]],  [6.8, [0, 0, 0]]],
    leftShoulder:  [[0, [0, 0, 0]], [3.2, [0, 0, -0.032]], [6.8, [0, 0, 0]]],
    rightShoulder: [[0, [0, 0, 0]], [3.2, [0, 0, 0.032]],  [6.8, [0, 0, 0]]],
    head:          [[0, [0, 0, 0]], [3.4, [0.010, -0.026, 0]], [6.8, [0, 0, 0]]],
  } },
  // interested: she comes forward instead of just going still
  listen_lean: { loop: true, dur: 5.4, tracks: {
    spine:         [[0, [-0.045, 0, 0]], [2.7, [-0.060, 0, 0]], [5.4, [-0.045, 0, 0]]],
    chest:         [[0, [-0.030, 0, 0]], [2.7, [-0.048, 0, 0]], [5.4, [-0.030, 0, 0]]],
    head:          [[0, [0.075, 0.115, 0.070]], [2.7, [0.095, 0.140, 0.085]], [5.4, [0.075, 0.115, 0.070]]],
    neck:          [[0, [0.040, 0.060, 0.035]], [2.7, [0.055, 0.075, 0.045]], [5.4, [0.040, 0.060, 0.035]]],
  } },
  // tentative — smaller, slower, less shoulder
  speak_soft: { loop: true, dur: 3.2, tracks: {
    head:          [[0, [0, 0, 0]], [0.8, [-0.018, -0.024, 0]], [1.8, [0.015, 0.020, 0]], [3.2, [0, 0, 0]]],
    neck:          [[0, [0, 0, 0]], [0.9, [-0.010, -0.013, 0]], [1.9, [0.009, 0.011, 0]], [3.2, [0, 0, 0]]],
    chest:         [[0, [0, 0, 0]], [1.6, [-0.018, 0, 0]], [3.2, [0, 0, 0]]],
  } },
  // emphatic — bigger punctuation, both shoulders carrying it
  speak_emphatic: { loop: true, dur: 2.2, tracks: {
    head:          [[0, [0, 0, 0]], [0.5, [-0.070, -0.085, 0.020]], [1.2, [0.060, 0.075, -0.018]], [2.2, [0, 0, 0]]],
    neck:          [[0, [0, 0, 0]], [0.55, [-0.038, -0.045, 0]], [1.25, [0.032, 0.040, 0]], [2.2, [0, 0, 0]]],
    chest:         [[0, [0, 0, 0]], [1.1, [-0.055, 0, 0]], [2.2, [0, 0, 0]]],
    leftShoulder:  [[0, [0, 0, 0]], [1.1, [0, 0, -0.070]], [2.2, [0, 0, 0]]],
    rightShoulder: [[0, [0, 0, 0]], [1.1, [0, 0, 0.070]],  [2.2, [0, 0, 0]]],
  } },
  // further away, slower — a longer problem
  think_deep: { loop: true, dur: 8.5, tracks: {
    head:          [[0, [-0.10, -0.18, -0.08]], [4.2, [-0.14, -0.23, -0.11]], [8.5, [-0.10, -0.18, -0.08]]],
    neck:          [[0, [-0.05, -0.09, -0.04]], [4.2, [-0.07, -0.12, -0.05]], [8.5, [-0.05, -0.09, -0.04]]],
    chest:         [[0, [0.020, 0, 0]], [4.2, [0.032, 0, 0]], [8.5, [0.020, 0, 0]]],
  } },

  // ---- one-shot GESTURES: loop:false, so they play once, settle back to neutral, and the hold returns
  // her to whatever idle she was in. These are the beats a director actually wants to place. ----
  nod:   { loop: false, dur: 1.15, tracks: {
    head: [[0, [0, 0, 0]], [0.26, [0.130, 0, 0]], [0.56, [-0.040, 0, 0]], [0.86, [0.060, 0, 0]], [1.15, [0, 0, 0]]],
    neck: [[0, [0, 0, 0]], [0.26, [0.060, 0, 0]], [0.56, [-0.018, 0, 0]], [0.86, [0.028, 0, 0]], [1.15, [0, 0, 0]]],
  } },
  shake: { loop: false, dur: 1.30, tracks: {
    head: [[0, [0, 0, 0]], [0.30, [0, 0.150, 0]], [0.66, [0, -0.130, 0]], [0.98, [0, 0.065, 0]], [1.30, [0, 0, 0]]],
    neck: [[0, [0, 0, 0]], [0.30, [0, 0.070, 0]], [0.66, [0, -0.060, 0]], [0.98, [0, 0.030, 0]], [1.30, [0, 0, 0]]],
  } },
  // a quick lift — noticing something
  perk:  { loop: false, dur: 1.25, tracks: {
    head:  [[0, [0, 0, 0]], [0.32, [-0.095, 0.030, 0]], [1.25, [0, 0, 0]]],
    neck:  [[0, [0, 0, 0]], [0.32, [-0.048, 0.015, 0]], [1.25, [0, 0, 0]]],
    chest: [[0, [0, 0, 0]], [0.32, [-0.048, 0, 0]], [1.25, [0, 0, 0]]],
    leftShoulder:  [[0, [0, 0, 0]], [0.32, [0, 0, -0.050]], [1.25, [0, 0, 0]]],
    rightShoulder: [[0, [0, 0, 0]], [0.32, [0, 0, 0.050]],  [1.25, [0, 0, 0]]],
  } },
};
let animCur = 'idle', animPrev = null, animT = 0, animPrevT = 0, animMix = 1, animFadeDur = 0.45, animHoldUntil = 0;
// sample one clip's track at time t (linear between keys, eased so nothing starts or stops abruptly)
function animSample(clip, bone, t) {
  const ks = clip.tracks[bone]; if (!ks || !ks.length) return null;
  if (t <= ks[0][0]) return ks[0][1];
  for (let i = 1; i < ks.length; i++) {
    if (t <= ks[i][0]) {
      const a = ks[i - 1], b = ks[i];
      const span = (b[0] - a[0]) || 1e-6;
      let u = (t - a[0]) / span; u = u * u * (3 - 2 * u);                 // smoothstep ease
      return [a[1][0] + (b[1][0] - a[1][0]) * u,
              a[1][1] + (b[1][1] - a[1][1]) * u,
              a[1][2] + (b[1][2] - a[1][2]) * u];
    }
  }
  return ks[ks.length - 1][1];
}
// Play a clip. `hold` keeps it from being overridden by a lower-priority trigger for that long, so a spoken
// line is not stomped by the next idle tick.
function animPlay(name, hold, fade) {
  if (!ANIM_CLIPS[name]) return false;
  const now = performance.now();
  if (name !== animCur) {
    if (now < animHoldUntil && name === 'idle') return false;            // a held clip outranks a fall-back
    animPrev = animCur; animPrevT = animT; animCur = name; animT = 0; animMix = 0;
    animFadeDur = fade == null ? 0.45 : fade;
  }
  animHoldUntil = now + (hold || 0) * 1000;
  return true;
}
// Evaluate + apply. Runs BEFORE vrmModel.update(dt) so the humanoid normalises these into the raw bones.
function animUpdate(dt) {
  if (!vrmReady || !vrmModel.humanoid) return;
  const H = vrmModel.humanoid;
  const cur = ANIM_CLIPS[animCur], prv = animPrev ? ANIM_CLIPS[animPrev] : null;
  animT += dt; if (cur && cur.loop && cur.dur) animT %= cur.dur;
  if (animMix < 1) { animMix = Math.min(1, animMix + dt / Math.max(0.01, animFadeDur)); if (animMix >= 1) animPrev = null; }
  if (prv) { animPrevT += dt; if (prv.loop && prv.dur) animPrevT %= prv.dur; }
  // fall back to idle once a held clip has expired
  if (animCur !== 'idle' && performance.now() > animHoldUntil) animPlay('idle', 0, 0.7);
  const bones = new Set(Object.keys(BASE_POSE));
  if (cur) for (const b of Object.keys(cur.tracks)) bones.add(b);
  if (prv) for (const b of Object.keys(prv.tracks)) bones.add(b);
  for (const name of bones) {
    let node = null;
    try { node = H.getNormalizedBoneNode(name); } catch (e) {}
    if (!node) continue;
    const base = BASE_POSE[name] || [0, 0, 0];
    const a = cur ? animSample(cur, name, animT) : null;
    const b = prv ? animSample(prv, name, animPrevT) : null;
    let ox = 0, oy = 0, oz = 0;
    if (a && b) { const m = animMix, n = 1 - m;
      ox = a[0] * m + b[0] * n; oy = a[1] * m + b[1] * n; oz = a[2] * m + b[2] * n; }
    else if (a) { const m = prv ? animMix : 1; ox = a[0] * m; oy = a[1] * m; oz = a[2] * m; }
    else if (b) { const n = 1 - animMix; ox = b[0] * n; oy = b[1] * n; oz = b[2] * n; }
    node.rotation.set(base[0] + ox, base[1] + oy, base[2] + oz);
  }
}
// the deterministic half of the menu: what she is doing decides how her body moves
// An event may carry the cognition verdict main-side (missed / enriched / enrichSource). When it does, WHERE
// the answer came from picks the clip — a searched-miss shakes her head, something she had to dig off a web
// page is carried more softly than something already hers. When it doesn't, this is the old event map exactly.
function animOnActivity(evt) {
  const e = (evt && typeof evt === 'object') ? evt : { kind: evt };
  const kind = e.kind;
  if (kind !== 'hear' && kind !== 'say' && kind !== 'think') return false;
  const P = (typeof window !== 'undefined' && window.AvatarPosture) || null;
  if (P) {
    // `has` is the live menu, so a posture can never name a clip this player does not own.
    const c = P.clipForTurn(e, (n) => !!ANIM_CLIPS[n]);
    if (c) return animPlay(c.clip, c.decisive ? 3 : (kind === 'say' ? 5 : kind === 'hear' ? 4 : 3.5));
  }
  if (kind === 'hear') return animPlay('listen', 4);
  if (kind === 'say') return animPlay('speak', 5);
  return animPlay('think', 3.5);
}
/*
 * THE JAW, DRIVEN DIRECTLY — because the `aa` viseme alone barely moves it.
 *
 * `aa` is bound to Reallusion's V_Open, and on this model that displaces the mouth by 0.0081 at full weight.
 * Jaw_Open displaces it 0.0221 over 2,110 vertices — 2.7x the travel, measured through getVertexPosition so
 * it is the real deformed result, not the raw delta. That is not a bug in the conversion so much as how CC
 * rigs work: V_Open is a LIP shape and assumes the jaw is animated on its own channel, so binding the viseme
 * alone gives a mouth that changes shape without ever opening. At this figure's on-screen size, 8mm of travel
 * is nothing — the same "true-scale lip motion is invisible" problem SKIN_EXAG solved for nodes, except no
 * amplification reaches here (and the mouth patch is deliberately node-free, so there is nothing to amplify).
 *
 * Jaw_Open is bound to no VRM expression, so the expressionManager never touches it and a direct write holds.
 * Set AFTER vrm.update() but BEFORE updateSkin(), so bound nodes see the same pose the mesh is in. The cache
 * keys on the model itself, so swapping avatars rebuilds it; a model without the morph is simply a no-op and
 * the viseme carries on alone.
 */
let _jaw = { model: null, targets: [] };
function setJawOpen(v) {
  if (_jaw.model !== vrmModel) {
    _jaw = { model: vrmModel, targets: [] };
    try {
      vrmModel.scene.traverse((o) => {
        const d = o.morphTargetDictionary;
        if (d && d.Jaw_Open != null && o.morphTargetInfluences) _jaw.targets.push({ inf: o.morphTargetInfluences, i: d.Jaw_Open });
      });
    } catch (e) {}
  }
  const w = Math.max(0, Math.min(1, v));
  for (const t of _jaw.targets) t.inf[t.i] = w;
}
function updateVRMFace(now, dt) {
  if (!vrmReady || SHAPE !== 'skin') return;
  // Her heart beats — a real double-thump rather than a sine, because a sine reads as a pulsing lamp. It is
  // the only part of her that moves without being told to, which is the point: identity is the thing that is
  // there whether or not she is working.
  const t = (now % 1150) / 1150;
  shellUniforms.uPulse.value = Math.min(1, Math.exp(-t * 10) + 0.55 * Math.exp(-Math.max(0, t - 0.17) * 13));
  const em = vrmModel.expressionManager;
  if (em) {
    try { em.setValue('aa', Math.min(1, face.mouthOpen)); } catch (e) {}
    try { em.setValue('blink', AS ? AS.blinkMultiplier(now) < 0.5 ? 1 : 0 : 0); } catch (e) {}
    try { em.setValue('happy', Math.max(0, face.cur.mouthCurve)); } catch (e) {}
  }
  animUpdate(dt);                     // body clips first — vrm.update() normalises them into the raw bones
  try { vrmModel.update(dt); } catch (e) {}
  setJawOpen(face.mouthOpen);         // the viseme shapes the lips; THIS is what actually opens her mouth
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
  linkBaseCol = col.slice();                                    // untouched original, for the skin-mode fade
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
  // Only when the routed cloud ISN'T carrying the links — otherwise this is fading a hidden buffer.
  if (SHAPE === 'skin' && !(routedLines && routedLines.visible)) { const n = performance.now(); if (n - _linkFadeAt > 250) { _linkFadeAt = n; fadeSkinLinks(); } }
}
// A LINK BETWEEN TWO DISTANT BODY PARTS IS A CHORD, NOT A CONTOUR. Bound to her surface, an edge from a hand
// to a knee draws a straight line straight THROUGH her — and with a couple of thousand of them the result was
// a bright cone hanging off her hips that read as a skirt, hiding her legs entirely. It is the single thing
// most wrong with the first live render, and it is not a colour problem: those lines are geometrically real
// and simply do not belong to the form.
// Fading by LENGTH keeps exactly the edges that hug her — near neighbours on the surface, which trace muscle
// and contour — and drops the long-distance ones toward nothing. The graph is unchanged; what is drawn is the
// part of it that describes her shape.
const SKIN_LINK_NEAR = 55, SKIN_LINK_FAR = 210;
function fadeSkinLinks() {
  if (!linkGeo || !linkBaseCol || !linkIndex.length) return;
  const pos = linkGeo.attributes.position.array, col = linkGeo.attributes.color.array;
  for (let i = 0; i < linkIndex.length; i++) {
    const o = i * 6;
    const d = Math.hypot(pos[o + 3] - pos[o], pos[o + 4] - pos[o + 1], pos[o + 5] - pos[o + 2]);
    const t = Math.max(0, Math.min(1, (SKIN_LINK_FAR - d) / (SKIN_LINK_FAR - SKIN_LINK_NEAR)));
    const k = t * t * (3 - 2 * t);                              // smoothstep — no hard cut-off ring
    for (let v = 0; v < 6; v++) col[o + v] = linkBaseCol[o + v] * k;
  }
  linkGeo.attributes.color.needsUpdate = true;
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
  // strong-id gold badges are ~20% of nodes — on the abstract graph that's useful texture, but on the FIGURE
  // they pepper her face and body with rings (Lucas hated it). The figure IS the visualisation there, so in
  // skin mode only the RARE + LIVE marks survive: a refuted scar, a firing recognition. Gold is suppressed.
  if (p.strongId && SHAPE !== 'skin') return { c: STRONGID_RGB, a: 0.34, k: 1.35 };
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
// Raycast against her actual SURFACE (the occluder meshes carry geometry even though they don't colour-write;
// three applies morphs + bone skinning in the raycast, so the hit point is her DEFORMED surface). Used by the
// double-click focus so the pivot lands exactly where the cursor is on her body.
const _mray = new THREE.Raycaster();
function _rayFrom(clientX, clientY) {
  const cv = graphEl.querySelector('canvas'); if (!cv) return false; const rect = cv.getBoundingClientRect();
  const m = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  _mray.setFromCamera(m, Graph.camera()); return true;
}
function pickSurface(clientX, clientY) {
  if (!_rayFrom(clientX, clientY)) return null;
  // Exact skin point first (three applies morphs + skinning in the raycast).
  if (vrmReady && vrmOccluders.length) {
    try { const hits = _mray.intersectObjects(vrmOccluders, false); if (hits.length) return hits[0].point.clone(); } catch (e) {}
  }
  // Fallback that can never miss her: the bound node whose position is nearest the click ray. Nodes ARE her
  // surface, so this always lands on her body even if the skinned-mesh raycast returns nothing.
  if (nodeIndex && nodeIndex.length) {
    let best = null, bd = Infinity; const v = new THREE.Vector3();
    for (const n of nodeIndex) { if (!Number.isFinite(n.x)) continue; v.set(n.x, n.y, n.z || 0); const d = _mray.ray.distanceToPoint(v); if (d < bd) { bd = d; best = v.clone(); } }
    if (best && bd < 120) return best;                          // only if the click was actually near her
  }
  return null;
}
let _downXY = null, _clickTimer = null, _lastDbl = 0;
graphEl.addEventListener('pointerdown', (e) => { _downXY = [e.clientX, e.clientY]; });
graphEl.addEventListener('pointerup', (e) => {
  const d = _downXY; _downXY = null;
  if (!d) return;
  if (Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 5) return;   // moved → it was an orbit drag
  const n = pickAt(e.clientX, e.clientY);
  if (!n || n.id == null) { hideCard(); return; }
  showCard(n);                                   // every pick answers "what IS this?" first…
  // …and a corpus/short-term node still walks its neighbourhood — but DEFERRED, so a double-click (which fires
  // two pointerups) can cancel the disruptive ego-walk and just re-aim the camera instead.
  if (!n.zoe) { clearTimeout(_clickTimer); _clickTimer = setTimeout(() => { if (performance.now() - _lastDbl > 260) focus(n.id); }, 240); }
});
// DOUBLE-CLICK TO LOOK CLOSER (Lucas: "the camera is locked to zoom mid object … I can't get a close-up of the
// head/face/eyes/hair"). Double-click on her re-centres the orbit pivot on that exact spot and pulls in; double
// -click empty space reframes the whole figure. The scroll wheel then zooms around wherever you last looked.
graphEl.addEventListener('dblclick', (e) => {
  _lastDbl = performance.now(); clearTimeout(_clickTimer);
  const p = pickSurface(e.clientX, e.clientY);
  if (p) focusPoint(p, 650); else fitView(650, false);
});

// ---- HOVER: what a node is, at a glance (Lucas: "there's no information about what any of the nodes are").
// Same raycast as picking, throttled to ~12Hz; an HTML tooltip follows the cursor. Zero scene cost.
const tipEl = document.getElementById('tip');
let _hoverAt = 0;
// Display-only. Echo names are UNIQUE across every entity_type, so when a name is already taken by another
// object it is disambiguated with its Wikidata id — "England [wd:Q21]", "United States [wd:Q30]" (2,511
// places carry one as of the 2026-07-25 DB handoff). That suffix is IDENTITY, not something to read, so it is
// stripped for any human-facing label. NEVER strip it where the name is used to look a node up (focus, vertex
// binding, id match): the full string IS the node id, and a stripped one would resolve to nothing.
function entityLabel(name) {
  return String(name == null ? '' : name).replace(/\s*\[wd:Q\d+\]\s*$/i, '');
}
graphEl.addEventListener('pointermove', (e) => {
  const now = performance.now(); if (now - _hoverAt < 80) return; _hoverAt = now;
  if (_downXY) { if (tipEl) tipEl.style.display = 'none'; return; }          // orbiting — no tooltip
  const n = pickAt(e.clientX, e.clientY);
  if (!n || n.id == null) { if (tipEl) tipEl.style.display = 'none'; return; }
  if (tipEl) {
    tipEl.querySelector('.nm').textContent = n.zoe ? ('Zoe — ' + (n.entityType || 'self')) : entityLabel(n.id);
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
  cardEl.querySelector('.nm').textContent = n.zoe ? 'Zoe — her own ' + (n.entityType || 'self') : entityLabel(n.id);
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
// Generalised so every kind of INFLOW shares one grammar and one draw budget: evidence (sky), a document
// landing (lime), a followed story moving (pink, from further out), an audit sweep (amber). Anything that
// arrives from the world falls inward; only her own activity originates inside.
function gInflow(count, colorHex, reach) {
  _tick++;
  const c = new THREE.Vector3(_coreCen.x, _coreCen.y, _coreCen.z);
  const far = CLOUD_R * 1.45 * (reach == null ? 1 : reach);
  const k = Math.max(1, Math.min(9, Math.round(Math.log2(1 + count) * 1.6)));
  for (let i = 0; i < k; i++) {
    const h = hashSeed('ev' + i + count + _tick) * Math.PI * 2, v = Math.acos(2 * hashSeed('ew' + i + _tick) - 1);
    const dir = new THREE.Vector3(Math.sin(v) * Math.cos(h), Math.sin(v) * Math.sin(h), Math.cos(v));
    const from = c.clone().add(dir.clone().multiplyScalar(far));
    const to = c.clone().add(dir.multiplyScalar(CLOUD_R * (0.45 + 0.4 * hashSeed('ex' + i + _tick))));
    const s = mkSprite(colorHex, 0.85); s.scale.setScalar(3); s.position.copy(from);
    addEffect([s], 1250 + i * 60, (p) => {
      const e = 1 - Math.pow(1 - p, 2.2);
      s.position.copy(from.clone().lerp(to, e));
      s.material.opacity = 0.85 * Math.sin(Math.min(1, p * 1.15) * Math.PI);
      s.scale.setScalar(3 + p * 2);
    });
  }
}
function gEvidence(count) { gInflow(count, 0x7dd3fc, 1.0); }
// A NOTE LANDING — memory being written. Unlike inflow this starts INSIDE: she is the one writing it. A few
// motes condense in the orb and settle toward her, scaled by how many landed in the coalescing window, each
// arriving with a small settle rather than a flash. Deliberately the quietest gesture in the vocabulary: it
// is the highest-volume event on the bus and it should read as texture, not as news.
function gNote(count) {
  _tick++;
  const c = new THREE.Vector3(_coreCen.x, _coreCen.y, _coreCen.z);
  const k = Math.max(1, Math.min(7, Math.round(Math.log2(1 + count) * 1.9)));
  for (let i = 0; i < k; i++) {
    const h = hashSeed('nt' + i + _tick) * Math.PI * 2, v = Math.acos(2 * hashSeed('nu' + i + _tick) - 1);
    const r = PERP_SQ * (0.42 + 0.5 * hashSeed('nr' + i + _tick));
    const start = c.clone().add(new THREE.Vector3(r * Math.sin(v) * Math.cos(h), r * Math.sin(v) * Math.sin(h), r * Math.cos(v)));
    const end = start.clone().lerp(c, 0.45);
    const s = mkSprite(0xcbd5e1, 0.5); s.scale.setScalar(2); s.position.copy(start);
    addEffect([s], 1400 + i * 70, (p) => {
      const e = 1 - Math.pow(1 - p, 2.6);
      s.position.copy(start.clone().lerp(end, e));
      const q = Math.sin(p * Math.PI);
      s.material.opacity = 0.5 * q; s.scale.setScalar(2 + q * 2.2);
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
  // NOTHING BEYOND HER (Lucas: "connecting nodes off in the void"). Tendrils spray random rays off every hub
  // node into empty space — exactly the void-connections he means. Off entirely while she is the surface.
  if (SHAPE === 'skin' || !TENDRILS_ON) { if (tendrilLines) { scene.remove(tendrilLines); tendrilGeo.dispose(); tendrilLines.material.dispose(); tendrilLines = null; tendrilGeo = null; } tendrilSpecs = []; return; }
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
let starfield = null;
(function addStarfield() {
  const N = 1400, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { const r = 700 + Math.random() * 1500, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1); pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th); pos[i * 3 + 2] = r * Math.cos(ph); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starfield = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x5a6a85, size: 1.1, sizeAttenuation: false, transparent: true, opacity: 0.22, depthWrite: false }));
  scene.add(starfield);
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

// ============================================================================================================
// ACTIVITY DISPATCH — every kind on the bus gets an answer on screen, or says why it didn't.
// ============================================================================================================
// Lucas, 2026-07-22: "I am seeing so many more actions in the log than are actually taking place on the
// visual." Measured against the emitters, the gap was structural in three separate ways — not one glitch:
//
//   1. THREE LIVE KINDS HAD NO BRANCH AT ALL. `note` (every insertMemory — the busiest emitter in the app),
//      `doc.land` (every document landing) and `news` (a followed story she decides to raise). All three have
//      entries in KIND_META, so they printed a coloured row and looked handled, and drew precisely nothing.
//   2. FOUR KINDS DIED ON A MISSING ANCHOR. node.enrich / promote / node.merge / observe each fell through an
//      `if (a)` when `findNode` missed — and it misses far more often than it hits, because the panel draws a
//      ~2k sample of 1.76M objects. match.hit and recall were fixed weeks ago to MINT the named object rather
//      than discard the event; the rest never got the same treatment.
//   3. `edge.born` REQUIRED BOTH ENDS ALREADY DRAWN, which is that low probability squared — effectively
//      never. That is the "connections being made" picture, and it was the most reliably invisible of all.
//
// The rule now: if the bus names an object, the object is brought into view and the gesture fires. If it names
// nothing (an ambient pulse), an ambient gesture fires. Only a genuinely empty event returns 'miss', and the
// log dims that row — so the remaining gap is a stated fact rather than a silent one.
function mintLocal(name, evt) {   // a short-term anchor materialises in her core; the next kg:shortterm poll prunes it if the DB disagrees
  if (objs.has(name)) return objs.get(name);
  ensureObj({ id: name, store: 'sidequest', entityType: 'unknown', epistemic: (evt && evt.epistemic) || 'told' }, coreCentroid3D());
  shortTerm.nodes.add(name);
  scheduleMintRender();
  return objs.get(name) || null;
}
// Route by store: her own material mints into the core half, corpus material onto the shell at its
// deterministic seat (the same placement recognition has always used, so an object keeps one home).
function nodeFor(evt, name) {
  if (name == null || name === '') return null;
  return findNode(name) || (evt && evt.db === 'sidequest' ? mintLocal(name, evt) : mintEcho(name));
}
// `note` is the one true firehose — insertMemory fires from focus, learning, reflection, revise, self_model,
// meetings and research. Per-event motes would be a strobe and 40 draw calls; a coalesced burst scaled by how
// many landed reads as what it is, at the cost of one.
let _noteN = 0, _noteTimer = null;
function queueNote() {
  _noteN++;
  if (_noteTimer) return;
  _noteTimer = setTimeout(() => { const n = _noteN; _noteN = 0; _noteTimer = null; gNote(n); }, 900);
}
// Minting is LAZY and per-branch, never computed up front. Only some kinds carry an object NAME in `anchor`;
// the rest carry prose — `hear`/`say` hold 110 characters of the actual conversation, `think` a monologue
// rowid, `note` a "[kind] content" string. Resolving those eagerly would mint nodes whose ids are sentences,
// which is worse than the invisibility it was meant to cure. So each branch asks for the object only when its
// own anchor really is one.
function dispatchActivity(evt) {
  const k = evt.kind;
  if (k === 'node.born') { queueBorn(evt); return 'queued'; }
  const A = () => nodeFor(evt, evt.anchor), B = () => (evt.anchor2 != null ? nodeFor(evt, evt.anchor2) : null);
  if (k === 'node.enrich') { const a = A(); if (!a) return 'miss'; gEnrich(V3(a), new THREE.Color(nodeColor(a)).getHex()); return 'drew'; }
  if (k === 'edge.born' || k === 'edge.promote') {
    const a = A(), b = B(); if (!a || !b) return 'miss';
    gEdge(V3(a), V3(b), new THREE.Color(nodeColor(a)).getHex()); addHotLink(a.id); addHotLink(b.id); return 'drew';
  }
  if (k === 'match.hit') {                      // she recognised a known thing — fire at it, halo it.
    const b = B(); if (!b) return 'miss';       // anchor is the MENTION TEXT and never a node; only anchor2 is real
    addHotLink(b.id); gMatch(b); return 'drew';
  }
  if (k === 'recall') {                         // a memory pulled inward — same: the known thing must be visible
    const a = A(); if (!a) return 'miss'; addHotLink(a.id); gMatch(a); gRecall(V3(a)); return 'drew';
  }
  if (k === 'observe') {                        // a graded observation LINKS two things — draw the link, not a blip
    // VERSION-SKEW GUARD. The renderer reloads on its own; lib/db.js only takes effect on a main-process
    // reboot. In that window the old tap is still sending subject+relation+target mashed into one string as
    // the anchor — and minting THAT would put a sentence in the graph as a node id, the exact failure the
    // lazy-mint rule exists to prevent. The new payload always carries `rel`/`anchor2` fields (null is still
    // present); the old one never did, so this discriminates exactly. Old shape stays invisible, as before,
    // and the log row now says so instead of pretending.
    if (!('rel' in evt) && !('anchor2' in evt)) return 'miss';
    const a = A(); if (!a) return 'miss';
    const b = B();
    if (b) { gEdge(V3(a), V3(b), new THREE.Color(nodeColor(a)).getHex()); addHotLink(b.id); }
    else { gEnrich(V3(a), new THREE.Color(nodeColor(a)).getHex()); }
    addHotLink(a.id); return 'drew';
  }
  if (k === 'promote' || k === 'node.promote') { const a = A(); if (!a) return 'miss'; gPromote(V3(a)); addHotLink(a.id); return 'drew'; }
  if (k === 'node.merge') { const a = A(); if (!a) return 'miss'; gAbsorb(V3(a), evt.count); return 'drew'; }   // dedup absorb: duplicates collapse inward
  if (k === 'think') { faceExpression('thinking'); gThink(); return 'drew'; }   // ambient heartbeat (throttled upstream)
  if (k === 'self' || k === 'reflect') {                                 // her identity moved — flare the anchor, refresh the ring
    gEnrich(new THREE.Vector3(_coreCen.x, _coreCen.y, _coreCen.z), new THREE.Color(ZOE_ROSE).getHex());
    if (k === 'self') loadSelf();
    return 'drew';
  }
  // COMMUNICATION ALSO MOVES HER FACE. `say` is the one that matters — it is emitted from insertTurn at the
  // moment the reply lands, which is the same moment speakThroughCompanion starts the wav, so the mouth opens
  // in step with her actually talking. `hear` looks up and attends; `think` narrows the brow.
  if (k === 'hear') { faceExpression('warm'); face.target = 0.72; gCross(true, HEAR_HEX); return 'drew'; }
  if (k === 'say') { faceExpression('warm'); faceSpeak(evt.anchor); gCross(false, SAY_HEX); return 'drew'; }
  if (k === 'encounter') { gEvidence(evt.count || 1); return 'drew'; }   // evidence arriving — the substrate landing
  if (k === 'note') { queueNote(); return 'drew'; }                      // a memory written — coalesced churn in the core
  if (k === 'doc.land') { gInflow(evt.count || 1, 0xa3e635, 1.0); return 'drew'; }   // a document arrives from the world
  if (k === 'news') { gInflow(evt.count || 1, 0xf472b6, 1.25); return 'drew'; }      // a followed story moved — comes in from further out
  if (k === 'refute') {                                                  // something she held, proven wrong
    const a = A();
    if (a) { gRefute(V3(a)); addHotLink(a.id); } else { gRefute(new THREE.Vector3(_coreCen.x, _coreCen.y, _coreCen.z)); }
    return 'drew';
  }
  if (k === 'node.degrade') { const a = A(); if (!a) return 'miss'; gRefute(V3(a)); return 'drew'; }   // confidence lost — same collapsing pulse, no halo
  if (k === 'edge.prune') { const a = A(); if (!a) return 'miss'; gAbsorb(V3(a), 2); return 'drew'; }
  if (k === 'audit.clean') { gInflow(evt.count || 1, 0xfacc15, 0.8); return 'drew'; }
  return 'miss';                                 // an unknown kind draws nothing, and now admits it
}
function onActivity(evt) {
  // her BODY answers the same events her face does — deterministic half of the animation menu
  try { animOnActivity(evt); } catch (e) {}   // the WHOLE event — it may carry the turn's cognition verdict
  if (!evt) return;
  let verdict = 'miss';
  try { verdict = dispatchActivity(evt) || 'miss'; }
  catch (e) { verdict = 'error'; console.warn('[kg3d] activity', e && e.message); }
  try { logActivity(evt, verdict); } catch (e) {}   // the log records the verdict too, so a gap is visible
  return verdict;
}

// ---- fps HUD ----
let frames = 0, lastT = performance.now(), fps = 0;
function stepFrame(now) {
  updateEffects(now);
  updateFogBand();              // depth band + point scale follow the camera, so this holds through zooming
  updateFace(now);              // her face rides the same three materials — no geometry, no extra draw call
  if (SHAPE === 'skin') {       // the model deforms, the bound nodes follow it, the links follow them
    const dt = Math.min(0.05, (now - (_skinT || now)) / 1000); _skinT = now;
    updateVRMFace(now, dt); updateSkin();
  }
  updateDrawnFeatures(now);     // the drawn eyes/mouth hide themselves outside skin mode
  updateFaceStyle();            // the fake lash node-art rides the lids (hides itself outside skin mode)
  // Position syncing only while the layout is actually moving. `_stillFrames` keeps a couple of frames of
  // sync after it stops so the last motion lands, and any reheat (new data, a mint) restarts it.
  // `skin` ALWAYS syncs: every node is pinned with fx/fy/fz, so the simulation cools within a second and
  // engineRunning goes false — and then the cloud would stop following the mesh and she would freeze
  // mid-sentence while the model underneath kept talking. Her motion comes from the rig, not the sim.
  if (engineRunning) { _stillFrames = 2; } else if (_stillFrames > 0) { _stillFrames--; }
  if (engineRunning || _stillFrames > 0 || SHAPE === 'skin') { updateNodeCloud(); updateLinkCloud(); updateTendrils(); }
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
function tick() { requestAnimationFrame(tick); frames++; stepFrame(performance.now()); }
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

// ---- shell toggle + pop-out ----
// Pop-out rides the companion window that already exists rather than minting a second one: main owns
// `companion:toggle`, preload already exposes it, so this needs nothing main-side and works today. The
// companion still renders her with her own textures — converting THAT surface to the shell palette is a
// separate build, and this button is the honest half of it that can ship now.
const shellBtn = document.getElementById('shellBtn'), popBtn = document.getElementById('popBtn');
if (shellBtn) {
  const paint = () => shellBtn.classList.toggle('on', SHELL_ON);
  paint();
  shellBtn.addEventListener('click', () => { setShell(!SHELL_ON); paint(); });
}
if (popBtn) {
  popBtn.addEventListener('click', async () => {
    try {
      if (window.sq && typeof window.sq.companionToggle === 'function') { await window.sq.companionToggle(); setOverlay('her window toggled', 1400); }
      else setOverlay('companion window unavailable', 2000);
    } catch (e) { setOverlay(String((e && e.message) || e), 2000); }
  });
}

// ---- face toggle: one click and the graph is byte-identical to what it was before she existed ----
const faceBtn = document.getElementById('faceBtn');
if (faceBtn) {
  const paintFace = () => faceBtn.classList.toggle('on', FACE_ON);
  paintFace();
  faceBtn.addEventListener('click', () => {
    FACE_ON = !FACE_ON;
    try { localStorage.setItem('kg3d.face', FACE_ON ? '1' : '0'); } catch (e) {}
    if (!FACE_ON) face.strength = 0;
    paintFace();
  });
}
// The TTS wav, when it is reachable, so the mouth runs on real amplitude instead of the estimate. Main only
// sends this once the broadcast lands (reboot-gated); until then faceSpeak's envelope carries her.
try { if (window.sq && window.sq.onCompanionSpeak) window.sq.onCompanionSpeak((info) => { if (info && info.url) faceAttachAudio(info.url); }); } catch (e) {}

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
  ddEl.innerHTML = hits.map((h, i) => `<div class="hit${i === activeIdx ? ' on' : ''}" data-i="${i}"><span class="swatch" style="background:${h.color || '#7dd3fc'}"></span><span class="nm">${esc(entityLabel(h.name))}</span><span class="ty">${esc(h.entity_type)}</span></div>`).join('');
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
// Entering `skin` loads the model on demand (nothing is fetched unless she is actually asked for), binds the
// nodes and shows the occluder. Leaving it releases every pin so the forces get the graph back — without
// that, switching away would leave the whole cloud frozen in the shape of her body.
async function applyShape(next) {
  SHAPE = next;
  try { localStorage.setItem('kg3d.shape', SHAPE); } catch (e) {}
  for (const n of objs.values()) n._tp = null;
  // HER BODY IS EVERYTHING; NOTHING BEYOND HER (Lucas). In skin mode the field dressing goes dark — starfield,
  // the dust haze and the hub tendrils — so the only lit thing on screen is her, built from the corpus.
  const beyond = SHAPE !== 'skin';
  if (starfield) starfield.visible = beyond;
  if (dustCloud) dustCloud.visible = beyond;
  if (tendrilLines) tendrilLines.visible = beyond;
  if (SHAPE === 'skin') {
    setOverlay('Loading her model…');
    const vrm = await loadVRM();
    if (!vrm) { setOverlay('VRM unavailable — data/avatars/zoe.vrm missing or loader not built', 3200); SHAPE = 'brain'; if (shapeEl) shapeEl.value = SHAPE; return; }
    placeVRM(); vrm.scene.visible = true;
    const n = buildSkinBinding();
    setOverlay(n ? null : 'no nodes to bind', n ? 0 : 2000);
    updateSkin(); buildRoutedLinks(); setRoutedVisible(true);
  } else {
    releaseSkin(); setRoutedVisible(false);
  }
  try { Graph.d3ReheatSimulation(); } catch (e) {}
  _fitOnCool = true;                         // re-frame once the new arrangement settles
}
if (shapeEl) {
  shapeEl.value = SHAPE;
  shapeEl.addEventListener('change', () => { applyShape(shapeEl.value); });
  // If `skin` was the saved shape, it has to be APPLIED on boot, not just read — the model is loaded on
  // demand, so restoring the string alone would leave the selector saying "skin" over an unbound cloud.
  if (SHAPE === 'skin') setTimeout(() => applyShape('skin'), 1200);
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
  // her face — drive it directly to judge the look without waiting for her to say something
  face: (o) => { if (o && typeof o === 'object') { if (o.on != null) { FACE_ON = !!o.on; if (!FACE_ON) face.strength = 0; }
      if (o.expression) faceExpression(o.expression); if (o.say != null) faceSpeak(o.say);
      if (o.strength != null) { face.target = o.strength; face.strength = o.strength; }
      if (o.mouthOpen != null) face.mouthOpen = o.mouthOpen; }
    return { on: FACE_ON, model: !!AS, strength: +face.strength.toFixed(3), mouthOpen: +face.mouthOpen.toFixed(3),
      speaking: performance.now() < face.speakUntil || !!face.analyser, realAudio: !!face.analyser, cur: face.cur }; },
  // "more actions in the log than on the visual" — measurable now instead of arguable. Per kind: how many the
  // bus delivered vs how many produced a gesture. Any row where drawn < seen names a real remaining gap.
  actStats: () => ({ seen: _act.seen, drawn: _act.drawn,
    kinds: [..._act.byKind.entries()].map(([k, v]) => ({ kind: k, seen: v.seen, drawn: v.drawn })).sort((a, b) => b.seen - a.seen) }),
  shape: (s) => { if (s) { applyShape(s); if (shapeEl) shapeEl.value = s; } return SHAPE; },
  // THE ANIMATION MENU — the takeover surface. Anything that can name a clip can drive her body, which is the
  // hook a small cloud model plugs into: `anim()` lists what exists, `anim({play:'think', hold:6})` moves her.
  anim: (o) => { if (o && typeof o === 'object' && o.play) animPlay(o.play, o.hold, o.fade);
    return { clips: Object.keys(ANIM_CLIPS), playing: animCur, blendingFrom: animPrev,
      mix: +animMix.toFixed(2), t: +animT.toFixed(2),
      heldFor: Math.max(0, +((animHoldUntil - performance.now()) / 1000).toFixed(1)) }; },
  // the hologram suit — tune it live (neckline/hem are model-space Y from the rig) without a reload
  suit: (o) => { if (o && typeof o === 'object') {
      if (o.on != null) shellUniforms.uSuitOn.value = o.on ? 1 : 0;
      if (o.amt != null) shellUniforms.uSuitAmt.value = o.amt;
      if (o.neck != null) shellUniforms.uSuitNeck.value = o.neck;
      if (o.hem != null) shellUniforms.uSuitHem.value = o.hem;
      if (o.scoop != null) shellUniforms.uSuitScoop.value = o.scoop; }
    return { on: shellUniforms.uSuitOn.value, amt: +shellUniforms.uSuitAmt.value.toFixed(2),
      neck: +shellUniforms.uSuitNeck.value.toFixed(3), hem: +shellUniforms.uSuitHem.value.toFixed(3),
      scoop: +shellUniforms.uSuitScoop.value.toFixed(3) }; },
  skin: (o) => { if (o && o.exag != null) SKIN_EXAG = o.exag;
    return { ready: vrmReady, bound: skinBinds ? skinBinds.length : 0,
      regions: { head: REGION.head.length, heart: REGION.heart.length, body: REGION.body.length },
      bound_by_region: (skinBinds && skinBinds._counts) || null,
      features: featureAnchors ? { eyes: featureAnchors.left.length + featureAnchors.right.length, mouth: featureAnchors.mouth.length, eyeR: +featureAnchors.eyeR.toFixed(4), mouthR: +featureAnchors.mouthR.toFixed(4) } : null,
      visible: !!(vrmModel && vrmModel.scene.visible), shape: SHAPE, exag: SKIN_EXAG }; },
  // Drive N frames by hand and return a PNG of the result. requestAnimationFrame is suspended whenever the
  // page is not compositing (a background tab, or a preview pane that is not on screen), which stops the
  // whole loop — so without this the surface simply cannot be inspected headlessly. Renders explicitly and
  // grabs the buffer in the same task, since preserveDrawingBuffer is off.
  step: (n = 1) => { const t = performance.now(); for (let i = 0; i < (n || 1); i++) stepFrame(t + i * 16.7); },
  // Renders into an offscreen target and reads the pixels back, rather than calling toDataURL on the canvas.
  // The canvas route returns an EMPTY data URL here: preserveDrawingBuffer is off, so the drawing buffer is
  // only valid for readback inside the compositing frame that drew it — and when nothing is compositing there
  // is no such frame. A render target is owned memory and can always be read.
  snap: (n = 3, w = 1280, h = 800) => {
    try {
      const t = performance.now();
      for (let i = 0; i < (n || 1); i++) stepFrame(t + i * 16.7);
      const r = Graph.renderer(), cam = Graph.camera();
      const rt = new THREE.WebGLRenderTarget(w, h);
      const oldA = cam.aspect; cam.aspect = w / h; cam.updateProjectionMatrix();
      r.setRenderTarget(rt); r.render(Graph.scene(), cam); r.setRenderTarget(null);
      cam.aspect = oldA; cam.updateProjectionMatrix();
      const buf = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      rt.dispose();
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d'), img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {                       // GL origin is bottom-left; flip into image order
        const s = (h - 1 - y) * w * 4, d = y * w * 4;
        img.data.set(buf.subarray(s, s + w * 4), d);
      }
      ctx.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    } catch (e) { return 'ERR ' + (e && e.message); }
  },
  lobeOf, lobeStats: () => {                    // how much of the graph actually crosses between territories
    const d = Graph.graphData(), per = {}, pair = {}; let cross = 0, within = 0;
    for (const n of d.nodes) { const L = lobeOf(n); per[L] = (per[L] || 0) + 1; }
    for (const l of d.links) {
      const a = typeof l.source === 'object' ? l.source : objs.get(l.source);
      const b = typeof l.target === 'object' ? l.target : objs.get(l.target);
      if (!a || !b) continue;
      const la = lobeOf(a), lb = lobeOf(b);
      if (la === lb) { within++; continue; }
      cross++; const key = [la, lb].sort().join('↔'); pair[key] = (pair[key] || 0) + 1;
    }
    return { nodesPerLobe: per, within, cross, crossPct: +(cross * 100 / Math.max(1, within + cross)).toFixed(1), pairs: pair };
  },
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
