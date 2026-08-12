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
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

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
    mixer: null, clips: {}, action: null,   // full-body clip layer (VRMA driven by an AnimationMixer)
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
        // Relax the default T-pose into arms-at-sides (A-pose) so full-body framing looks natural, not stiff.
        // Set once on the normalized humanoid bones; vrm.update() propagates it to the skeleton each frame.
        try {
          const setBone = (name, z, x) => { const b = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode(name); if (b) b.rotation.set(x || 0, 0, z); };
          setBone('leftUpperArm', -1.25); setBone('rightUpperArm', 1.25);   // bring arms down to the sides
          setBone('leftLowerArm', -0.15); setBone('rightLowerArm', 0.15);   // a touch of elbow bend
        } catch {}
        scene.add(vrm.scene);
        // frame the camera: 'portrait' = head-and-shoulders (default), 'full' = whole body from her
        // bounding box (fit the full height with a little margin). opts.framing chooses.
        try {
          const framing = opts.framing || 'portrait';
          const head = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode('head');
          let hy = 1.35; if (head) { const p = new THREE.Vector3(); head.getWorldPosition(p); hy = p.y; }
          if (framing === 'full') {
            const box = new THREE.Box3().setFromObject(vrm.scene);
            const size = new THREE.Vector3(); box.getSize(size);
            const center = new THREE.Vector3(); box.getCenter(center);
            const fov = camera.fov * Math.PI / 180;
            const dist = (size.y / 2) / Math.tan(fov / 2) * 1.12 + size.z;
            camera.position.set(0, center.y, dist);
            camera.lookAt(0, center.y, 0);
          } else if (framing === 'bust') {
            // head + shoulders + upper chest. The head BONE sits at the neck, so top-of-head is ~+0.14 above
            // it — aim just below the bone and pull back enough to keep the whole head in frame.
            const targetY = hy - 0.05;
            camera.position.set(0, targetY + 0.02, 1.05);
            camera.lookAt(0, targetY, 0);
          } else {
            // portrait — tight head-and-shoulders
            camera.position.set(0, hy, 0.7);
            camera.lookAt(0, hy, 0);
          }
        } catch {}
        st.vrm = vrm;
        st.mixer = new THREE.AnimationMixer(vrm.scene);   // body clips run here, layered UNDER the face/mouth/blink
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
      if (st.mixer) { try { st.mixer.update(dt); } catch {} }   // body clip writes bone rotations BEFORE vrm.update normalizes them
      try { st.vrm.update(dt); } catch {}
    }
    renderer.render(scene, camera);
  }

  function start() { if (!st.raf) { const loop = () => { draw(); st.raf = requestAnimationFrame(loop); }; st.raf = requestAnimationFrame(loop); } return api; }
  function stop() { if (st.raf) { cancelAnimationFrame(st.raf); st.raf = null; } return api; }
  function renderOnce() { draw(); return api; }
  function captureStream(fps = 30) { return canvas.captureStream(fps); }
  function resize(w, h) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); return api; }

  // FULL-BODY CLIPS. A .vrma retargets to this vrm's humanoid by bone name; the mixer crossfades between clips.
  // The clip is the BASE BODY layer — the face/mouth/blink expressions in draw() ride on top of it.
  const _vrmaLoader = () => { const l = new GLTFLoader(); l.register((p) => new VRMAnimationLoaderPlugin(p)); return l; };
  async function loadClip(name, url, o = {}) {
    await loaded;
    const gltf = await _vrmaLoader().loadAsync(url);
    const va = gltf.userData.vrmAnimations && gltf.userData.vrmAnimations[0];
    if (!va) throw new Error('no VRM animation in ' + url);
    const clip = createVRMAnimationClip(va, st.vrm); clip.name = name;
    st.clips[name] = clip;
    if (o.play) play(name, o);
    return api;
  }
  function play(name, o = {}) {
    const clip = st.clips[name]; if (!clip || !st.mixer) return api;
    const next = st.mixer.clipAction(clip);
    next.loop = (o.loop === false) ? THREE.LoopOnce : THREE.LoopRepeat;
    next.clampWhenFinished = true;
    const fade = (o.fade != null) ? o.fade : 0.4;
    next.reset().setEffectiveWeight(1).play();
    if (st.action && st.action !== next) st.action.crossFadeTo(next, fade, false);
    else next.fadeIn(fade);
    st.action = next;
    return api;
  }
  api = { loaded, setFeeling, setMood, pushAmplitude, attachAudio, loadClip, play, start, stop, renderOnce, captureStream, resize, _state: st };
  setFeeling(st.feeling);
  return api;
}

window.ZoeAvatarVRM = { create };
