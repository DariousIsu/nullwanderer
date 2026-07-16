/* scripts/kg3d_entry.js — esbuild entry for the 3D Knowledge Graph renderer.
 *
 * Bundles three + 3d-force-graph (+ the UnrealBloom postprocessing pass) into a single IIFE exposed on
 * window, loaded via <script src="vendor/kg3d.bundle.js"> exactly like vendor/avatar_vrm.bundle.js. All three
 * consumers share ONE bundled `three` instance (esbuild dedupes), so postprocessing and the graph agree on
 * types. Re-run `npm run build:kg3d` when this entry changes. The 2D path (vendor/force-graph.min.js) is
 * untouched — this is the parallel 3D surface.
 */
import * as THREE from 'three';
import ForceGraph3D from '3d-force-graph';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

window.THREE = THREE;
window.ForceGraph3D = ForceGraph3D;
window.UnrealBloomPass = UnrealBloomPass;
