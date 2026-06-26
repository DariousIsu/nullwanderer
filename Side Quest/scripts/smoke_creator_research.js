/* scripts/smoke_creator_research.js — offline checks for the entity/advisor analyzer (no engine/model).
 * Run: node scripts/smoke_creator_research.js */
'use strict';
const R = require('../studio/creator_research');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

// ---- detectEntities: generous, typed patterns, sentence-opener filtering ----
const blocks = [
  { type: 'paragraph', text: 'Majority Leader John Thune told reporters that the SPEED Act and Section 401 matter.' },
  { type: 'paragraph', text: 'The Joseph Rainey Center for Public Policy backed Senator Mike Lee.' },
  { type: 'paragraph', text: 'But turnout was low.' },           // "But" opener must not become an entity
  { type: 'code', text: 'const Foo = 1;' },                       // code excluded
];
const ents = R.detectEntities(blocks);
const has = (m) => ents.some(e => e.mention.toLowerCase() === m.toLowerCase());
ok('detects multiword person (John Thune)', has('John Thune'));
ok('detects org phrase w/ connectors (Rainey Center for Public Policy)', ents.some(e => /Rainey Center for Public Policy/i.test(e.mention)));
ok('detects bill "SPEED Act" typed', ents.some(e => e.mention === 'SPEED Act' && e.kind === 'bill'));
ok('detects "Section 401" typed legal', ents.some(e => e.mention === 'Section 401' && e.kind === 'legal'));
ok('detects "Senator Mike Lee"', ents.some(e => /Mike Lee/i.test(e.mention)));
ok('sentence-opener "But" not an entity', !has('But'));
ok('code block excluded', !has('Foo'));

// ---- nameMatches: the gate that kills noisy hits ----
ok('Mike Lee matches "LEE, MIKE [S0UT00165]"', R.nameMatches('Mike Lee', 'LEE, MIKE [S0UT00165]'));
ok('SPEED Act does NOT match "LD 1634 (ME, 131)"', !R.nameMatches('SPEED Act', 'LD 1634 (ME, 131)'));
ok('Mike Lee does NOT match "Permitting Reform"', !R.nameMatches('Mike Lee', 'Permitting Reform'));

// ---- classifyEntity over search_entities shape ----
const m = R.classifyEntity('Mike Lee', [
  { id: 1680966, name: 'LEE, MIKE [S0UT00165]', entity_type: 'person', entity_subtype: 'us_senator', summary: 'LEE, MIKE\n  party: REP' },
  { id: 1, name: 'Permitting Reform', entity_type: 'concept', summary: 'x' },   // gated out
]);
ok('matched=true with gated candidates', m.matched && m.candidates.length === 1);
ok('candidate carries id/type/subtype/summary', m.candidates[0].id === 1680966 && m.candidates[0].type === 'person' && m.candidates[0].subtype === 'us_senator' && /LEE, MIKE/.test(m.candidates[0].summary));
ok('no name-overlap → not matched', R.classifyEntity('SPEED Act', [{ id: 9, name: 'LD 1634 (ME, 131)', entity_type: 'bill' }]).matched === false);
ok('empty results → not matched', R.classifyEntity('X', []).matched === false);

// ---- advisor prompt + parse ----
const msgs = R.buildAdvisorMessages('Some draft about permitting.', 'You have a briefing: Permitting Reform Summary.');
ok('advisor builds system+user', msgs.length === 2 && msgs[0].role === 'system' && /database already knows/.test(msgs[1].content));
const advice = R.parseAdvice(`prose...{
  "additions":[{"title":"Add Sec. 401 background","detail":"Pull from your briefing."}],
  "directions":[{"title":"Lead with the grid angle","detail":"Open on data-center demand."}],
  "tone":[{"observation":"Neutral/analytic","suggestion":"Sharpen for an advocacy audience."}]
}`);
ok('parses additions', advice.additions.length === 1 && /Sec\. 401/.test(advice.additions[0].title));
ok('parses directions', advice.directions.length === 1 && /grid/.test(advice.directions[0].title));
ok('parses tone', advice.tone.length === 1 && /analytic/i.test(advice.tone[0].observation));
ok('junk advice → empty buckets', JSON.stringify(R.parseAdvice('no json here')) === JSON.stringify({ additions: [], directions: [], tone: [] }));

console.log(`\nsmoke_creator_research: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
