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

S.close();
console.log(`\nsmoke_canvas_layout_db: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
