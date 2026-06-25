/* scripts/smoke_creator.js — offline round-trip proof for studio/creator_view.js.
 *
 * Proves the foundation guarantee for Slice 1: a document survives the editor round-trip.
 *   (A) blocks → doc → blocks  preserves every block's canonical fields (type/text/level/lang/marker)
 *   (B) doc → blocks → doc      preserves the ProseMirror structure (node types + text)
 *   (C) inline marks (bold/italic/code) are carried verbatim (no markdown re-parse drift)
 *   (D) empty-doc + empty working-copy edge cases don't throw
 * No Electron, no DB, no models. Run: node scripts/smoke_creator.js
 */
'use strict';
const V = require('../studio/creator_view');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + name); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b)); }

// canonical projection of a block (the fields the rest of the suite reads)
function proj(b) { return { type: b.type, text: b.text || '', level: b.level || null, lang: b.lang || null, marker: b.marker || null }; }
// structural projection of a PM doc (node type + plain text, recursively)
function structOf(node) {
  const t = node.type;
  if (t === 'text' || t === 'hardBreak') return null;
  const kids = (node.content || []).map(structOf).filter(Boolean);
  return { type: t, text: V.nodeText(node), kids };
}

// ---- fixtures ----
const bold = { type: 'text', marks: [{ type: 'bold' }], text: 'bold' };
const ital = { type: 'text', marks: [{ type: 'italic' }], text: 'italic' };
const codem = { type: 'text', marks: [{ type: 'code' }], text: 'x=1' };

const doc = {
  type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title ' }, bold] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Section' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'A para with ' }, ital, { type: 'text', text: ' and ' }, codem, { type: 'text', text: '.' }] },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second ' }, bold] }] },
    ] },
    { type: 'orderedList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
    ] },
    { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'const a = 1;\nconst b = 2;' }] },
    { type: 'codeBlock', attrs: { language: '__table__' }, content: [{ type: 'text', text: '| a | b |\n|---|---|\n| 1 | 2 |' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'tail.' }] },
  ],
};

// ---- (B)+(C) doc → blocks → doc ----
const blocks = V.docToBlocks(doc);
ok('docToBlocks: anchors assigned', blocks.every((b, i) => b.anchor === 'a' + i));
ok('docToBlocks: hashes assigned', blocks.every(b => typeof b.hash === 'string' && b.hash.length === 8));
ok('table preserved as table type', blocks.some(b => b.type === 'table' && /\| a \| b \|/.test(b.text)));
ok('code lang preserved', blocks.some(b => b.type === 'code' && b.lang === 'js'));
ok('list items flattened with markers', blocks.filter(b => b.type === 'list_item').length === 4);

const doc2 = V.blocksToDoc(blocks);
eq('(B) doc → blocks → doc: structure identical', structOf(doc), structOf(doc2));
// inline marks carried verbatim: the italic+code para must reproduce its exact inline array
const para1 = doc.content[2], para2 = doc2.content[2];
eq('(C) inline marks carried verbatim', para1.content, para2.content);
// ordered vs bullet preserved (not collapsed into one list)
ok('(B) bullet then ordered stay separate', doc2.content[3].type === 'bulletList' && doc2.content[4].type === 'orderedList');

// ---- (A) blocks → doc → blocks ----
const back = V.docToBlocks(V.blocksToDoc(blocks));
eq('(A) blocks → doc → blocks: canonical fields identical', blocks.map(proj), back.map(proj));

// ---- (D) edge cases ----
const emptyDoc = V.blocksToDoc([]);
ok('(D) empty blocks → doc has one paragraph', emptyDoc.content.length === 1 && emptyDoc.content[0].type === 'paragraph');
ok('(D) empty doc → blocks does not throw', Array.isArray(V.docToBlocks({ type: 'doc', content: [] })));
const wc = V.emptyWorkingCopy('My Draft');
ok('(D) emptyWorkingCopy shape', wc.title === 'My Draft' && wc.blocks.length === 1 && wc.format === 'native');
// a paragraph-only doc with no marks still round-trips
const plain = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }] };
eq('(D) plain paragraph round-trips', structOf(plain), structOf(V.blocksToDoc(V.docToBlocks(plain))));

console.log(`\nsmoke_creator: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
