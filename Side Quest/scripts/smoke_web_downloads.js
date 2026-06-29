/* scripts/smoke_web_downloads.js — offline checks for web.js downloadDest (collision-safe naming).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_web_downloads.js */
'use strict';
const path = require('path');
const W = require('../lib/web');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

const dir = path.join('C:', 'tmp', 'dl');
const none = () => false;
const taken = (...ps) => { const s = new Set(ps); return (p) => s.has(p); };

ok('plain name, no collision', W.downloadDest(dir, 'report.pdf', none) === path.join(dir, 'report.pdf'));
ok('sanitizes illegal chars', W.downloadDest(dir, 'a/b:c*?.pdf', none) === path.join(dir, 'a_b_c__.pdf'));
ok('collision → (1)', W.downloadDest(dir, 'report.pdf', taken(path.join(dir, 'report.pdf'))) === path.join(dir, 'report (1).pdf'));
ok('collision → (2)', W.downloadDest(dir, 'report.pdf', taken(path.join(dir, 'report.pdf'), path.join(dir, 'report (1).pdf'))) === path.join(dir, 'report (2).pdf'));
ok('extensionless collision', W.downloadDest(dir, 'data', taken(path.join(dir, 'data'))) === path.join(dir, 'data (1)'));
ok('preserves multi-dot ext', W.downloadDest(dir, 'a.tar.gz', none) === path.join(dir, 'a.tar.gz'));
const empty = W.downloadDest(dir, '', none);
ok('empty name → fallback under dir', empty.startsWith(path.join(dir, 'download-')));
ok('DOWNLOADS_DIR is exported + under data', typeof W.DOWNLOADS_DIR === 'string' && /downloads$/.test(W.DOWNLOADS_DIR));

console.log(`\nsmoke_web_downloads: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
