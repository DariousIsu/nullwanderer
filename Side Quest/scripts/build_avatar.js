/* scripts/build_avatar.js — one-shot esbuild bundle of the VRM avatar renderer (three + @pixiv/three-vrm).
 *
 * Bundles scripts/avatar_entry.js → renderer/vendor/avatar_vrm.bundle.js as a single IIFE that exposes
 * `window.ZoeAvatarVRM`. BUILD-TIME step only: `npm start` is unchanged — the app loads the vendored static
 * file via <script src>, exactly like renderer/vendor/tiptap.bundle.js. Re-run (`npm run build:avatar`)
 * only when scripts/avatar_entry.js or lib/vrm_state.js / lib/avatar_state.js change.
 */
'use strict';
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'renderer', 'vendor', 'avatar_vrm.bundle.js');

esbuild.build({
  entryPoints: [path.join(ROOT, 'scripts', 'avatar_entry.js')],
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
  console.log(`[build_avatar] wrote renderer/vendor/avatar_vrm.bundle.js (${kb} KB)`);
  if (res.warnings && res.warnings.length) console.warn(`[build_avatar] ${res.warnings.length} warning(s)`);
}).catch((e) => { console.error('[build_avatar] failed:', e.message); process.exit(1); });
