/* scripts/smoke_creator_proofread.js — offline checks for the proofread leaf (no model call).
 * Proves the prompt builds and, crucially, the parser's hallucination guard + validation.
 * Run: node scripts/smoke_creator_proofread.js */
'use strict';
const P = require('../studio/creator_proofread');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

const blocks = [
  { anchor: 'a0', type: 'heading', text: 'A Breif Introduction' },
  { anchor: 'a1', type: 'paragraph', text: 'The data clearly shows that turnout were higher.' },
  { anchor: 'a2', type: 'code', text: 'const teh = 1;' },   // code: not proofread
];

// buildMessages
const msgs = P.buildMessages(blocks);
ok('two messages (system+user)', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user');
ok('user lists prose anchors', msgs[1].content.includes('[a0]') && msgs[1].content.includes('[a1]'));
ok('code block excluded from prompt', !msgs[1].content.includes('[a2]'));

const byAnchor = P.anchorTextMap(blocks);
ok('anchorTextMap covers prose only', byAnchor.a0 && byAnchor.a1 && !byAnchor.a2);

// parseCorrections — a realistic model reply mixing good + hallucinated + no-op items
const reply = `Here are the issues:
[
  {"anchor":"a0","type":"spelling","original":"Breif","suggestion":"Brief","message":"misspelling"},
  {"anchor":"a1","type":"grammar","original":"turnout were","suggestion":"turnout was","message":"subject-verb agreement"},
  {"anchor":"a1","type":"style","original":"clearly","suggestion":"clearly","message":"no-op should drop"},
  {"anchor":"a1","type":"grammar","original":"NONEXISTENT SPAN","suggestion":"x","message":"hallucinated"},
  {"anchor":"a9","type":"spelling","original":"foo","suggestion":"bar","message":"unknown anchor"}
]`;
const corr = P.parseCorrections(reply, byAnchor);
ok('keeps the two valid corrections', corr.length === 2);
ok('spelling correction parsed', corr.some(c => c.type === 'spelling' && c.original === 'Breif' && c.suggestion === 'Brief'));
ok('grammar correction parsed', corr.some(c => c.type === 'grammar' && c.original === 'turnout were'));
ok('drops no-op (original===suggestion)', !corr.some(c => c.original === 'clearly'));
ok('GUARD drops hallucinated span not in text', !corr.some(c => c.original === 'NONEXISTENT SPAN'));
ok('drops unknown anchor', !corr.some(c => c.anchor === 'a9'));
ok('every kept correction is a real substring', corr.every(c => byAnchor[c.anchor].includes(c.original)));
ok('ids unique', new Set(corr.map(c => c.id)).size === corr.length);

// robustness: junk / empty
ok('non-JSON reply → []', P.parseCorrections('I could not find any issues.', byAnchor).length === 0);
ok('empty array reply → []', P.parseCorrections('[]', byAnchor).length === 0);
ok('unknown type defaults to grammar', P.parseCorrections('[{"anchor":"a0","type":"weird","original":"Breif","suggestion":"Brief"}]', byAnchor)[0].type === 'grammar');

console.log(`\nsmoke_creator_proofread: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
