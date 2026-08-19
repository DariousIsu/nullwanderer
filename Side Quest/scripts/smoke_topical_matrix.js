/* smoke_topical_matrix.js — the bounded multi-target coverage matrix (2026-08-19).
 *
 * Proves rs.topicalMatrix flattens (target × aspect) into composite facets so the topical facet-walk
 * covers every aspect FOR every named target — the cure for the anti-china-2026 hollow deliverable
 * (7 states enumerated, dropped, ~4 shallow national passes, then "it's done"). Target-outer so each
 * target's sections land together. Pure — no DB, no model, no network.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_topical_matrix.js
 */
'use strict';
const rs = require('../lib/research');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };

const states = ['Utah', 'Arizona', 'Texas'];
const aspects = ['Legislative activity 2026', 'Current holdings', 'Sponsors'];
const m = rs.topicalMatrix(states, aspects);

ok('matrix size = targets × aspects', m.length === 9);
ok('target-outer: the first three units are all Utah', m.slice(0, 3).every((u) => u.startsWith('Utah — ')));
ok('composite facet names the target AND the aspect', m[0] === 'Utah — Legislative activity 2026');
ok('every unit is "target — aspect"', m.every((u) => /^.+ — .+$/.test(u)));
ok('every target appears aspects-many times', states.every((s) => m.filter((u) => u.startsWith(s + ' — ')).length === aspects.length));
ok('every aspect appears targets-many times', aspects.every((a) => m.filter((u) => u.endsWith('— ' + a)).length === states.length));

// the whole point: a matrix run only "completes" when every unit is covered (the facet-walk terminus)
const nextUncovered = (covered) => m.find((u) => !covered.some((c) => c.toLowerCase() === u.toLowerCase()));
ok('with 0 covered, work remains', !!nextUncovered([]));
ok('with all covered, the run is done (no next unit)', !nextUncovered(m.slice()));
ok('one national pass no longer satisfies a multi-state review', nextUncovered(['Chinese-owned land holdings']) != null);

// degenerate inputs never throw and never fabricate units
ok('empty targets -> empty matrix', rs.topicalMatrix([], aspects).length === 0);
ok('empty aspects -> empty matrix', rs.topicalMatrix(states, []).length === 0);
ok('blank / null entries are dropped, not carried as units', rs.topicalMatrix(['Utah', '', '  '], ['Bills', null]).length === 1);

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
