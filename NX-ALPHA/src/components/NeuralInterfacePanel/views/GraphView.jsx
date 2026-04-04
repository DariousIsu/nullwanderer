import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import gsap from 'gsap';
import styles from './GraphView.module.css';

// ─── Constants ─────────────────────────────────────────────────────────────

const API = 'http://localhost:8000';

const TYPE_COLORS = {
  SYSTEM:  0xe6a817,
  PERSON:  0x3b82f6,
  ORG:     0x8b5cf6,
  CONCEPT: 0x14b8a6,
  EVENT:   0xf97316,
  GEO:     0x22c55e,
  default: 0x6b7280,
};

const TYPE_CSS = {
  SYSTEM:  '#e6a817',
  PERSON:  '#3b82f6',
  ORG:     '#8b5cf6',
  CONCEPT: '#14b8a6',
  EVENT:   '#f97316',
  GEO:     '#22c55e',
  default: '#6b7280',
};

const ENTITY_TYPES    = ['ALL', 'SYSTEM', 'PERSON', 'ORG', 'CONCEPT', 'EVENT'];
const SIDEBAR_STATES  = ['collapsed', 'compact', 'expanded'];
const SIDEBAR_WIDTHS  = { collapsed: styles.sidebarCollapsed, compact: styles.sidebarCompact, expanded: styles.sidebarExpanded };
const SIM_TICKS       = 150;
const REPULSION_K     = 150;
const SPRING_REST     = 5;
const SPRING_K        = 0.05;
const DAMP            = 0.85;
const HISTORY_KEY     = 'neural_graph_history';
const SIDEBAR_KEY     = 'neural_sidebar_state';
const INSTANCED_THRESHOLD = 100;
const RAYCAST_THROTTLE_MS = 50;

// ─── Helpers ───────────────────────────────────────────────────────────────

function createNodeGroup(THREE, node, deg, maxDeg) {
  const group = new THREE.Group();
  const col = TYPE_COLORS[node.type] ?? TYPE_COLORS.default;
  const color = new THREE.Color(col);
  const r = 0.4 + Math.pow(deg / maxDeg, 0.7) * 1.6;

  // Inner core
  const coreGeo = new THREE.SphereGeometry(r, 24, 16);
  const coreMat = new THREE.MeshStandardMaterial({
    color: col,
    emissive: col,
    emissiveIntensity: 0.3,
    metalness: 0.3,
    roughness: 0.4,
    transparent: true,
    opacity: 1.0,
  });
  const coreMesh = new THREE.Mesh(coreGeo, coreMat);
  group.add(coreMesh);

  // Outer glow shell
  const glowGeo = new THREE.SphereGeometry(r * 1.6, 16, 12);
  const glowMat = new THREE.MeshBasicMaterial({
    color: col,
    transparent: true,
    opacity: 0.08,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glowMesh = new THREE.Mesh(glowGeo, glowMat);
  group.add(glowMesh);

  group.userData = {
    nodeData: node,
    coreMesh,
    glowMesh,
    baseRadius: r,
    deg,
    labelSprite: null,
  };

  return group;
}

function createLabelSprite(THREE, text, hexColor) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = 28;
  ctx.font = `bold ${fontSize}px Rajdhani, sans-serif`;
  const metrics = ctx.measureText(text);
  const textW = Math.ceil(metrics.width) + 16;
  const textH = fontSize + 12;
  canvas.width = textW;
  canvas.height = textH;

  ctx.font = `bold ${fontSize}px Rajdhani, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#000000';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = '#e0e0e0';
  ctx.fillText(text, textW / 2, textH / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const spriteMat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    opacity: 0.85,
  });
  const sprite = new THREE.Sprite(spriteMat);
  const aspect = textW / textH;
  const scale = 2.0;
  sprite.scale.set(scale * aspect, scale, 1);

  return sprite;
}

function buildEdgeCurves(THREE, edgesWithIdx, positions, nodes) {
  // All arrays are indexed 1:1 with edgesWithIdx — null entries for invalid edges
  const curves = [];
  const edgeLines = [];
  const edgeMaterials = [];

  for (const e of edgesWithIdx) {
    if (e.sourceIdx == null || e.targetIdx == null) {
      curves.push(null);
      edgeLines.push(null);
      edgeMaterials.push(null);
      continue;
    }
    const sp = positions[e.sourceIdx];
    const tp = positions[e.targetIdx];
    const sv = new THREE.Vector3(sp.x, sp.y, sp.z);
    const tv = new THREE.Vector3(tp.x, tp.y, tp.z);

    // Control point: offset perpendicular to midpoint
    const mid = sv.clone().add(tv).multiplyScalar(0.5);
    const dir = tv.clone().sub(sv);
    const len = dir.length();
    const perp = new THREE.Vector3(-dir.y, dir.x, dir.z * 0.5).normalize();
    const offset = len * 0.15;
    const control = mid.clone().add(perp.multiplyScalar(offset));

    const curve = new THREE.QuadraticBezierCurve3(sv, control, tv);
    curves.push(curve);

    const pts = curve.getPoints(20);
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const sourceType = nodes[e.sourceIdx]?.type;
    const col = TYPE_COLORS[sourceType] ?? TYPE_COLORS.default;
    const lineMat = new THREE.LineBasicMaterial({
      color: col,
      transparent: true,
      opacity: 0.2,
    });
    const line = new THREE.Line(lineGeo, lineMat);
    edgeLines.push(line);
    edgeMaterials.push(lineMat);
  }

  return { curves, edgeLines, edgeMaterials };
}

function buildFlowParticles(THREE, curves) {
  const validCurves = curves.filter(c => c !== null);
  const count = validCurves.length;
  if (count === 0) return null;

  const posArr = new Float32Array(count * 3);
  const progress = new Float32Array(count);
  const speeds = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    progress[i] = Math.random();
    speeds[i] = 0.002 + Math.random() * 0.003;
    const pt = validCurves[i].getPointAt(progress[i]);
    posArr[i * 3] = pt.x;
    posArr[i * 3 + 1] = pt.y;
    posArr[i * 3 + 2] = pt.z;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  geo.attributes.position.setUsage(THREE.DynamicDrawUsage);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: 4.0 * Math.min(window.devicePixelRatio, 2) },
      uColor: { value: new THREE.Color(0xe6a817) },
    },
    vertexShader: `
      uniform float uSize;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * (80.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float alpha = smoothstep(0.5, 0.1, d) * 0.8;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geo, mat);

  return { points, progress, speeds, validCurves, posArr };
}

function buildBackgroundGrid(THREE) {
  const grid = new THREE.GridHelper(200, 40, 0x1a1510, 0x0f0d0a);
  grid.position.set(0, 0, -30);
  grid.rotation.x = Math.PI / 2;
  // GridHelper may have single or array material
  const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
  for (const m of mats) {
    m.transparent = true;
    m.opacity = 0.3;
  }
  return grid;
}

function buildDustParticles(THREE) {
  const count = 200;
  const posArr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    posArr[i * 3]     = (Math.random() - 0.5) * 120;
    posArr[i * 3 + 1] = (Math.random() - 0.5) * 120;
    posArr[i * 3 + 2] = (Math.random() - 0.5) * 80;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
  const mat = new THREE.PointsMaterial({
    color: 0x332a14,
    size: 0.15,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}

// ─── Force Simulation ──────────────────────────────────────────────────────

function buildSim(nodes, edges) {
  const n = nodes.length;
  const pos  = nodes.map(() => ({
    x: (Math.random() - 0.5) * 60,
    y: (Math.random() - 0.5) * 60,
    z: (Math.random() - 0.5) * 60,
  }));
  const vel  = nodes.map(() => ({ x: 0, y: 0, z: 0 }));

  function tick() {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i].x - pos[j].x;
        const dy = pos[i].y - pos[j].y;
        const dz = pos[i].z - pos[j].z;
        const r2 = dx * dx + dy * dy + dz * dz + 0.01;
        const f  = REPULSION_K / r2;
        const len = Math.sqrt(r2);
        vel[i].x += (dx / len) * f;
        vel[i].y += (dy / len) * f;
        vel[i].z += (dz / len) * f;
        vel[j].x -= (dx / len) * f;
        vel[j].y -= (dy / len) * f;
        vel[j].z -= (dz / len) * f;
      }
    }
    for (const e of edges) {
      const si = e.sourceIdx;
      const ti = e.targetIdx;
      if (si == null || ti == null) continue;
      const dx = pos[ti].x - pos[si].x;
      const dy = pos[ti].y - pos[si].y;
      const dz = pos[ti].z - pos[si].z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.001;
      const stretch = len - SPRING_REST;
      const f = SPRING_K * stretch / len;
      vel[si].x += dx * f;
      vel[si].y += dy * f;
      vel[si].z += dz * f;
      vel[ti].x -= dx * f;
      vel[ti].y -= dy * f;
      vel[ti].z -= dz * f;
    }
    for (let i = 0; i < n; i++) {
      vel[i].x *= DAMP;
      vel[i].y *= DAMP;
      vel[i].z *= DAMP;
      pos[i].x += vel[i].x;
      pos[i].y += vel[i].y;
      pos[i].z += vel[i].z;
    }
  }

  function run(ticks) {
    for (let t = 0; t < ticks; t++) tick();
    return pos;
  }

  return { run, vel, pos };
}

