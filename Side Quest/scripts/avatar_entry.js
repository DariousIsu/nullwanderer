/*
 * scripts/avatar_entry.js — browser entry bundled (esbuild → renderer/vendor/avatar_vrm.bundle.js) into an
 * IIFE that exposes window.ZoeAvatarVRM. This is the VRM rendering layer for the avatar (voice-avatar-plan
 * V2 rebuild): three-vrm loads a designed .vrm character and we drive its blendshapes from the TESTED
 * control surface in lib/vrm_state (mood→emotion, amplitude→`aa` mouth, blink) — the same numeric inputs
 * the 2D rig produced. The canvas is WebGL and `captureStream()`-ready for the Meet video track (V3).
 *
 * Rebuild only when this file / vrm_state / avatar_state change:  npm run build:avatar
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const vrmState = require('../lib/vrm_state');

const lerp = (a, b, t) => a + (b - a) * t;

// idle/thinking/talking → a feeling string the adapter understands (host-bridge parity with V2/OpenHuman).
const MOOD_FEELING = { idle: 'warm and content', thinking: 'curious, turning it over', talking: null };

function create(canvas, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, (canvas.width / canvas.height) || 1, 0.1, 20);
  camera.position.set(0, 1.4, 0.85);              // head height, close for a portrait framing

  // soft, flattering lighting (a key + fill + ambient) so the character doesn't read as flat or harsh
  scene.add(new THREE.AmbientLight(0xffffff, 1.05));
  const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(1, 1.6, 1.4); scene.add(key);
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.5); fill.position.set(-1, 1.0, 0.6); scene.add(fill);

  const clock = new THREE.Clock();
  let api;                       // hoisted: the fluent methods below return it (assigned at the end)
  const st = {
    vrm: null, raf: null, analyser: null, buf: null, audioCtx: null,
    mouth: 0, blinkPhase: opts.blinkPhase || 0,
    curEmo: {}, tgtEmo: {}, feeling: 'warm and content', lookUp: 0,
  };
  for (const e of vrmState.VRM_EMOTIONS) { st.curEmo[e] = 0; st.tgtEmo[e] = 0; }

  function setFeeling(feeling) {
    st.feeling = feeling || '';
    const { weights, mood } = vrmState.expressionWeights(st.feeling);
    st.tgtEmo = weights;
    st.lookUpTarget = mood === 'thinking' ? 0.4 : 0;   // a small up-glance while thinking
    return api;
  }
  function setMood(mood) { const f = MOOD_FEELING[mood]; if (f) setFeeling(f); return api; }

  function pushAmplitude(rms) { st.mouth = vrmState.viseme(rms, st.mouth).aa; return api; }

  function attachAudio(source) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      st.audioCtx = st.audioCtx || new Ctx();
      const node = source instanceof MediaStream
        ? st.audioCtx.createMediaStreamSource(source)
        : st.audioCtx.createMediaElementSource(source);
      const analyser = st.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      node.connect(analyser);
      if (!(source instanceof MediaStream)) analyser.connect(st.audioCtx.destination); // hear the element too
      st.analyser = analyser; st.buf = new Uint8Array(analyser.fftSize);
    } catch { /* fail-soft: no audio → mouth idles closed */ }
    return api;
  }

  function _sampleAudio() {
    if (!st.analyser) { if (st.mouth > 0.001) st.mouth = vrmState.viseme(0, st.mouth).aa; return; }
    st.analyser.getByteTimeDomainData(st.buf);
    let sum = 0;
    for (let i = 0; i < st.buf.length; i++) { const v = (st.buf[i] - 128) / 128; sum += v * v; }
    pushAmplitude(Math.sqrt(sum / st.buf.length));
  }

  const loaded = new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(
      opts.vrmUrl,
      (gltf) => {
        const vrm = gltf.userData.vrm;
        try { if (VRMUtils.removeUnnecessaryVertices) VRMUtils.removeUnnecessaryVertices(gltf.scene); } catch {}
        try { if (VRMUtils.combineSkeletons) VRMUtils.combineSkeletons(gltf.scene); } catch {}
        // Face the +Z camera. three-vrm 3.x normalizes VRoid exports (both VRM 0.x and 1.0) to face +Z at
        // yaw 0 — PROVEN with the real Zoe.vrm (a VRM 1.0 export faced the camera at rotation.y 0, and PI
        // showed her back). opts.faceYaw overrides for any model that ships facing the other way.
        vrm.scene.rotation.y = (typeof opts.faceYaw === 'number') ? opts.faceYaw : 0;
        scene.add(vrm.scene);
        // frame the camera on the head bone so it's a portrait, whatever the model's proportions
        try {
          const head = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode('head');
          if (head) { const p = new THREE.Vector3(); head.getWorldPosition(p); camera.position.set(0, p.y, 0.7); camera.lookAt(0, p.y, 0); }
        } catch {}
        st.vrm = vrm;
        resolve(api);
      },
      undefined,
      (err) => reject(err),
    );
  });

  function draw() {
    const dt = clock.getDelta();
    const now = performance.now();
    _sampleAudio();
    if (st.vrm && st.vrm.expressionManager) {
      const em = st.vrm.expressionManager;
      for (const e of vrmState.VRM_EMOTIONS) {
        st.curEmo[e] = lerp(st.curEmo[e], st.tgtEmo[e] || 0, 0.12);
        try { em.setValue(e, st.curEmo[e]); } catch {}
      }
      st.lookUp = lerp(st.lookUp, st.lookUpTarget || 0, 0.1);
      try { em.setValue('lookUp', st.lookUp); } catch {}
      try { em.setValue('aa', st.mouth); } catch {}
      try { em.setValue('blink', vrmState.blinkWeight(now, { phase: st.blinkPhase })); } catch {}
      try { st.vrm.update(dt); } catch {}
    }
    renderer.render(scene, camera);
  }

  function start() { if (!st.raf) { const loop = () => { draw(); st.raf = requestAnimationFrame(loop); }; st.raf = requestAnimationFrame(loop); } return api; }
  function stop() { if (st.raf) { cancelAnimationFrame(st.raf); st.raf = null; } return api; }
  function renderOnce() { draw(); return api; }
  function captureStream(fps = 30) { return canvas.captureStream(fps); }
  function resize(w, h) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); return api; }

  api = { loaded, setFeeling, setMood, pushAmplitude, attachAudio, start, stop, renderOnce, captureStream, resize, _state: st };
  setFeeling(st.feeling);
  return api;
}

window.ZoeAvatarVRM = { create };
