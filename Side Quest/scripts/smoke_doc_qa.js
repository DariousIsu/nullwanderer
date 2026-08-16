/* Smoke: lib/doc_qa — answer/extract from a document Lucas dropped. Proves the detector fires on the live
 * failure ("pull my responsibilities out of the meeting notes"), does NOT fire when he's PROVIDING the doc
 * ("I pulled the notes into the canvas"), picks the relevant held doc, and cages the extraction prompt.
 * Pure: no model/file/db/http. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_doc_qa.js
 */
'use strict';
const dq = require('../lib/doc_qa');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- isDocQuery: fires on extraction-FROM-a-held-doc ---
ok(dq.isDocQuery('Can you pull my responsibilities out of the meeting notes?') === true, 'THE live failure → doc query');
ok(dq.isDocQuery('summarize the notes for me') === true, '"summarize the notes" → doc query');
ok(dq.isDocQuery('what are my action items from the meeting?') === true, '"my action items from the meeting" → doc query');
ok(dq.isDocQuery('who is assigned to the blog post in this document?') === true, 'question about this document → doc query');
ok(dq.isDocQuery('list the decisions in the transcript') === true, '"list the decisions in the transcript" → doc query');
ok(dq.isDocQuery('what did the team decide on the canvas doc?') === true, 'question referencing the canvas doc → doc query');

// --- isDocQuery: does NOT fire when PROVIDING the doc, or on unrelated turns ---
ok(dq.isDocQuery('I pulled the notes into the canvas for you') === false, 'PROVIDING ("pulled the notes into the canvas") → NOT a doc query');
ok(dq.isDocQuery('here are the notes from today\'s meeting') === false, '"here are the notes" (providing) → NOT a doc query');
ok(dq.isDocQuery('I dropped the file on the canvas') === false, '"I dropped the file" (providing) → NOT a doc query');
// The 2026-07-22 live miss: a FUTURE promise to provide fired the extract path ("find" + "the notes")
// and she "pulled up" a random held PDF for a document that did not exist yet.
ok(dq.isDocQuery("yea, Maddy is having some health issues and Bill got pulled into other meetings. And you were out because you were down for repairs. I'll find the notes for you in a minute") === false,
  '"I\'ll find the notes for you in a minute" (future provide) → NOT a doc query (the reservists-PDF miss)');
ok(dq.isDocQuery("I'm going to send you the transcript later tonight") === false, '"I\'m going to send you the transcript" → NOT a doc query');
ok(dq.isDocQuery('can you find my action items in the notes?') === true, '"can YOU find … in the notes" (her doing the finding) STILL a doc query');
ok(dq.isDocQuery('research the top 5 think tanks for their VPs') === false, 'a real research project → NOT a doc query');
ok(dq.isDocQuery('how are you today?') === false, 'chit-chat → NOT a doc query');
ok(dq.isDocQuery('what time is it') === false, 'no doc reference → NOT a doc query');

// --- CANVAS AS OUTPUT DESTINATION is not a held-doc reference (T11 live miss, 2026-08-16). "drop a
// table ON the canvas" is where produced work GOES, not a held doc to read FROM — the false match sent
// an external FEC fetch to a random Nevada CAFR and blocked the fetch. Strip the output tail; a genuine
// held-doc ref (or a real canvas READ) survives.
ok(dq.isDocQuery("give me the two florida senate candidates' actual FEC numbers, compute burn rate, and drop a clean comparison table on the canvas") === false,
  'THE T11 miss: external FEC fetch + "drop a table on the canvas" (output tail) → NOT a doc query');
ok(dq.isDocQuery('pull the top 10 employers by FEC contributions and put it on the canvas') === false,
  'external fetch + "and put it on the canvas" (output tail) → NOT a doc query');
ok(dq.isDocQuery('summarize the meeting notes and put it on the canvas') === true,
  'a REAL held-doc query with a canvas-output tail → STILL a doc query (survives via "the notes"; also un-breaks the old PROVIDE_NEG false-reject)');
ok(dq.isDocQuery("what's on the canvas right now?") === true,
  'a READ ("what\'s on the canvas") → STILL a doc query (no output verb at a clause boundary → not stripped)');
ok(dq.isDocQuery('what did the team decide in the doc I dropped?') === true,
  'a held-doc question ("the doc I dropped") → STILL a doc query (canvas-output strip does not touch it)');

// --- isReadingQuery: HER readings referenced declaratively (memory slice 1 #6) ---
ok(dq.isReadingQuery('you read something about neuromorphic chips, right?') === true, '"you read something about X" → reading query');
ok(dq.isReadingQuery('what was that paper you read on state AI task forces?') === true, '"that paper you read" → reading query');
ok(dq.isReadingQuery('what have you been reading lately?') === true, '"what have you been reading" → reading query');
ok(dq.isReadingQuery('you were reading about the Fed pause earlier') === true, '"you were reading about" → reading query');
ok(dq.isReadingQuery('the article you mentioned about hurricanes — what did it say?') === true, '"the article you mentioned" → reading query');
ok(dq.isReadingQuery('you read my mind') === false, 'bare "you read X" without an about/noun form → NOT a reading query');
ok(dq.isReadingQuery('I read something about otters today') === false, 'LUCAS reading is not HER reading → NOT a reading query');
ok(dq.isReadingQuery('pull my responsibilities out of the meeting notes') === false, 'a handed-doc query is NOT a reading query (isDocQuery owns it)');
ok(dq.readingSearchTerms('what was that paper you read on neuromorphic computing?').includes('neuromorphic'), 'search terms keep the content words');
ok(!dq.readingSearchTerms('that article you read').includes('article'), 'search terms drop the reading-reference scaffolding');

// --- pickRelevantDoc ---
const docs = [
  { title: 'Rainey Weekly Huddle', markdown: 'Lucas Overby — deliver publishing materials to Sydney.', openedAt: 100 },
  { title: 'Budget Q3', markdown: 'spreadsheet of numbers', openedAt: 200 },
];
ok(dq.pickRelevantDoc('pull my responsibilities from the huddle notes', docs).title === 'Rainey Weekly Huddle', 'title-overlap picks the Huddle doc over the budget');
ok(dq.pickRelevantDoc('summarize the notes', docs).title === 'Budget Q3', 'no specific hint → most-recently-opened doc');
ok(dq.pickRelevantDoc('anything', []) === null, 'no docs → null');
ok(dq.pickRelevantDoc('x', [{ title: 'T', markdown: '' }]) === null, 'doc with empty body skipped → null');

// --- buildExtractPrompt: grounded, person-scoped ---
const p = dq.buildExtractPrompt({ question: 'pull my responsibilities', docTitle: 'Rainey Huddle', docText: '[Lucas Overby] deliver materials. [Josh] include hyperlinks.' });
ok(Array.isArray(p) && p.length === 2, 'extract prompt is a system+user pair');
ok(/ONLY the document|never invent/i.test(p[0].content), 'extract prompt is strictly grounded');
ok(/EXACTLY those attributed to that person/i.test(p[0].content), 'extract prompt scopes to the person asked about (not everyone)');
ok(/does not contain the answer, say so/i.test(p[0].content), 'extract prompt says "not there" honestly');
ok(/Rainey Huddle/.test(p[1].content) && /Lucas Overby/.test(p[1].content), 'extract prompt carries the title + document');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
