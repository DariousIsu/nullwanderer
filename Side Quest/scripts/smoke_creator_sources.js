/* scripts/smoke_creator_sources.js — offline checks for the source-flagging analyzer (no engine).
 * Run: node scripts/smoke_creator_sources.js */
'use strict';
const S = require('../studio/creator_sources');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

const blocks = [
  { anchor: 'a0', type: 'heading', text: 'Findings' },                                       // heading: excluded
  { anchor: 'a1', type: 'paragraph', text: 'Turnout rose to 53% in 2018.' },                 // numeric signal → kept
  { anchor: 'a2', type: 'paragraph', text: 'The chair said "we will not yield" today.' },    // quote signal → kept
  { anchor: 'a3', type: 'paragraph', text: 'The policy failed.' },                            // bare, <6 words → dropped
  { anchor: 'a4', type: 'paragraph', text: 'The Senate reopened permitting negotiations after the offshore wind dispute.' }, // bare ≥6 words → kept
  { anchor: 'a5', type: 'code', text: 'x = 1' },                                              // code: excluded
];

// ---- extractClaims: signal units always; bare claims only if substantive (≥6 words) ----
const claims = S.extractClaims(blocks);
ok('excludes heading + code', !claims.some(c => c.anchor === 'a0' || c.anchor === 'a5'));
ok('numeric signal kept', claims.some(c => c.kind === 'numeric'));
ok('quote signal kept', claims.some(c => c.kind === 'quote'));
ok('substantive bare claim (≥6 words) kept', claims.some(c => c.anchor === 'a4' && c.kind === 'claim'));
ok('short bare sentence (<6 words) dropped', !claims.some(c => c.anchor === 'a3'));

// ---- keywords: salient, proper-noun-first, FTS-safe, length uncapped (specific > incidental) ----
const kw = S.keywords('The Senate reopened permitting negotiations after the offshore wind dispute');
ok('proper noun ranks first', kw[0] === 'Senate');
ok('keywords drop stopwords', !kw.includes('the') && !kw.includes('after'));
ok('keywords FTS-safe (alphanumeric only)', kw.every(t => /^[A-Za-z0-9]+$/.test(t)));
const ykw = S.keywords('Voter turnout hit a 72-year low in 2014');
ok('year kept + ranks high', ykw.includes('2014') && ykw.indexOf('2014') <= 1);

// ---- queries: top-2 AND, then single-term fallback ----
const qs = S.queries({ text: 'The Senate reopened permitting negotiations' });
ok('first query is a 2-term AND', qs[0].split(' ').length === 2);
ok('fallback single term present', qs.some(q => q.split(' ').length === 1));
ok('all queries FTS-safe', qs.every(q => q.split(' ').every(t => /^[A-Za-z0-9]+$/.test(t))));
ok('no-keyword claim → no queries', S.queries({ text: 'it is on the' }).length === 0);

// ---- classifyMatch over `search` result shape ----
const found = S.classifyMatch({ kind: 'claim' }, [{ doc_id: 505, title: 'Permitting Summary', snippet: 'Senate <mark>permitting</mark>  talks', project_name: 'Energy', rank: -7 }]);
ok('hit → found w/ docId+title+project', found.status === 'found' && found.docId === 505 && found.project === 'Energy');
ok('snippet stripped + collapsed', found.snippet === 'Senate permitting talks');
ok('no hits → none', S.classifyMatch({ kind: 'claim' }, []).status === 'none');
ok('non-array results safe', S.classifyMatch({ kind: 'claim' }, null).status === 'none');

// ---- shouldSurface: kills vague-unmatched noise, keeps useful flags ----
ok('found bare claim → surfaced', S.shouldSurface({ status: 'found', kind: 'claim' }));
ok('unmatched signal claim (stat) → surfaced (needs citation)', S.shouldSurface({ status: 'none', kind: 'numeric' }));
ok('unmatched vague bare claim → DROPPED', !S.shouldSurface({ status: 'none', kind: 'claim' }));

ok('internal hit → provenance library', found.provenance === 'library');

// ---- external lane: academic preferred, web fallback, openable URL ----
ok('webQuery is natural text, trimmed', S.webQuery({ text: 'The Senate reopened permitting negotiations.' }) === 'The Senate reopened permitting negotiations.');
const acad = S.classifyExternal(
  [{ title: 'Some Web Page', url: 'https://example.com/x', snippet: 'web blurb' }],
  [{ title: 'Grid Reliability Study', authors: ['Lee', 'Kim', 'Ng'], year: 2025, venue: 'Energy J.', doi: '10.1/abc', abstract: 'We find...', is_oa: true, source: 'openalex' }]);
ok('academic preferred over web', acad.provenance === 'academic' && acad.title === 'Grid Reliability Study');
ok('academic url from doi when no url', acad.url === 'https://doi.org/10.1/abc');
ok('academic byline summarized (et al.)', acad.byline === 'Lee et al.');
const webOnly = S.classifyExternal([{ title: 'Politico piece', url: 'https://politico.com/y', snippet: 'news' }], []);
ok('web fallback when no academic', webOnly.provenance === 'web' && webOnly.url === 'https://politico.com/y' && webOnly.source === 'politico.com');
ok('no external results → none', S.classifyExternal([], []).status === 'none');

// ---- toFinding carries openable identity (internal docId + external url) ----
const f = S.toFinding({ uid: 'a4.s0', anchor: 'a4', kind: 'claim', text: 'x' }, found);
ok('finding carries id/anchor/kind/status/docId/title', f.id && f.anchor && f.kind && f.status === 'found' && f.docId === 505 && f.title === 'Permitting Summary');
const fx = S.toFinding({ uid: 'a5.s0', anchor: 'a5', kind: 'numeric', text: 'y' }, webOnly);
ok('external finding carries url + provenance', fx.url === 'https://politico.com/y' && fx.provenance === 'web');

console.log(`\nsmoke_creator_sources: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
