/* scripts/build_editor.js — one-shot esbuild bundle of the Creator's editor (Tiptap/ProseMirror).
 *
 * Bundles scripts/tiptap_entry.js → renderer/vendor/tiptap.bundle.js as a single IIFE that
 * exposes `window.ZoeEditor`. This is a BUILD-TIME step only: `npm start` (electron .) is
 * unchanged — the app just loads the resulting vendored static file via <script src>, exactly
 * like renderer/vendor/force-graph.min.js. Re-run (`npm run build:editor`) only when the
 * editor's extension set in tiptap_entry.js changes.
 */
'use strict';
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'renderer', 'vendor', 'tiptap.bundle.js');

esbuild.build({
  entryPoints: [path.join(ROOT, 'scripts', 'tiptap_entry.js')],
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
  console.log(`[build_editor] wrote renderer/vendor/tiptap.bundle.js (${kb} KB)`);
  if (res.warnings && res.warnings.length) console.warn(`[build_editor] ${res.warnings.length} warning(s)`);
}).catch((e) => {
  console.error('[build_editor] FAILED:', e.message || e);
  process.exit(1);
});
