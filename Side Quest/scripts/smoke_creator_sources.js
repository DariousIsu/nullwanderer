/* scripts/smoke_creator_sources.js — offline checks for the source-flagging analyzer (no engine).
 * Run: node scripts/smoke_creator_sources.js */
'use strict';
const S = require('../studio/creator_sources');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

const blocks = [
  { anchor: 'a0', type: 'heading', text: 'Findings' },                                   // heading: excluded
  { anchor: 'a1', type: 'paragraph', text: 'Turnout rose to 53% in 2018.' },             // numeric signal
  { anchor: 'a2', type: 'paragraph', text: 'The chair said "we will not yield" today.' },// quote signal
  { anchor: 'a3', type: 'paragraph', text: 'The policy was broadly unpopular.' },         // bare, no number → drop
  { anchor: 'a5', type: 'paragraph', text: 'The bill passed in 2014.' },                  // bare WITH a year → keep
  { anchor: 'a4', type: 'code', text: 'x = 1' },                                          // code: excluded
];

const claims = S.extractClaims(blocks);
ok('keeps signal-bearing + number-bearing claims (stat, quote, year-claim)', claims.length === 3);
ok('excludes heading + code', !claims.some(c => c.anchor === 'a0' || c.anchor === 'a4'));
ok('numeric claim captured', claims.some(c => c.kind === 'numeric' && /53%/.test(c.text)));
ok('quote claim captured', claims.some(c => c.kind === 'quote'));
ok('bare claim WITH a year IS flagged', claims.some(c => /passed in 2014/.test(c.text)));
ok('vague bare declarative (no number) NOT flagged', !claims.some(c => /unpopular/.test(c.text)));

// queryFor prefers the quote, else trims text
const qUnit = claims.find(c => c.kind === 'quote');
ok('queryFor uses the quote span', S.queryFor(qUnit) === 'we will not yield');
ok('queryFor trims long text', S.queryFor({ text: 'x'.repeat(400) }).length === 240);

// classifyMatch: found vs none + mark stripping
const found = S.classifyMatch(claims[0], [{ source: 'wikipedia', snippet: 'Turnout <mark>rose</mark>   to 53%', rank: -30 }]);
ok('hit → status found', found.status === 'found' && found.source === 'wikipedia');
ok('snippet stripped of <mark> + collapsed ws', found.snippet === 'Turnout rose to 53%');
const none = S.classifyMatch(claims[0], []);
ok('no hits → status none (needs citation)', none.status === 'none' && none.source === null);
ok('non-array results safe', S.classifyMatch(claims[0], null).status === 'none');

// toFinding shape
const f = S.toFinding(qUnit, found);
ok('finding carries id/anchor/kind/status', f.id && f.anchor && f.kind && f.status === 'found');

console.log(`\nsmoke_creator_sources: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
