/* scripts/smoke_creator_stats.js — offline checks for studio/creator_stats.computeStats.
 * Run: node scripts/smoke_creator_stats.js */
'use strict';
const { computeStats } = require('../studio/creator_stats');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

const blocks = [
  { type: 'heading', text: 'The Title' },
  { type: 'paragraph', text: 'First sentence here. Second one too! A third?' },
  { type: 'paragraph', text: 'Another paragraph with five words.' },
  { type: 'list_item', text: 'one two three' },
  { type: 'list_item', text: 'four five' },
  { type: 'code', text: 'const a = 1;\nconst b = 2;' },
  { type: 'table', text: '| a | b |' },
];
const s = computeStats(blocks);

ok('paragraphs counted', s.paragraphs === 2);
ok('headings counted', s.headings === 1);
ok('list items counted', s.listItems === 2);
ok('code/table excluded as codeBlocks', s.codeBlocks === 2);
// words: heading 2 + p1 8 ("First sentence here. Second one too! A third?") + p2 5 + li 3 + li 2 = 20
ok('prose words (code/table excluded)', s.words === 20);
// sentences: heading 1 + p1 3 + p2 1 + li 1 + li 1 = 7
ok('sentences across prose', s.sentences === 7);
ok('reading time rounds to ≥1 when words>0', s.readingMin === 1);
ok('chars only prose (no code/table chars)', s.chars > 0 && s.chars < 200);

// edge: empty
const e = computeStats([]);
ok('empty doc → all zero', e.words === 0 && e.sentences === 0 && e.paragraphs === 0 && e.readingMin === 0);
// edge: only code
const c = computeStats([{ type: 'code', text: 'x=1' }]);
ok('code-only → 0 prose words, 1 codeBlock', c.words === 0 && c.codeBlocks === 1);
// edge: non-array
ok('non-array safe', computeStats(null).words === 0);

console.log(`\nsmoke_creator_stats: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
