/* Smoke: lib/report_command — the explicit "build the report on X" detector. Pure/offline.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_report_command.js
 */
'use strict';
const rc = require('../lib/report_command');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- the live misses (verbatim from the DB) MUST now be caught ---
ok(rc.detect('I want you to build the final report on the Hartfield Foundation').topic === 'Hartfield Foundation', 'the exact live order → topic "Hartfield Foundation" (article stripped)');
ok(rc.detect('Can I have the final report on Hartfield Foundation please').topic === 'Hartfield Foundation', 'the request form + trailing "please" → clean topic');
ok(rc.detect('I want you to build the final report on the Hartfield Foundation. Everything you were able to find on the organization and where their money comes from').topic === 'Hartfield Foundation', 'a trailing elaboration sentence does not bleed into the topic');

// --- other legitimate build phrasings ---
ok(rc.detect('build me a report on the New Hampshire House').topic === 'New Hampshire House', 'build me a report on X');
ok(rc.detect('compose a briefing about the CSIS think tank').topic === 'CSIS think tank', 'compose a briefing about X');
ok(rc.detect('print the dossier on Green South Foundation').topic === 'Green South Foundation', 'print the dossier on X');
ok(rc.detect('put together a write-up covering the data center fight in NC').topic === 'data center fight in NC', 'put together a write-up covering X');
ok(rc.detect('give me the report on Hartfield').topic === 'Hartfield', 'give me the report on X (request form)');

// --- RE-ORDER verbs (2026-08-21, the P0 gate's re-order leg): "rebuild the report on X" fell
// through to plain chat live — the net lacked the verb and the cloud router was quota-muted.
// A re-order is a compose that updates the registry's canonical file in place.
ok(rc.detect('rebuild the report on anti-China and surveillance bills state by state with sponsors').topic === 'anti-China and surveillance bills state by state with sponsors', 'the LIVE miss: rebuild the report on X now fires');
ok(rc.detect('regenerate the brief on the Hartfield Foundation').topic === 'Hartfield Foundation', 'regenerate the brief on X');
ok(rc.detect('redo the report on Louisiana energy policy').topic === 'Louisiana energy policy', 'redo the report on X');
ok(rc.detect('any update on the report for louisiana') === null, '"any update on the report" is a STATUS ask, never a build order (update stays out of BUILD)');

// --- must NOT fire on questions ABOUT a report ---
ok(rc.detect('what does the report say about Hartfield') === null, 'asking what a report SAYS is not a build order');
ok(rc.detect('is the Hartfield report ready?') === null, 'asking if a report is READY is not a build order');
ok(rc.detect('review the report you wrote') === null, 'asking to review a report is not a build order');
ok(rc.detect('how is the report coming along') === null, 'a status question is not a build order');
ok(rc.detect('can you research the Hartfield Foundation') === null, 'a plain research ask (no report noun) does not match here');
ok(rc.detect('') === null && rc.detect(null) === null, 'empty / null → null, no throw');

// --- topic cleaning ---
ok(rc.cleanTopic('the Hartfield Foundation please') === 'Hartfield Foundation', 'cleanTopic strips leading article + trailing courtesy');
ok(rc.cleanTopic('all United States Senators') === 'United States Senators', 'cleanTopic strips a leading "all"');

// --- wiring (source asserts): the order routes to a real compose, before the placeholder nets ---
{
  const fs = require('fs'), path = require('path');
  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/report_command'\)\.detect\(userMessage\)/.test(m) && /buildReportFromHeld\(/.test(m), 'an explicit report order routes to buildReportFromHeld');
  // it must run BEFORE the promised-lookup net, or the placeholder path wins again
  ok(m.indexOf('[report-cmd] explicit report order') < m.indexOf('promised-lookup net → running the lookup'), 'the report net fires BEFORE the promised-lookup net (no more falling through to a placeholder)');
  ok(/async function buildReportFromHeld/.test(m), 'the compose-from-held handler exists');
  ok(/FROM documents/.test(m) && /NOT LIKE 'Conversation —%'/.test(m), 'it composes from HELD documents and excludes chat transcripts');
  ok(/hold NO research documents about it/.test(m) && /Do NOT invent a document/.test(m), 'holding nothing → says so honestly, never fabricates');
  // Since the artifact registry (Phase 0, doc-plan #5) the slug is the PROJECT's — resolved via
  // resolveOrMint (kin topics update the canonical file in place) with a legacy fallback shape.
  ok(/promiseArtifactEmit\(\{ slug, title: `Report/.test(m) && /resolveOrMint\(\{ topic: t, kind: 'report' \}/.test(m) && /rel = `notes\/\$\{slug\}\.md`/.test(m),
    'the composed report lands on the CANVAS and is saved to notes/ under its PROJECT slug (registry-resolved)');
  ok(/ZOE_REPORT_CMD/.test(m), 'the net has a kill switch');
  // the runaway revalidator cap (same session)
  ok(/ZOE_MAX_PLAN_REV/.test(m) && (m.match(/revalidation CAPPED at rev/g) || []).length === 2, 'plan revalidation is capped on BOTH lanes (the rev-102 chat flood)');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
