'use strict';
/* Smoke: lib/canvas_split — parse a "split into two docs" instruction + partition the source blocks.
 * Pure logic, no I/O. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_canvas_split.js
 */
const S = require('../lib/canvas_split');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- parseSplitInstruction: the live miss + variants ---
const live = S.parseSplitInstruction('Do me a favor, split this into two seperate documents, one for Yvonne and on for Applied Digital');
ok(live.isSplit && live.labels[0] === 'Yvonne' && live.labels[1] === 'Applied Digital', `the live miss parses → [${live.labels.join(', ')}] (typo "on for" tolerated)`);

const v2 = S.parseSplitInstruction('split this into two documents, one for the finances and one for the leadership');
ok(v2.isSplit && v2.labels[0].toLowerCase() === 'the finances' && v2.labels[1].toLowerCase() === 'the leadership', 'clean "one for A and one for B"');

const v3 = S.parseSplitInstruction('break this up into two docs, one for Polaris 1, one for Polaris 2');
ok(v3.isSplit && /polaris 1/i.test(v3.labels[0]) && /polaris 2/i.test(v3.labels[1]), 'comma form "one for A, one for B"');

const v4 = S.parseSplitInstruction('separate this into Yvonne Murray and Applied Digital');
ok(v4.isSplit && /yvonne murray/i.test(v4.labels[0]) && /applied digital/i.test(v4.labels[1]), '"into A and B" form');

// --- NOT a split ---
ok(!S.parseSplitInstruction('add a section on the financials').isSplit, 'a plain edit is NOT a split');
ok(!S.parseSplitInstruction('research Applied Digital and Yvonne Murray').isSplit, 'a research ask with "and" is NOT a split (no split verb)');
ok(!S.parseSplitInstruction('split this document').isSplit, 'split with no resolvable pair → not actionable');
ok(!S.parseSplitInstruction('').isSplit && !S.parseSplitInstruction(null).isSplit, 'empty/null → not a split');

// --- planSplit: lossless partition via an injected assigner ---
const blocks = [
  { block_id: 'sec-a-yvonne-murray', data: '## Yvonne Murray\nbio' },
  { block_id: 'sec-a-applied-digital', data: '## Applied Digital\norg' },
  { block_id: 'sec-a-southern-power', data: '## Southern Power\nutility' },
  { block_id: 'todo-a', data: '## Progress' },
];
// assigner: bucket 1 (Applied Digital) unless the block mentions the first label's subject (Yvonne)
const assign = (b, labels) => /yvonne/i.test(String(b.data || '')) ? 0 : 1;
const docs = S.planSplit({ sourceFocusId: 3792, sourceBlocks: blocks, labels: ['Yvonne', 'Applied Digital'], assign });
ok(docs.length === 2, 'planSplit → two docs');
ok(docs[0].tabKey === 'directed-3792-yvonne' && docs[1].tabKey === 'directed-3792-applied-digital', 'tabKeys namespaced under the source focus');
ok(docs[0].title === 'Yvonne' && docs[1].title === 'Applied Digital', 'titles are the labels');
ok(docs[0].blocks.length === 1 && docs[0].blocks[0].block_id === 'sec-a-yvonne-murray', 'the Yvonne section routed to doc 0');
ok(docs[1].blocks.length === 3, 'the rest routed to doc 1 (Applied Digital)');
const total = docs.reduce((n, d) => n + d.blocks.length, 0);
ok(total === blocks.length, `LOSSLESS: every source block landed (${total}/${blocks.length})`);
// a throwing assigner defaults to bucket 0, never drops
const docs2 = S.planSplit({ sourceFocusId: 'x', sourceBlocks: [{ block_id: 'b1' }], labels: ['A', 'B'], assign: () => { throw new Error('boom'); } });
ok(docs2[0].blocks.length === 1, 'a throwing assigner → bucket 0 (block never dropped)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
