/* scripts/build_mermaid.js — one-shot esbuild bundle of Mermaid for the canvas diagram block.
 *
 * Bundles scripts/mermaid_entry.js → renderer/vendor/mermaid.bundle.js as a single IIFE that exposes
 * `window.mermaid`. Build-time only: `npm start` is unchanged — the canvas loads the vendored static
 * file via <script src>, exactly like renderer/vendor/tiptap.bundle.js. Re-run when mermaid is upgraded.
 */
'use strict';
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'renderer', 'vendor', 'mermaid.bundle.js');

esbuild.build({
  entryPoints: [path.join(ROOT, 'scripts', 'mermaid_entry.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  outfile: OUT,
  legalComments: 'none',
  minify: true,
  sourcemap: false,
}).then((res) => {
  const fs = require('fs');
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`[build_mermaid] wrote renderer/vendor/mermaid.bundle.js (${kb} KB)`);
  if (res.warnings && res.warnings.length) console.warn(`[build_mermaid] ${res.warnings.length} warning(s)`);
}).catch((e) => {
  console.error('[build_mermaid] FAILED:', e.message || e);
  process.exit(1);
});
