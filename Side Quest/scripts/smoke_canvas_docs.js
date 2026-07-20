/* scripts/smoke_canvas_docs.js — offline checks for the durable canvas DOCUMENT store (restart survival).
 * Run with Electron-as-Node (better-sqlite3 native ABI): ELECTRON_RUN_AS_NODE=1 electron <this>. */
'use strict';
process.env.CANVAS_DOCS_DB_PATH = ':memory:';
const S = require('../lib/canvas_docs');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

S.init({ path: ':memory:' });

ok('empty → []', S.all().length === 0);

// A dropped document: tab + one block.
S.recordTab({ tabKey: 'drop-oped', mode: 'DOC', title: 'Op-ed' });
S.recordBlock({ tabKey: 'drop-oped', blockId: 'b1', blockType: 'paragraph', data: { markdown: 'hello' } });
let docs = S.all();
ok('one doc, one block', docs.length === 1 && docs[0].blocks.length === 1 && docs[0].title === 'Op-ed');
ok('block payload round-trips', docs[0].blocks[0].data.markdown === 'hello' && docs[0].blocks[0].blockType === 'paragraph');

// Stream order is preserved (this is what makes a replay read like the original document).
S.recordBlock({ tabKey: 'drop-oped', blockId: 'b2', blockType: 'paragraph', data: { markdown: 'second' } });
S.recordBlock({ tabKey: 'drop-oped', blockId: 'b3', blockType: 'paragraph', data: { markdown: 'third' } });
ok('blocks keep stream order', S.all()[0].blocks.map(b => b.blockId).join(',') === 'b1,b2,b3');

// Live-grow: re-recording a block UPDATES it in place and must not append a duplicate or reorder.
S.recordBlock({ tabKey: 'drop-oped', blockId: 'b2', blockType: 'paragraph', data: { markdown: 'second (grown)' } });
docs = S.all();
ok('upsert does not duplicate', docs[0].blocks.length === 3);
ok('upsert keeps position', docs[0].blocks.map(b => b.blockId).join(',') === 'b1,b2,b3');
ok('upsert takes newest content', docs[0].blocks[1].data.markdown === 'second (grown)');

// Re-opening a tab refreshes the title without disturbing its blocks.
S.recordTab({ tabKey: 'drop-oped', mode: 'DOC', title: 'Op-ed (final)' });
ok('re-open refreshes title, keeps blocks', S.all()[0].title === 'Op-ed (final)' && S.all()[0].blocks.length === 3);

// Guards: a block with no tab or no id is refused, not silently half-stored.
ok('missing ids refused', S.recordBlock({ tabKey: '', blockId: 'x', data: {} }) === false
  && S.recordBlock({ tabKey: 't', blockId: '', data: {} }) === false
  && S.recordTab({ tabKey: '' }) === false);

// Oversize payloads (a huge base64 drop) are declined rather than bloating the store forever.
const huge = { markdown: 'x'.repeat(S.MAX_BLOCK_BYTES + 10) };
ok('oversize block declined', S.recordBlock({ tabKey: 'drop-oped', blockId: 'big', data: huge }) === false);
ok('oversize left no row', S.all()[0].blocks.length === 3);

// Multiple documents, ordered by when they were opened (replay order).
S.recordTab({ tabKey: 'directed-42', mode: 'RESEARCH', title: 'Wyoming' });
S.recordBlock({ tabKey: 'directed-42', blockId: 'sec-42-a', blockType: 'heading', data: { level: 2, text: 'Wyoming' } });
ok('two docs tracked', S.all().length === 2);
ok('mode round-trips', S.all().find(d => d.tabKey === 'directed-42').mode === 'RESEARCH');

// forget() drops a document and its blocks together — no orphans.
ok('forget removes doc', S.forget('drop-oped') === 1 && S.all().length === 1);
ok('forget removed its blocks', S.all()[0].blocks.length === 1);

// prune keeps the most recently touched documents.
for (let i = 0; i < 5; i++) {
  S.recordTab({ tabKey: `t${i}`, mode: 'DOC', title: `doc ${i}` });
  S.recordBlock({ tabKey: `t${i}`, blockId: `t${i}-b`, data: { markdown: String(i) } });
}
ok('prune keeps N most recent', S.prune({ keep: 2 }) === 4 && S.all().length === 2);

ok('clear all', S.clear() >= 1 && S.all().length === 0);

S.close();
// Result line in the dialect scripts/run_smokes.js parses — without this the suite runs but registers as
// "crashed?" and is effectively outside the gate.
console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
