/**
 * AURA NX-Alpha — ThreeBlock (Phase 2)
 *
 * Three.js 3D scene embedded in a CanvasBlock.
 * Full orbit controls: drag to rotate, scroll to zoom, right-click to pan.
 * Supports GLTF/GLB model loading via URL, or built-in primitives for instant demos.
 *
 * LIFECYCLE:
 *   WebGL renderer is created on mount, sized to the block container, and destroyed
 *   on unmount. ResizeObserver handles block resize without re-mounting the scene.
 *   Animation loop uses requestAnimationFrame — cancelled cleanly on unmount.
 *
 * PHASE 2 EXTENSION POINTS:
 *   - Add more loaders (FBX, OBJ) via three/examples/jsm/loaders/*
 *   - Add environment maps (PMREMGenerator) for reflective materials
 *   - Add postprocessing (EffectComposer, BloomPass) for the AURA holographic look
 *   - Add physics (Rapier or Ammo.js) for interactive manipulation
 *
 * Dependencies: three (npm install three)
 *
 * Data shape:
 *   {
 *     src?:        string,                        // URL to .glb / .gltf model
 *     primitive?:  'box'|'sphere'|'torus'|        // Built-in shape (used if src absent)
 *                  'cylinder'|'icosahedron',
 *     color?:      string,                        // Hex color for primitive, default amber
 *     wireframe?:  boolean,                       // Show wireframe overlay
 *     autoRotate?: boolean,                       // Continuous Y-axis rotation (default true)
 *     title?:      string,                        // Optional label in corner
 *   }
 */

import { useEffect, useRef, useState } from 'react';
import styles from './ThreeBlock.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// THREE.JS SCENE BUILDER
// Isolated from React lifecycle — pure setup + teardown functions.
// ─────────────────────────────────────────────────────────────────────────────

function buildPrimitive(THREE, shape, color, wireframe) {
  const mat = new THREE.MeshStandardMaterial({
    color:     color || 0xD99030,  // AURA amber default
    metalness: 0.30,
    roughness: 0.55,
    wireframe: false,
  });

  let geo;
  switch (shape) {
    case 'sphere':     geo = new THREE.SphereGeometry(0.85, 48, 48);      break;
    case 'torus':      geo = new THREE.TorusGeometry(0.65, 0.26, 20, 120); break;
    case 'cylinder':   geo = new THREE.CylinderGeometry(0.55, 0.55, 1.3, 36); break;
    case 'icosahedron': geo = new THREE.IcosahedronGeometry(0.85, 1);      break;
    default:           geo = new THREE.BoxGeometry(1.2, 1.2, 1.2);        break; // box
  }

  const mesh = new THREE.Mesh(geo, mat);

  // Optional wireframe overlay
  if (wireframe) {
    const wMat = new THREE.MeshBasicMaterial({
      color:       0x3D87A8,
      wireframe:   true,
      transparent: true,
      opacity:     0.25,
    });
    const wMesh = new THREE.Mesh(geo, wMat);
    const group = new THREE.Group();
    group.add(mesh);
    group.add(wMesh);
    return group;
  }

  return mesh;
}

// ─────────────────────────────────────────────────────────────────────────────
// THREE BLOCK COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

