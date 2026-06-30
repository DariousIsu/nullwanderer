/* scripts/smoke_canvas_layout.js — offline checks for the freeform board layout math (pure node). */
'use strict';
const L = require('../studio/canvas_layout');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

const D = L.DEFAULTS;

// ---- auto placement: deterministic grid, column-cascade ----
const p = L.autoPlace(['a', 'b', 'c', 'd'], {}, { perCol: 3 });
ok('first auto at origin', p[0].x === D.originX && p[0].y === D.originY && p[0].source === 'auto');
ok('second auto drops a row', p[1].x === D.originX && p[1].y === D.originY + (D.cardH + D.gapY));
ok('fourth auto wraps to next column', p[3].x === D.originX + (D.cardW + D.gapX) && p[3].y === D.originY);
ok('order preserved', p.map(x => x.blockId).join('') === 'abcd');

// ---- saved positions win + are clamped to non-negative ints ----
const p2 = L.autoPlace(['a', 'b'], { a: { x: 500, y: 300 }, b: { x: -20, y: 12.6 } }, {});
ok('saved coord used', p2[0].x === 500 && p2[0].y === 300 && p2[0].source === 'saved');
ok('saved negative clamped to 0', p2[1].x === 0 && p2[1].source === 'saved');
ok('saved float rounded', p2[1].y === 13);

// ---- mixed: saved blocks do NOT consume an auto slot ----
const p3 = L.autoPlace(['x', 'y', 'z'], { y: { x: 999, y: 999 } }, { perCol: 3 });
ok('auto index skips saved block', p3[0].x === D.originX && p3[0].y === D.originY && p3[2].y === D.originY + (D.cardH + D.gapY));
ok('saved middle kept', p3[1].x === 999 && p3[1].source === 'saved');

// ---- partial/garbage saved entry falls back to auto ----
ok('garbage saved → auto', L.autoPlace(['a'], { a: { x: 'nope' } }, {})[0].source === 'auto');

// ---- board extent encloses all cards + margin ----
const ext = L.boardExtent([{ x: 500, y: 300 }], {});
ok('extent encloses card + origin margin', ext.width === 500 + D.cardW + D.originX && ext.height === 300 + D.cardH + D.originY);
ok('empty extent is non-negative', L.boardExtent([], {}).width === D.originX);

// ---- clampN ----
ok('clampN basics', L.clampN(-5) === 0 && L.clampN(10.4) === 10 && L.clampN('x') === 0);

console.log(`\nsmoke_canvas_layout: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
