/* scripts/smoke_canvas_layout_db.js — offline checks for the freeform DOCUMENT layout-state store.
 * Run with Electron-as-Node (better-sqlite3 native ABI): ELECTRON_RUN_AS_NODE=1 electron <this>. */
'use strict';
process.env.CANVAS_LAYOUT_DB_PATH = ':memory:';
const S = require('../lib/canvas_layout');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

S.init({ path: ':memory:' });

ok('empty → {}', Object.keys(S.getPositions()).length === 0);

S.setPosition('doc-a', 120, 240);
let pos = S.getPositions();
ok('position set', pos['doc-a'].x === 120 && pos['doc-a'].y === 240 && pos['doc-a'].hidden === false);

S.setPosition('doc-a', -30, 12.7);   // x,y may be negative (free placement) + rounded
ok('negative x kept, y rounded', S.get('doc-a').x === -30 && S.get('doc-a').y === 13);

S.update('doc-a', { w: 500, h: 50 });   // size merges; w/h clamped to minimums
const a = S.get('doc-a');
ok('size merges, h clamped to min', a.w === 500 && a.h === S.MIN_H && a.x === -30);

S.update('doc-a', { minimized: true });
ok('minimized flag, position preserved', S.get('doc-a').minimized === true && S.get('doc-a').x === -30 && S.get('doc-a').w === 500);

S.update('doc-b', { hidden: true });
ok('hidden-only doc has null position', S.get('doc-b').hidden === true && S.get('doc-b').x === null);

let threw = false; try { S.update('', { x: 1 }); } catch { threw = true; }
ok('missing docKey throws', threw);

ok('clear one', S.clear('doc-a') === 1 && !S.get('doc-a') && S.get('doc-b'));
ok('clear all', S.clear() === 1 && Object.keys(S.getPositions()).length === 0);

// --- clearMissing: sweep ghost rows for documents that no longer exist ---
// Every document ever placed left a row here forever, including ephemeral ones the engine lost on each
// restart, so the table accumulated hundreds of entries for tabs nothing can show again.
S.setPosition('live-1', 10, 10);
S.setPosition('live-2', 20, 20);
S.setPosition('ghost-1', 30, 30);
S.setPosition('ghost-2', 40, 40);
ok('clearMissing sweeps only the ghosts', S.clearMissing(['live-1', 'live-2']) === 2);
ok('clearMissing kept the live rows intact', S.get('live-1').x === 10 && S.get('live-2').x === 20 && !S.get('ghost-1') && !S.get('ghost-2'));
ok('clearMissing is idempotent', S.clearMissing(['live-1', 'live-2']) === 0);
// A caller that FAILED to enumerate documents must not be able to wipe the operator's arrangement.
ok('empty live-set is refused (no wipe on a failed lookup)', S.clearMissing([]) === 0 && Object.keys(S.getPositions()).length === 2);
ok('non-array is refused', S.clearMissing(null) === 0 && Object.keys(S.getPositions()).length === 2);
S.clear();

S.close();
console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