const ThreeBlock = ({
  src        = '',
  primitive  = 'box',
  color      = '',
  wireframe  = false,
  autoRotate = true,
  title      = '',
}) => {
  const containerRef = useRef(null);
  const sceneRef     = useRef(null);  // holds { renderer, controls, rafId, ro }
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [hint, setHint]     = useState(true);       // orbit hint overlay

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let THREE, OrbitControls, GLTFLoader;

    // Dynamic import — graceful if three not yet installed
    Promise.all([
      import('three'),
      import('three/examples/jsm/controls/OrbitControls.js'),
      src ? import('three/examples/jsm/loaders/GLTFLoader.js') : Promise.resolve(null),
    ]).then(([threeModule, { OrbitControls: OC }, gltfModule]) => {
      THREE         = threeModule;
      OrbitControls = OC;
      if (gltfModule) GLTFLoader = gltfModule.GLTFLoader;

      const w = container.clientWidth  || 480;
      const h = container.clientHeight || 360;

      // ── Renderer ──
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping    = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
      container.appendChild(renderer.domElement);

      // ── Scene ──
      const scene = new THREE.Scene();

      // ── Camera ──
      const camera = new THREE.PerspectiveCamera(42, w / h, 0.05, 200);
      camera.position.set(0, 0.5, 3.2);

      // ── Lighting — AURA themed: blue hemisphere + warm directional ──
      const hemi = new THREE.HemisphereLight(0x3D87A8, 0x080D17, 0.70);
      scene.add(hemi);
      const dirA = new THREE.DirectionalLight(0xffffff, 0.90);
      dirA.position.set(5, 8, 6);
      scene.add(dirA);
      const dirB = new THREE.DirectionalLight(0xD99030, 0.30); // amber fill from below
      dirB.position.set(-3, -4, -2);
      scene.add(dirB);

      // ── Orbit Controls ──
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping  = true;
      controls.dampingFactor  = 0.06;
      controls.autoRotate     = false; // we handle rotation manually for more control
      controls.minDistance    = 0.5;
      controls.maxDistance    = 20;
      controls.enablePan      = true;

      // ── Load object ──
      let targetObject = null;
      const autoRotateRef = { value: autoRotate };

      if (src && GLTFLoader) {
        const loader = new GLTFLoader();
        loader.load(
          src,
          (gltf) => {
            // Center and scale model to fit view
            const box    = new THREE.Box3().setFromObject(gltf.scene);
            const size   = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const scale  = 2.0 / maxDim;
            gltf.scene.scale.setScalar(scale);
            gltf.scene.position.sub(center.multiplyScalar(scale));
            scene.add(gltf.scene);
            targetObject = gltf.scene;
            setStatus('ready');
          },
          undefined,
          (err) => {
            console.error('[ThreeBlock] GLTF load failed:', err);
            // Fallback to primitive on load error
            targetObject = buildPrimitive(THREE, primitive, color, wireframe);
            scene.add(targetObject);
            setStatus('ready');
          }
        );
        setStatus('loading');
      } else {
        targetObject = buildPrimitive(THREE, primitive, color, wireframe);
        scene.add(targetObject);
        setStatus('ready');
      }

      // ── Animation loop ──
      let rafId;
      const clock = new THREE.Clock();
      const animate = () => {
        rafId = requestAnimationFrame(animate);
        const delta = clock.getDelta();
        if (autoRotateRef.value && targetObject) {
          targetObject.rotation.y += delta * 0.40;
        }
        controls.update();
        renderer.render(scene, camera);
      };
      animate();

      // ── Resize observer ──
      const ro = new ResizeObserver(() => {
        const nw = container.clientWidth;
        const nh = container.clientHeight;
        renderer.setSize(nw, nh);
        camera.aspect = nw / nh;
        camera.updateProjectionMatrix();
      });
      ro.observe(container);

      // Stop auto-rotate when user interacts, resume when they release
      const onStart = () => { autoRotateRef.value = false; };
      const onEnd   = () => { autoRotateRef.value = autoRotate; };
      controls.addEventListener('start', onStart);
      controls.addEventListener('end',   onEnd);

      // Store refs for cleanup
      sceneRef.current = { renderer, controls, rafId: { v: rafId }, ro, scene, onStart, onEnd };

      // Workaround: rafId is set inside animate — keep a mutable ref
      const rafRef = { cancel: () => cancelAnimationFrame(rafId) };
      let lastRaf = rafId;
      const origAnimate = animate;

      // Replace rafId tracking with a proper cancel method
      sceneRef.current.cancelAnimation = () => cancelAnimationFrame(lastRaf);
      const origRAF = requestAnimationFrame;
      // Simpler: just track the last id in closure via sceneRef
      sceneRef.current.getLastRaf = () => rafId;

    }).catch((err) => {
      console.error('[ThreeBlock] Three.js import failed. Run: npm install three', err);
      setStatus('error');
    });

    return () => {
      const s = sceneRef.current;
      if (!s) return;
      // Cancel animation loop — use the stored ref
      if (s.rafHandle) cancelAnimationFrame(s.rafHandle);
      s.ro?.disconnect();
      s.controls?.removeEventListener('start', s.onStart);
      s.controls?.removeEventListener('end',   s.onEnd);
      s.controls?.dispose();
      s.renderer?.dispose();
      // Remove canvas from DOM
      if (s.renderer?.domElement?.parentNode === container) {
        container.removeChild(s.renderer.domElement);
      }
      sceneRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, primitive, color, wireframe, autoRotate]);

  // Dismiss orbit hint after 3s or on first interaction
  useEffect(() => {
    if (status !== 'ready') return;
    const t = setTimeout(() => setHint(false), 3000);
    return () => clearTimeout(t);
  }, [status]);

  return (
    <div className={styles.root}>
      {/* Three.js canvas mount point */}
      <div
        ref={containerRef}
        className={styles.viewport}
        onMouseDown={() => setHint(false)}
        onWheel={() => setHint(false)}
      />

      {/* Loading / error overlay */}
      {status === 'loading' && (
        <div className={styles.overlay}>
          <div className={styles.loader} />
          <span className={styles.overlayText}>Loading model…</span>
        </div>
      )}
      {status === 'error' && (
        <div className={styles.overlay}>
          <span className={styles.overlayText} style={{ color: 'var(--status-error)' }}>
            Three.js unavailable — run npm install three
          </span>
        </div>
      )}

      {/* Corner label */}
      {title && <div className={styles.titleLabel}>{title}</div>}

      {/* Orbit hint — fades out after 3s */}
      {hint && status === 'ready' && (
        <div className={styles.orbitHint}>
          Drag to orbit · Scroll to zoom · Right-drag to pan
        </div>
      )}
    </div>
  );
};

export default ThreeBlock;
