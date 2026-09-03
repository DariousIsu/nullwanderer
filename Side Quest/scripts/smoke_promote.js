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

// --- ⭐ THE JUNK NET (continuity cure #3, 2026-09-02): an error/challenge page is not memory ---
ok(P.skipReason({ title: 'IIS 8.5 Detailed Error - 404.0 - Not Found', body: 'HTTP Error 404.0 - Not Found\nThe resource you are looking for has been removed. '.repeat(3), promoted: 0 }) === 'junk',
  '⭐ the page the last pass filed into long-term ("IIS 8.5 Detailed Error - 404.0") is junk, never filed');
ok(P.skipReason({ title: 'Just a moment...', body: 'Checking your browser before accessing example.com. Enable JavaScript and cookies to continue.', promoted: 0 }) === 'junk', 'a bot-challenge interstitial is junk');
ok(P.skipReason({ title: 'Committee Agenda', body: '# Committee Agenda\n\nAccess Denied\nYou do not have permission to view this page.', promoted: 0 }) === 'junk', 'a short body that opens with an access-denied marker is junk (title alone is not trusted)');
ok(P.skipReason({ title: 'Bill — HB0256: School District Elections', body: 'A BILL for an act relating to school district elections; '.repeat(40), promoted: 0 }) === null, 'a real bill is not junk');
ok(P.skipReason({ title: '404 Recovery Act analysis', body: 'The 404 Recovery Act, introduced in 2024, addresses '.repeat(60), promoted: 0 }) === null, 'a long real document is never junk, whatever its title says (the net stops at JUNK_MAX_CHARS)');
ok(P.skipReason({ title: 'x', body: 'tiny', promoted: 0 }) === 'thin' && P.skipReason(null) === 'thin', 'thin stays thin; null is thin (no throw)');
ok(P.shouldPromote({ title: 'HTTP Error 403 - Forbidden', body: 'Forbidden. '.repeat(10), promoted: 0 }) === false, 'shouldPromote refuses junk');
{
  const fs = require('fs'), path = require('path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/const why = promote\.skipReason\(doc\);/.test(main) && /markDocumentPromoted\(doc\.id, `skipped:\$\{why\}`\)/.test(main), '⭐ wiring: the pass marks skipped:thin / skipped:junk from skipReason (retention drops them later)');
  ok(/const _fail = \(id, why\) => \{ failed\+\+; try \{ db\.notePromoteFailure\(id, why\); \} catch \{\} \};/.test(main) && (main.match(/_fail\(doc\.id, /g) || []).length >= 4, '⭐ wiring: every failure path notes the attempt on the row (the ledger the backoff reads)');
  ok(/async function _promoteDocsTick/.test(main) && /promoteDocumentsPass\(\{ limit: PROMOTE_DOCS_BATCH, timeBudgetMs: 90 \* 1000 \}\)/.test(main) && /\[promote-docs\]/.test(main), '⭐ wiring: the 15-min promote-docs BEAT runs the same pass with a time budget — the bridge no longer waits for the nightly pass');
  ok(/if \(timeBudgetMs > 0 && Date\.now\(\) - started > timeBudgetMs\) \{ budgetHit = true; break; \}/.test(main), 'wiring: the time budget breaks the loop, leaving the rest their turn');
}

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