// ─── GraphView Component ───────────────────────────────────────────────────

export default function GraphView({ neuralStatus }) {
  const [mode, setMode]             = useState('3d');
  const [rawData, setRawData]       = useState(null);
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState('');
  const [debouncedSearch, setDS]    = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [tooltip, setTooltip]       = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [sideState, setSideState]   = useState(
    () => localStorage.getItem(SIDEBAR_KEY) || 'compact'
  );
  const [analytics, setAnalytics]   = useState(null);
  const [history, setHistory]       = useState(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
  });

  const canvasRef       = useRef(null);
  const threeRef        = useRef({});
  const searchTimerRef  = useRef(null);
  const animFrameRef    = useRef(null);
  const sseRef          = useRef(null);
  const selectedRef     = useRef(null);

  // Keep selectedRef in sync for use in animation loop
  useEffect(() => { selectedRef.current = selectedNode; }, [selectedNode]);

  // ── Debounce search ──────────────────────────────────────────────────────
  useEffect(() => {
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setDS(search), 500);
    return () => clearTimeout(searchTimerRef.current);
  }, [search]);

  // ── Fetch graph data ─────────────────────────────────────────────────────
  const fetchGraph = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (typeFilter !== 'ALL') params.set('type', typeFilter);
      const res  = await fetch(`${API}/neural/graph?${params}`);
      if (!res.ok) throw new Error('fetch failed');
      const data = await res.json();
      setRawData(data);
    } catch {
      setRawData({ nodes: [], edges: [] });
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, typeFilter]);

  useEffect(() => { fetchGraph(); }, [fetchGraph]);

  // ── Fetch analytics for sidebar ──────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API}/neural/status`);
        if (!res.ok) return;
        const raw = await res.json();
        const d = {
          record_count: raw.l1?.record_count       ?? 0,
          embeddings:   raw.l2?.total_embeddings   ?? 0,
          facts:        raw.l3?.fact_count         ?? 0,
          entities:     raw.lightrag?.entity_count ?? 0,
          queue_size:   raw.lightrag?.queue_size   ?? 0,
        };
        setAnalytics(d);
        setHistory(prev => {
          const next = [
            ...prev,
            { t: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
              total: d.record_count + d.embeddings + d.facts },
          ].slice(-24);
          localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
          return next;
        });
      } catch { /* silent */ }
    };
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, []);

  // ── SSE — live ingestion flash events ───────────────────────────────────
  useEffect(() => {
    if (mode !== '3d') return;
    let es;
    try {
      es = new EventSource(`${API}/stream`);
      sseRef.current = es;

      es.addEventListener('lightrag_ingest_entity', (e) => {
        try {
          const payload = JSON.parse(e.data);
          const { three } = threeRef.current;
          if (!three) return;
          const group = three.nodeMeshMap?.[payload.id];
          if (!group) return;
          const { coreMesh, glowMesh } = group.userData;

          // GSAP flash timeline
          const tl = gsap.timeline();
          tl.to(coreMesh.material, {
            emissiveIntensity: 2.0,
            duration: 0.15,
            ease: 'power2.out',
          });
          tl.to(glowMesh.scale, {
            x: 2, y: 2, z: 2,
            duration: 0.3,
            ease: 'power2.out',
          }, '<');
          tl.to(coreMesh.material, {
            emissiveIntensity: 0.3,
            duration: 1.0,
            ease: 'power2.inOut',
          }, '+=0.2');
          tl.to(glowMesh.scale, {
            x: 1, y: 1, z: 1,
            duration: 0.8,
            ease: 'power2.inOut',
          }, '<');

          // Flash connected edges
          if (three.edgeMap) {
            const connected = three.edgeMap[payload.id] || [];
            for (const mat of connected) {
              gsap.to(mat, {
                opacity: 0.8,
                duration: 0.4,
                yoyo: true,
                repeat: 1,
                ease: 'power2.inOut',
              });
            }
          }
        } catch { /* ignore */ }
      });
    } catch { /* SSE not available */ }

    return () => {
      es?.close();
      sseRef.current = null;
    };
  }, [mode]);

  // ── Sidebar persistence ───────────────────────────────────────────────────
  const cycleSidebar = useCallback(() => {
    setSideState(prev => {
      const idx  = SIDEBAR_STATES.indexOf(prev);
      const next = SIDEBAR_STATES[(idx + 1) % SIDEBAR_STATES.length];
      localStorage.setItem(SIDEBAR_KEY, next);
      return next;
    });
  }, []);

  // ── Selection handler ─────────────────────────────────────────────────────
  const applySelection = useCallback((nodeData, threeState) => {
    if (!threeState) return;
    const { meshes, edgeLines, edgesWithIdx, nodes } = threeState;
    const idxMap = {};
    nodes.forEach((n, i) => { idxMap[n.id] = i; });

    if (!nodeData) {
      // Deselect — restore all
      for (const grp of meshes) {
        const { coreMesh, glowMesh } = grp.userData;
        gsap.to(coreMesh.material, { opacity: 1.0, emissiveIntensity: 0.3, duration: 0.4 });
        gsap.to(glowMesh.material, { opacity: 0.08, duration: 0.4 });
      }
      if (edgeLines) {
        for (const line of edgeLines) {
          if (line?.material) gsap.to(line.material, { opacity: 0.2, duration: 0.4 });
        }
      }
      return;
    }

    // Build active set
    const activeIds = new Set([nodeData.id]);
    if (edgesWithIdx) {
      for (const e of edgesWithIdx) {
        if (e.sourceIdx == null || e.targetIdx == null) continue;
        const sId = nodes[e.sourceIdx]?.id;
        const tId = nodes[e.targetIdx]?.id;
        if (sId === nodeData.id) activeIds.add(tId);
        if (tId === nodeData.id) activeIds.add(sId);
      }
    }

    // Dim / highlight nodes
    for (const grp of meshes) {
      const nd = grp.userData.nodeData;
      const { coreMesh, glowMesh } = grp.userData;
      if (activeIds.has(nd.id)) {
        gsap.to(coreMesh.material, { opacity: 1.0, emissiveIntensity: nd.id === nodeData.id ? 0.6 : 0.4, duration: 0.4 });
        gsap.to(glowMesh.material, { opacity: nd.id === nodeData.id ? 0.18 : 0.1, duration: 0.4 });
      } else {
        gsap.to(coreMesh.material, { opacity: 0.12, emissiveIntensity: 0.0, duration: 0.4 });
        gsap.to(glowMesh.material, { opacity: 0.02, duration: 0.4 });
      }
    }

    // Dim / highlight edges
    if (edgeLines && edgesWithIdx) {
      edgesWithIdx.forEach((e, i) => {
        if (e.sourceIdx == null || e.targetIdx == null) return;
        if (!edgeLines[i] || !edgeLines[i].material) return;
        const sId = nodes[e.sourceIdx]?.id;
        const tId = nodes[e.targetIdx]?.id;
        const active = activeIds.has(sId) && activeIds.has(tId);
        gsap.to(edgeLines[i].material, { opacity: active ? 0.5 : 0.03, duration: 0.4 });
      });
    }
  }, []);

  // ── Camera animation helper ───────────────────────────────────────────────
  const animateCamera = useCallback((camera, controls, target, distance) => {
    if (!camera || !controls) return;
    controls.enabled = false;
    const dir = camera.position.clone().sub(controls.target).normalize();
    const newPos = target.clone().add(dir.multiplyScalar(distance));
    gsap.to(camera.position, {
      x: newPos.x, y: newPos.y, z: newPos.z,
      duration: 0.8,
      ease: 'power2.inOut',
      onUpdate: () => camera.lookAt(target),
      onComplete: () => {
        controls.target.copy(target);
        controls.enabled = true;
      },
    });
  }, []);

  // ── Three.js scene init / teardown ────────────────────────────────────────
  useEffect(() => {
    if (mode !== '3d' || !canvasRef.current || !rawData) return;

    let cancelled = false;

    const initThree = async () => {
      const THREE = await import('three');
      const { OrbitControls }   = await import('three/examples/jsm/controls/OrbitControls.js');
      const { EffectComposer }  = await import('three/examples/jsm/postprocessing/EffectComposer.js');
      const { RenderPass }      = await import('three/examples/jsm/postprocessing/RenderPass.js');
      const { UnrealBloomPass } = await import('three/examples/jsm/postprocessing/UnrealBloomPass.js');
      const { BokehPass }       = await import('three/examples/jsm/postprocessing/BokehPass.js');

      if (cancelled) return;

      const canvas = canvasRef.current;
      const W = canvas.offsetWidth  || 800;
      const H = canvas.offsetHeight || 600;

      // Scene
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x060504);

      // Camera
      const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 1000);
      camera.position.set(0, 0, 80);

      // Renderer
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setSize(W, H);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

      // Lights
      scene.add(new THREE.AmbientLight(0xffffff, 0.4));
      const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
      dirLight.position.set(50, 50, 50);
      scene.add(dirLight);

      // Controls
      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;

      // Post-processing (boosted bloom)
      const composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(W, H), 0.6, 0.4, 0.6
      );
      composer.addPass(bloomPass);
      const bokehPass = new BokehPass(scene, camera, {
        focus:    50,
        aperture: 0.001,
        maxblur:  0.005,
        width:    W,
        height:   H,
      });
      composer.addPass(bokehPass);

      // ── Background grid + dust ───────────────────────────────────
      let dust = null;
      try {
        const grid = buildBackgroundGrid(THREE);
        scene.add(grid);
        dust = buildDustParticles(THREE);
        scene.add(dust);
      } catch (e) { console.warn('Background effects failed:', e); }

      // ── Build nodes ──────────────────────────────────────────────
      const nodes = rawData.nodes || [];
      const edges = rawData.edges || [];

      // Compute degree
      const degree = {};
      for (const n of nodes) degree[n.id] = 0;
      for (const e of edges) {
        if (degree[e.source] != null) degree[e.source]++;
        if (degree[e.target] != null) degree[e.target]++;
      }
      const maxDeg = Math.max(1, ...Object.values(degree));

      // Build index map
      const idxMap = {};
      nodes.forEach((n, i) => { idxMap[n.id] = i; });

      // Build edge index list
      const edgesWithIdx = edges.map(e => ({
        ...e,
        sourceIdx: idxMap[e.source] ?? null,
        targetIdx: idxMap[e.target] ?? null,
      }));

      // Force sim
      const sim = buildSim(nodes, edgesWithIdx);
      const positions = sim.run(SIM_TICKS);

      // Create node groups
      const nodeMeshMap = {};
      const meshes = [];
      const basePositions = [];

      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const deg = degree[n.id] || 0;
        const group = createNodeGroup(THREE, n, deg, maxDeg);
        group.position.set(positions[i].x, positions[i].y, positions[i].z);
        basePositions.push({ x: positions[i].x, y: positions[i].y, z: positions[i].z });

        // Label sprite
        const labelText = n.label || n.id;
        if (labelText) {
          const sprite = createLabelSprite(THREE, labelText, TYPE_COLORS[n.type] ?? TYPE_COLORS.default);
          sprite.position.set(0, group.userData.baseRadius + 0.8, 0);
          const alwaysShow = (deg / maxDeg) > 0.3;
          sprite.visible = alwaysShow;
          group.userData.labelSprite = sprite;
          group.userData.labelAlwaysVisible = alwaysShow;
          group.add(sprite);
        }

        scene.add(group);
        meshes.push(group);
        nodeMeshMap[n.id] = group;
      }

      // ── Curved edges + flow particles ────────────────────────────
      const { curves, edgeLines, edgeMaterials } = buildEdgeCurves(THREE, edgesWithIdx, positions, nodes);
      for (const line of edgeLines) { if (line) scene.add(line); }

      // Build edge map for SSE flash (node id → connected edge materials)
      const edgeMap = {};
      edgesWithIdx.forEach((e, i) => {
        if (e.sourceIdx == null || e.targetIdx == null) return;
        if (!edgeMaterials[i]) return;
        const sId = nodes[e.sourceIdx]?.id;
        const tId = nodes[e.targetIdx]?.id;
        if (sId) { (edgeMap[sId] = edgeMap[sId] || []).push(edgeMaterials[i]); }
        if (tId) { (edgeMap[tId] = edgeMap[tId] || []).push(edgeMaterials[i]); }
      });

      // Flow particles
      let flow = null;
      try {
        flow = buildFlowParticles(THREE, curves);
        if (flow) scene.add(flow.points);
      } catch (e) { console.warn('Flow particles failed:', e); }

      // ── Particle ring for active queue ───────────────────────────
      let particles = null;
      if (neuralStatus?.queue_size > 0) {
        const ptCount = 40;
        const ptPos   = new Float32Array(ptCount * 3);
        for (let i = 0; i < ptCount; i++) {
          const a = (i / ptCount) * Math.PI * 2;
          ptPos[i * 3]     = Math.cos(a) * 35;
          ptPos[i * 3 + 1] = Math.sin(a) * 35;
          ptPos[i * 3 + 2] = 0;
        }
        const ptGeo = new THREE.BufferGeometry();
        ptGeo.setAttribute('position', new THREE.Float32BufferAttribute(ptPos, 3));
        const ptMat = new THREE.PointsMaterial({ color: 0xe6a817, size: 0.4, transparent: true, opacity: 0.6 });
        particles = new THREE.Points(ptGeo, ptMat);
        scene.add(particles);
      }

      // ── Entrance animation (GSAP staggered) ─────────────────────
      try {
        const staggerDelay = Math.min(0.03, 2.0 / Math.max(nodes.length, 1));
        for (let i = 0; i < meshes.length; i++) {
          gsap.from(meshes[i].scale, {
            x: 0.001, y: 0.001, z: 0.001,
            duration: 0.6,
            ease: 'back.out(1.7)',
            delay: i * staggerDelay,
          });
        }
        // Fade in edges after nodes
        const edgeFadeDelay = nodes.length * staggerDelay + 0.2;
        for (const mat of edgeMaterials) {
          if (!mat) continue;
          gsap.from(mat, {
            opacity: 0.0,
            duration: 0.6,
            delay: edgeFadeDelay,
            ease: 'power2.out',
          });
        }
      } catch (e) { console.warn('GSAP entrance animation failed:', e); }

      // ── Zoom to fit ──────────────────────────────────────────────
      if (positions.length > 0) {
        const box = new THREE.Box3();
        for (const p of positions) {
          box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z));
        }
        const sphere = new THREE.Sphere();
        box.getBoundingSphere(sphere);
        const dist = Math.max(sphere.radius * 2.5, 30);
        camera.position.set(sphere.center.x, sphere.center.y, sphere.center.z + dist);
        controls.target.copy(sphere.center);
        controls.update();
      }

      // ── Resize observer ──────────────────────────────────────────
      const resizeObs = new ResizeObserver(() => {
        if (!canvas.parentElement) return;
        const w = canvas.parentElement.offsetWidth;
        const h = canvas.parentElement.offsetHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        composer.setSize(w, h);
      });
      if (canvas.parentElement) resizeObs.observe(canvas.parentElement);

      // Store all refs
      threeRef.current.three = {
        scene, camera, renderer, controls, composer,
        meshes, nodeMeshMap, particles, bokehPass,
        edgeLines, edgeMaterials, edgesWithIdx, curves, flow,
        edgeMap, nodes, basePositions, dust,
      };

      // ── Raycaster (throttled) ─────────────────────────────────────
      const raycaster = new THREE.Raycaster();
      const mouse = new THREE.Vector2();
      let lastRaycast = 0;
      let hoveredGroup = null;

      const getHitGroup = (ev) => {
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObjects(meshes, true);
        if (hits.length > 0) {
          let obj = hits[0].object;
          while (obj && !obj.userData?.nodeData) obj = obj.parent;
          return obj;
        }
        return null;
      };

      const onMouseMove = (ev) => {
        const now = performance.now();
        if (now - lastRaycast < RAYCAST_THROTTLE_MS) return;
        lastRaycast = now;

        const rect = canvas.getBoundingClientRect();
        const grp = getHitGroup(ev);

        if (grp) {
          const nd = grp.userData.nodeData;
          setTooltip({ x: ev.clientX - rect.left + 12, y: ev.clientY - rect.top - 10, node: nd });
          // Show label on hover
          if (hoveredGroup !== grp) {
            if (hoveredGroup?.userData?.labelSprite && !hoveredGroup.userData.labelAlwaysVisible) {
              hoveredGroup.userData.labelSprite.visible = false;
            }
            hoveredGroup = grp;
            if (grp.userData.labelSprite) grp.userData.labelSprite.visible = true;
          }
          canvas.style.cursor = 'pointer';
        } else {
          setTooltip(null);
          if (hoveredGroup?.userData?.labelSprite && !hoveredGroup.userData.labelAlwaysVisible) {
            hoveredGroup.userData.labelSprite.visible = false;
          }
          hoveredGroup = null;
          canvas.style.cursor = 'default';
        }
      };

      const onClick = (ev) => {
        const grp = getHitGroup(ev);
        if (grp) {
          const nd = grp.userData.nodeData;
          const alreadySelected = selectedRef.current?.id === nd.id;
          if (alreadySelected) {
            setSelectedNode(null);
            applySelection(null, threeRef.current.three);
            // Zoom back
            if (positions.length > 0) {
              const box = new THREE.Box3();
              for (const p of positions) box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z));
              const sphere = new THREE.Sphere();
              box.getBoundingSphere(sphere);
              animateCamera(camera, controls, sphere.center, Math.max(sphere.radius * 2.5, 30));
            }
          } else {
            setSelectedNode(nd);
            applySelection(nd, threeRef.current.three);
            animateCamera(camera, controls, grp.position.clone(), 25);
          }
        } else {
          if (selectedRef.current) {
            setSelectedNode(null);
            applySelection(null, threeRef.current.three);
            if (positions.length > 0) {
              const box = new THREE.Box3();
              for (const p of positions) box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z));
              const sphere = new THREE.Sphere();
              box.getBoundingSphere(sphere);
              animateCamera(camera, controls, sphere.center, Math.max(sphere.radius * 2.5, 30));
            }
          }
        }
      };

      canvas.addEventListener('mousemove', onMouseMove);
      canvas.addEventListener('click', onClick);
      threeRef.current.cleanupEvents = () => {
        canvas.removeEventListener('mousemove', onMouseMove);
        canvas.removeEventListener('click', onClick);
      };

      // ── Animation loop ────────────────────────────────────────────
      const clock = new THREE.Clock();

      const animate = () => {
        if (cancelled) return;
        animFrameRef.current = requestAnimationFrame(animate);
        const time = clock.getElapsedTime();
        controls.update();

        // Bokeh focus tracking
        const dist = camera.position.distanceTo(controls.target);
        if (bokehPass.uniforms) {
          bokehPass.uniforms['focus'].value = dist;
        }

        // Node idle animations
        const camDist = camera.position.length();
        for (let i = 0; i < meshes.length; i++) {
          const grp = meshes[i];
          const bp = basePositions[i];
          // Gentle float
          grp.position.y = bp.y + Math.sin(time * 0.5 + i * 0.7) * 0.15;
          // Glow pulse
          const { glowMesh, labelSprite } = grp.userData;
          if (glowMesh) {
            glowMesh.material.opacity = 0.085 + Math.sin(time * 0.8 + i) * 0.035;
          }
          // LOD: hide labels when zoomed far out
          if (labelSprite && grp.userData.labelAlwaysVisible) {
            labelSprite.visible = camDist < 120;
          }
        }

        // Dust drift
        if (dust) {
          const dPos = dust.geometry.attributes.position.array;
          for (let i = 1; i < dPos.length; i += 3) {
            dPos[i] += 0.003;
            if (dPos[i] > 60) dPos[i] = -60;
          }
          dust.geometry.attributes.position.needsUpdate = true;
        }

        // Flow particles
        if (flow) {
          for (let i = 0; i < flow.validCurves.length; i++) {
            flow.progress[i] += flow.speeds[i];
            if (flow.progress[i] > 1) flow.progress[i] -= 1;
            const pt = flow.validCurves[i].getPointAt(flow.progress[i]);
            flow.posArr[i * 3] = pt.x;
            flow.posArr[i * 3 + 1] = pt.y;
            flow.posArr[i * 3 + 2] = pt.z;
          }
          flow.points.geometry.attributes.position.needsUpdate = true;
        }

        // Rotate queue particles
        if (particles) particles.rotation.z += 0.003;

        composer.render();
      };
      animate();

      resizeObs.observe(canvas.parentElement || canvas);
      threeRef.current.resizeObs = resizeObs;
      threeRef.current.simRef = { vel: sim.vel, pos: positions, edges: edgesWithIdx, nodes };
    };

    initThree().catch(console.error);

    return () => {
      cancelled = true;
      cancelAnimationFrame(animFrameRef.current);
      const { three, cleanupEvents, resizeObs } = threeRef.current;
      cleanupEvents?.();
      resizeObs?.disconnect();
      if (three) {
        three.controls.dispose();
        three.composer.dispose();
        three.renderer.dispose();
      }
      threeRef.current = {};
      setTooltip(null);
      setSelectedNode(null);
    };
  }, [mode, rawData, neuralStatus?.queue_size, applySelection, animateCamera]);

  // ── Re-simulate ───────────────────────────────────────────────────────────
  const handleResim = useCallback(() => {
    const { three, simRef } = threeRef.current;
    if (!three || !simRef) return;
    const { nodes, edges, pos } = simRef;

    const newSim = buildSim(nodes, edges);
    for (let i = 0; i < nodes.length; i++) {
      newSim.pos[i] = { ...pos[i] };
    }
    const newPos = newSim.run(SIM_TICKS);

    // Animate node groups to new positions
    three.meshes.forEach((grp, i) => {
      gsap.to(grp.position, {
        x: newPos[i].x, y: newPos[i].y, z: newPos[i].z,
        duration: 0.6,
        ease: 'power2.inOut',
      });
      three.basePositions[i] = { x: newPos[i].x, y: newPos[i].y, z: newPos[i].z };
    });

    // Rebuild edge curves
    if (three.edgeLines && three.curves) {
      const THREE_MOD = { Vector3: three.scene.position.constructor, QuadraticBezierCurve3: three.curves[0]?.constructor };
      // We need to update curves after positions settle — use a delayed update
      setTimeout(() => {
        for (let idx = 0; idx < three.edgesWithIdx.length; idx++) {
          const e = three.edgesWithIdx[idx];
          if (e.sourceIdx == null || e.targetIdx == null) continue;
          const sp = newPos[e.sourceIdx];
          const tp = newPos[e.targetIdx];
          if (!three.curves[idx] || !three.edgeLines[idx]) continue;

          const sv = new three.scene.position.constructor(sp.x, sp.y, sp.z);
          const tv = new three.scene.position.constructor(tp.x, tp.y, tp.z);
          const mid = sv.clone().add(tv).multiplyScalar(0.5);
          const dir = tv.clone().sub(sv);
          const len = dir.length();
          const perp = new three.scene.position.constructor(-dir.y, dir.x, dir.z * 0.5).normalize();
          const control = mid.clone().add(perp.multiplyScalar(len * 0.15));

          three.curves[idx].v0.copy(sv);
          three.curves[idx].v1.copy(control);
          three.curves[idx].v2.copy(tv);

          const pts = three.curves[idx].getPoints(20);
          three.edgeLines[idx].geometry.setFromPoints(pts);
        }

        // Update flow particles
        if (three.flow) {
          const validIdx = [];
          for (let i = 0; i < three.curves.length; i++) {
            if (three.curves[i]) validIdx.push(i);
          }
          three.flow.validCurves = validIdx.map(i => three.curves[i]);
        }
      }, 650);
    }

    simRef.pos = newPos;
  }, []);

  // ── ReactFlow mode ────────────────────────────────────────────────────────
  const rfNodes = useMemo(() => {
    if (!rawData || mode !== '2d') return [];
    return (rawData.nodes || []).map((n, i) => ({
      id:       String(n.id),
      position: { x: (i % 10) * 120 + 50, y: Math.floor(i / 10) * 100 + 50 },
      data:     { label: n.label || n.id, type: n.type },
      type:     'entityNode',
    }));
  }, [rawData, mode]);

  const rfEdges = useMemo(() => {
    if (!rawData || mode !== '2d') return [];
    return (rawData.edges || []).map((e, i) => ({
      id:     `e${i}`,
      source: String(e.source),
      target: String(e.target),
      style:  { stroke: '#2a2218', strokeWidth: 1 },
    }));
  }, [rawData, mode]);

  // ── Detail panel — connected nodes ────────────────────────────────────────
  const connectedNodes = useMemo(() => {
    if (!selectedNode || !rawData) return [];
    const edges = rawData.edges || [];
    const nodes = rawData.nodes || [];
    const nodeMap = {};
    for (const n of nodes) nodeMap[n.id] = n;
    const connected = new Set();
    for (const e of edges) {
      if (e.source === selectedNode.id && nodeMap[e.target]) connected.add(nodeMap[e.target]);
      if (e.target === selectedNode.id && nodeMap[e.source]) connected.add(nodeMap[e.source]);
    }
    return Array.from(connected);
  }, [selectedNode, rawData]);

  const handleDetailNodeClick = useCallback((nd) => {
    setSelectedNode(nd);
    const { three } = threeRef.current;
    if (three) {
      applySelection(nd, three);
      const grp = three.nodeMeshMap?.[nd.id];
      if (grp) {
        animateCamera(three.camera, three.controls, grp.position.clone(), 25);
      }
    }
  }, [applySelection, animateCamera]);

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className={styles.wrapper}>
      {/* ── Canvas / Flow area ─────────────────────── */}
      <div className={styles.canvasContainer}>
        {neuralStatus?.ingestion_mode && <div className={styles.ingestionRing} />}

        {mode === '3d' && (
          <canvas ref={canvasRef} className={styles.canvas3d} />
        )}

        {mode === '2d' && rawData && (
          <ReactFlowView nodes={rfNodes} edges={rfEdges} />
        )}

        {loading && (
          <div className={styles.emptyState} style={{ position: 'absolute', inset: 0, background: 'rgba(6,5,4,0.7)', zIndex: 15 }}>
            <span className={styles.emptyIcon}>⬡</span>
            <span>LOADING GRAPH...</span>
          </div>
        )}

        {!loading && rawData?.nodes?.length === 0 && (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon}>⬡</span>
            <span>NO GRAPH DATA</span>
          </div>
        )}

        {/* ── Toolbar ─────────────────────────────── */}
        <div className={styles.toolbar}>
          <div className={styles.toggleGroup}>
            <button
              className={`${styles.toggleBtn} ${mode === '3d' ? styles.toggleBtnActive : ''}`}
              onClick={() => setMode('3d')}
            >
              ⬡ 3D
            </button>
            <button
              className={`${styles.toggleBtn} ${mode === '2d' ? styles.toggleBtnActive : ''}`}
              onClick={() => setMode('2d')}
            >
              ◈ 2D
            </button>
          </div>

          <input
            className={styles.searchInput}
            placeholder="Search entities..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />

          <div className={styles.filterChips}>
            {ENTITY_TYPES.map(t => (
              <button
                key={t}
                className={`${styles.filterChip} ${typeFilter === t ? styles.filterChipActive : ''}`}
                onClick={() => setTypeFilter(t)}
              >
                {t}
              </button>
            ))}
          </div>

          {mode === '3d' && (
            <button className={styles.resimBtn} onClick={handleResim}>
              ↻ Re-simulate
            </button>
          )}
        </div>

        {/* ── Tooltip ─────────────────────────────── */}
        {tooltip && !selectedNode && (
          <div
            className={styles.tooltip}
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            <div className={styles.tooltipName}>{tooltip.node.label || tooltip.node.id}</div>
            <div className={styles.tooltipType}>{tooltip.node.type || 'UNKNOWN'}</div>
            {tooltip.node.description && (
              <div className={styles.tooltipDesc}>{tooltip.node.description}</div>
            )}
          </div>
        )}

        {/* ── Detail Panel (Phase 5) ─────────────── */}
        {selectedNode && mode === '3d' && (
          <div className={styles.detailPanel}>
            <button
              className={styles.detailPanelClose}
              onClick={() => {
                setSelectedNode(null);
                applySelection(null, threeRef.current.three);
              }}
            >
              ×
            </button>
            <div className={styles.detailPanelName}>
              {selectedNode.label || selectedNode.id}
            </div>
            <div className={styles.detailPanelType} style={{ color: TYPE_CSS[selectedNode.type] ?? TYPE_CSS.default }}>
              {selectedNode.type || 'UNKNOWN'}
            </div>
            {selectedNode.description && (
              <div className={styles.detailPanelDesc}>{selectedNode.description}</div>
            )}
            {connectedNodes.length > 0 && (
              <div className={styles.detailPanelSection}>
                <div className={styles.detailPanelSectionTitle}>
                  CONNECTIONS ({connectedNodes.length})
                </div>
                {connectedNodes.slice(0, 12).map(cn => (
                  <button
                    key={cn.id}
                    className={styles.detailPanelConnection}
                    onClick={() => handleDetailNodeClick(cn)}
                  >
                    <span
                      className={styles.detailPanelDot}
                      style={{ background: TYPE_CSS[cn.type] ?? TYPE_CSS.default }}
                    />
                    {cn.label || cn.id}
                  </button>
                ))}
                {connectedNodes.length > 12 && (
                  <div className={styles.detailPanelMore}>+{connectedNodes.length - 12} more</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Analytics Sidebar ──────────────────────── */}
      <div className={`${styles.sidebar} ${SIDEBAR_WIDTHS[sideState]}`}>
        <button
          className={styles.sidebarToggle}
          onClick={cycleSidebar}
          title="Toggle sidebar"
        >
          {sideState === 'collapsed' ? '›' : sideState === 'compact' ? '»' : '‹'}
        </button>

        {sideState === 'collapsed' && (
          <>
            <span className={styles.sidebarCollapsedLabel}>ANALYTICS</span>
            <div className={styles.sidebarCollapsedDots}>
              {['ledGreen', 'ledGreen', 'ledGreen', 'ledAmber'].map((cls, i) => (
                <span
                  key={i}
                  style={{
                    display: 'block',
                    width: 5, height: 5,
                    borderRadius: '50%',
                    background: i < 3 ? '#22c55e' : '#f59e0b',
                    marginBottom: 3,
                  }}
                />
              ))}
            </div>
          </>
        )}

        {sideState === 'compact' && analytics && (
          <div className={styles.sidebarContent}>
            <div className={styles.sidebarHeader}>Analytics</div>
            {[
              { label: 'L1 Records',   value: analytics.record_count ?? 0 },
              { label: 'L2 Embeddings', value: analytics.embeddings ?? 0 },
              { label: 'L3 Facts',     value: analytics.facts ?? 0 },
              { label: 'Queue',         value: analytics.queue_size ?? 0 },
            ].map(row => (
              <div key={row.label} className={styles.metricRow}>
                <span className={styles.metricLabel}>{row.label}</span>
                <span className={styles.metricValue}>{row.value.toLocaleString()}</span>
              </div>
            ))}
            <MiniDonut analytics={analytics} />
          </div>
        )}

        {sideState === 'expanded' && analytics && (
          <div className={styles.sidebarContent}>
            <div className={styles.sidebarHeader}>Memory Layers</div>
            {[
              { label: 'L1 SQLite',   value: analytics.record_count ?? 0,  color: '#e6a817' },
              { label: 'L2 ChromaDB', value: analytics.embeddings ?? 0,    color: '#3b82f6' },
              { label: 'L3 Neo4j',    value: analytics.facts ?? 0,         color: '#8b5cf6' },
              { label: 'LightRAG',    value: analytics.entities ?? 0,      color: '#14b8a6' },
            ].map(row => (
              <div key={row.label} className={styles.sideCard}>
                <div className={styles.sideCardTitle} style={{ color: row.color }}>{row.label}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#e0e0e0', fontFamily: 'var(--font-mono, monospace)' }}>
                  {row.value.toLocaleString()}
                </div>
              </div>
            ))}
            {history.length > 1 && <MiniHistoryChart history={history} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Mini Donut (no recharts dep in GraphView) ──────────────────────────────

function MiniDonut({ analytics }) {
  const total = (analytics.record_count ?? 0) + (analytics.embeddings ?? 0) + (analytics.facts ?? 0) + (analytics.entities ?? 0) + 0.001;
  const segs = [
    { v: analytics.record_count ?? 0, color: '#e6a817' },
    { v: analytics.embeddings   ?? 0, color: '#3b82f6' },
    { v: analytics.facts        ?? 0, color: '#8b5cf6' },
    { v: analytics.entities     ?? 0, color: '#14b8a6' },
  ];
  const r = 30, cx = 40, cy = 40, strokeW = 8;
  let cumAngle = -Math.PI / 2;
  const arcs = segs.map(s => {
    const angle = (s.v / total) * Math.PI * 2;
    const x1 = cx + r * Math.cos(cumAngle);
    const y1 = cy + r * Math.sin(cumAngle);
    cumAngle += angle;
    const x2 = cx + r * Math.cos(cumAngle);
    const y2 = cy + r * Math.sin(cumAngle);
    const large = angle > Math.PI ? 1 : 0;
    return { d: `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`, color: s.color };
  });
  return (
    <div className={styles.miniDonutWrapper}>
      <svg width={80} height={80}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1e1e1e" strokeWidth={strokeW} />
        {arcs.map((arc, i) => (
          <path key={i} d={arc.d} fill="none" stroke={arc.color} strokeWidth={strokeW} strokeLinecap="butt" />
        ))}
      </svg>
    </div>
  );
}

function MiniHistoryChart({ history }) {
  if (history.length < 2) return null;
  const vals  = history.map(p => p.total);
  const maxV  = Math.max(...vals, 1);
  const W = 280, H = 60;
  const points = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W;
    const y = H - (v / maxV) * (H - 8) - 2;
    return `${x},${y}`;
  }).join(' ');
  return (
    <div className={styles.sideCard}>
      <div className={styles.sideCardTitle}>24hr History</div>
      <svg width={W} height={H} style={{ overflow: 'visible' }}>
        <polyline
          points={points}
          fill="none"
          stroke="#e6a817"
          strokeWidth={1.5}
          strokeLinejoin="round"
          opacity={0.8}
        />
      </svg>
      <div style={{ fontSize: 9, color: '#444', marginTop: 4, fontFamily: 'monospace' }}>
        {history[0].t} → {history[history.length - 1].t}
      </div>
    </div>
  );
}

// ─── ReactFlow View (2D) ───────────────────────────────────────────────────

function EntityNode({ data }) {
  const color = TYPE_CSS[data.type] ?? TYPE_CSS.default;
  return (
    <div style={{
      padding:      '4px 10px',
      background:   'rgba(20,20,20,0.95)',
      border:       `1px solid ${color}55`,
      borderRadius: 3,
      color:        color,
      fontSize:     10,
      fontFamily:   'var(--font-condensed, monospace)',
      fontWeight:   600,
      letterSpacing: '.04em',
      whiteSpace:   'nowrap',
    }}>
      {data.label}
    </div>
  );
}

function ReactFlowView({ nodes, edges }) {
  const [ReactFlow, setRF] = useState(null);
  const [rfExtra, setExtra] = useState(null);

  useEffect(() => {
    let cancelled = false;
    import('@xyflow/react').then(mod => {
      if (cancelled) return;
      setRF(() => mod.ReactFlow);
      setExtra({ MiniMap: mod.MiniMap, Controls: mod.Controls, Background: mod.Background });
    }).catch(() => {});
    import('@xyflow/react/dist/style.css').catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!ReactFlow || !rfExtra) {
    return (
      <div className={styles.emptyState} style={{ position: 'absolute', inset: 0 }}>
        <span>Loading 2D...</span>
      </div>
    );
  }

  const { MiniMap, Controls, Background } = rfExtra;

  return (
    <div className={styles.flowContainer}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={{ entityNode: EntityNode }}
        fitView
        proOptions={{ hideAttribution: true }}
        style={{ background: '#060504' }}
      >
        <Background color="#1a1a1a" gap={20} />
        <Controls style={{ background: '#141414', border: '1px solid #2a2a2a' }} />
        <MiniMap
          style={{ background: '#141414', border: '1px solid #2a2a2a' }}
          maskColor="rgba(0,0,0,0.6)"
        />
      </ReactFlow>
    </div>
  );
}
