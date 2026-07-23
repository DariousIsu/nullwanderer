/* scripts/kg3d_entry.js — esbuild entry for the 3D Knowledge Graph renderer.
 *
 * Bundles three + 3d-force-graph (+ the UnrealBloom postprocessing pass) into a single IIFE exposed on
 * window, loaded via <script src="vendor/kg3d.bundle.js"> exactly like vendor/avatar_vrm.bundle.js. All three
 * consumers share ONE bundled `three` instance (esbuild dedupes), so postprocessing and the graph agree on
 * types. Re-run `npm run build:kg3d` when this entry changes. The 2D path (vendor/force-graph.min.js) is
 * untouched — this is the parallel 3D surface.
 */
// VRM SKIN (Lucas, 2026-07-22: "I wonder if we could replace the 'skin' of the avatar model with the node and
// connections overlay"). The loader has to live in THIS bundle, not the avatar's. Loading
// vendor/avatar_vrm.bundle.js alongside would put a SECOND three.js in the page, and two three instances
// cannot share a scene graph — the classes are different identities even at identical versions. Importing it
// here means esbuild dedupes `three` across both, so the model and the graph are objects in one world.
import * as THREE from 'three';
import ForceGraph3D from '3d-force-graph';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

window.THREE = THREE;
window.ForceGraph3D = ForceGraph3D;
window.UnrealBloomPass = UnrealBloomPass;
window.GLTFLoader = GLTFLoader;
window.VRMLoaderPlugin = VRMLoaderPlugin;
window.VRMUtils = VRMUtils;
