/* Smoke: lib/promote — the nightly promotion brain (Slice 2). Proves the worthiness gate, the per-type
 * recipe (vault doc + KG entities), the temp-file slug, Echo doc_id parsing, and the beat line. Pure: no
 * model/file/db/Echo. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_promote.js
 */
'use strict';
const P = require('../lib/promote');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- shouldPromote: real un-promoted docs only ---
ok(P.shouldPromote({ body: 'x'.repeat(50), promoted: 0 }) === true, 'a real un-promoted doc → promote');
ok(P.shouldPromote({ body: 'x'.repeat(50), promoted: 1 }) === false, 'already promoted → skip');
ok(P.shouldPromote({ body: 'tiny', promoted: 0 }) === false, 'too thin → skip');
ok(P.shouldPromote(null) === false, 'null → skip (no throw)');

// --- recipeFor: vault doc + KG entities; deliverables tagged distinctly ---
const rDrop = P.recipeFor({ source: 'canvas_drop' });
ok(rDrop.kind === 'document' && rDrop.extractEntities === true && rDrop.projectName === '_Inbox', 'canvas_drop → document recipe, extract entities, _Inbox');
const rRes = P.recipeFor({ source: 'research' });
ok(rRes.kind === 'deliverable' && rRes.extractEntities === true, 'research → deliverable recipe, extract entities');
ok(P.recipeFor({}).kind === 'document', 'unknown source → default document recipe');

// --- slug / temp file ---
ok(P.slugForDoc({ title: 'Rainey Weekly Huddle!', id: 5 }) === 'rainey-weekly-huddle', 'slug is filesystem-safe');
ok(P.slugForDoc({ title: '', id: 7 }) === 'document-7', 'no title → document-<id>');
ok(P.tempFileName({ title: 'Budget Q3', id: 2 }) === 'budget-q3.md', 'temp file name = slug.md');

// --- parseEchoDocId: from JSON text, object, or messy result ---
ok(P.parseEchoDocId('{"action":"ingested","doc_id":4242,"path":"x"}') === 4242, 'parses doc_id from JSON text');
ok(P.parseEchoDocId({ action: 'ingested', doc_id: 99 }) === 99, 'parses doc_id from an object');
ok(P.parseEchoDocId('preamble... {"doc_id": 7} trailing') === 7, 'parses doc_id embedded in messy text');
ok(P.parseEchoDocId('{"action":"unsupported"}') === null, 'no doc_id → null');
ok(P.parseEchoDocId('') === null, 'empty → null (no throw)');

// --- promotionBeat ---
ok(/filed 3 new documents into long-term storage/.test(P.promotionBeat({ promoted: 3, failed: 0 })), 'beat reports the count');
ok(/1 couldn't be filed/.test(P.promotionBeat({ promoted: 2, failed: 1 })), 'beat notes failures');
ok(P.promotionBeat({ promoted: 0, failed: 0 }) === '', 'nothing moved → empty beat');
ok(P.promotionBeat({ promoted: 1 }) === 'filed 1 new document into long-term storage', 'singular wording');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
