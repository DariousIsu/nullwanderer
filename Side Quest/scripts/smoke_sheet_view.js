/* scripts/smoke_sheet_view.js — offline checks for the spreadsheet shaper (pure node). */
'use strict';
const S = require('../studio/sheet_view');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

// ---- parseDelimited ----
let r = S.parseDelimited('a,b,c\n1,2,3');
ok('basic rows/cols', r.length === 2 && r[0].join('|') === 'a|b|c' && r[1][2] === '3');
r = S.parseDelimited('name,note\n"Smith, J","says ""hi"""');
ok('quoted comma kept', r[1][0] === 'Smith, J');
ok('escaped quote kept', r[1][1] === 'says "hi"');
r = S.parseDelimited('a,b\r\n1,2\r\n');
ok('CRLF handled, no trailing empty row', r.length === 2 && r[1][1] === '2');
ok('tab delimiter', S.parseDelimited('a\tb\n1\t2', '\t')[1][0] === '1');

// ---- toTable ----
const t = S.toTable([['H1', 'H2'], ['a', 'b'], ['c', 'd']]);
ok('header + body split', t.headers.join('|') === 'H1|H2' && t.rows.length === 2 && t.rows[1][1] === 'd');
ok('blank rows dropped', S.toTable([['x'], ['', ''], ['y']]).rows[0][0] === 'y');
const wide = S.toTable([Array.from({ length: 50 }, (_, i) => 'c' + i), Array.from({ length: 50 }, (_, i) => i)], { maxCols: 40 });
ok('cols capped', wide.headers.length === 40 && wide.rows[0].length === 40);
const tall = S.toTable([['H'], ...Array.from({ length: 600 }, () => ['x'])], { maxRows: 500 });
ok('rows capped + truncated count', tall.rows.length === 500 && tall.truncated === 100);
ok('short rows padded to header width', S.toTable([['A', 'B', 'C'], ['1']]).rows[0].length === 3);

// ---- csvToTable convenience ----
ok('csvToTable end-to-end', S.csvToTable('x,y\n1,2').rows[0][1] === '2');
ok('numbers stringified', typeof S.toTable([['n'], [5]]).rows[0][0] === 'string');

console.log(`\nsmoke_sheet_view: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
