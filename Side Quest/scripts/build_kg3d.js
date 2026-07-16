/* scripts/build_kg3d.js — one-shot esbuild bundle of the 3D KG renderer deps (three + 3d-force-graph +
 * UnrealBloom). Bundles scripts/kg3d_entry.js → renderer/vendor/kg3d.bundle.js as a single IIFE exposing
 * window.THREE / window.ForceGraph3D / window.UnrealBloomPass. BUILD-TIME only: `npm start` is unchanged —
 * the surface loads the vendored file via <script src>, like vendor/avatar_vrm.bundle.js. Re-run
 * (`npm run build:kg3d`) only when scripts/kg3d_entry.js changes.
 */
'use strict';
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'renderer', 'vendor', 'kg3d.bundle.js');

esbuild.build({
  entryPoints: [path.join(ROOT, 'scripts', 'kg3d_entry.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],          // Electron 42 renderer is recent Chromium
  outfile: OUT,
  legalComments: 'none',
  minify: true,
  sourcemap: false,
}).then((res) => {
  const fs = require('fs');
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`[build_kg3d] wrote renderer/vendor/kg3d.bundle.js (${kb} KB)`);
  if (res.warnings && res.warnings.length) console.warn(`[build_kg3d] ${res.warnings.length} warning(s)`);
}).catch((e) => { console.error('[build_kg3d] failed:', e.message); process.exit(1); });
