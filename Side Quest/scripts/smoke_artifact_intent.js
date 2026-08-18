'use strict';
/* smoke_artifact_intent.js — the unified artifact-intent router's pure parts (lib/artifact_intent).
 * The classifier itself is a model call; what must hold offline is the contract around it:
 * nomination (who pays for a judgment), validation (what counts as a verdict), and the want text
 * (every intent offered, edit only during a session). Run: node scripts/smoke_artifact_intent.js */
const path = require('path');
const ai = require(path.join(__dirname, '..', 'lib', 'artifact_intent'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };

// ── prefilter: artifact vocabulary nominates; ordinary chat never pays ──────────────────────────
ok('canvas order nominates', ai.prefilter('please print the parish list to the canvas'));
ok('report order nominates', ai.prefilter('build the final report on the Hartfield Foundation'));
ok('pull-up ask nominates', ai.prefilter('pull up that most recent list of ten people in Louisiana'));
ok('typo order still nominates (noun carries it)', ai.prefilter('pullet the parish list'));
ok('ordinary chat does not nominate', !ai.prefilter('how did the meeting with Russ go?'));
ok('"listen"/"reportedly" do not nominate (word bounds)', !ai.prefilter('listen, they reportedly agreed'));
ok('working session nominates everything short', ai.prefilter('now make them bold', { workingFresh: true }));
ok('without a session the same message does not', !ai.prefilter('now make them bold'));
ok('long messages DO nominate (no artificial cap)', ai.prefilter('please build the report on ' + 'x'.repeat(450), { workingFresh: false }) && ai.prefilter('y'.repeat(450), { workingFresh: true }));

// ── validate: strict intent set, sizes clamped ──────────────────────────────────────────────────
ok('valid verdict passes', ai.validate('{"intent":"pullup","subject":"parish list","instruction":""}').valid);
ok('none is a valid (final) verdict', ai.validate('{"intent":"none"}').valid);
ok('unknown intent rejected', !ai.validate('{"intent":"delete_everything"}').valid);
ok('non-JSON rejected', !ai.validate('sure, sounds like a report').valid);
ok('JSON amid prose is extracted', ai.validate('Here: {"intent":"report","subject":"Green South"} done').value.subject === 'Green South');

// ── wantText: every door offered, edit only in-session, typo doctrine present ───────────────────
const inSession = ai.wantText({ workingFresh: true, workingTitle: 'Louisiana parishes' });
const noSession = ai.wantText({ workingFresh: false });
ok('in-session offers canvas_edit with the doc named', /canvas_edit/.test(inSession) && /Louisiana parishes/.test(inSession));
ok('out of session canvas_edit is not offered', !/canvas_edit/.test(noSession));
ok('all standing intents offered', ['canvas_create', 'report', 'roster', 'pullup', 'none'].every((i) => noSession.includes(i)));
ok('roster is a valid intent, subject = the state', ai.validate('{"intent":"roster","subject":"Louisiana"}').valid && ai.validate('{"intent":"roster","subject":"Louisiana"}').value.intent === 'roster');
ok('roster door describes the parish/county roster + state subject', /parish|count(?:y|ies)/i.test(noSession) && /roster/i.test(noSession));
ok('typo doctrine rides the contract', /typos/i.test(noSession) && /pullet/.test(noSession));
ok('unsure→none doctrine rides the contract', /When unsure, "none"/.test(noSession));

// ── demoteReport: a lookup judged "report" is demoted to "none" (2026-08-18, the Cassidy false-non-delivery
// + two adversarial families). The report door composes from HELD docs only, so a mis-routed lookup ships a
// hollow "we don't hold this" while the operator found the answer live. ──────────────────────────────────
// INTERROGATIVE lookups → none (the incident + questions that happen to contain a report noun):
ok('the Cassidy question demotes', ai.demoteReport('report', "What are U.S. Senator Bill Cassidy's three most recent bills or resolutions this Congress? Give me the bill numbers, titles, and current status.") === 'none');
ok('"who represents LA-06?" demotes', ai.demoteReport('report', "who currently represents Louisiana's 6th congressional district?") === 'none');
ok('"is there a summary of the meeting?" demotes (question beats the noun)', ai.demoteReport('report', 'is there a summary of the meeting?') === 'none');
ok('"who wrote the brief on X?" demotes (a lookup for who authored it)', ai.demoteReport('report', 'who wrote the brief on the donor network?') === 'none');
ok('"can you find me a report on X?" demotes (find ≠ compose)', ai.demoteReport('report', 'can you find me a report on the Hartfield Foundation?') === 'none');
// bare facts / SOFT-noun lookups with no compose verb → none (the adversarial HIGH — near-synonyms of the incident):
ok('"give me X\'s numbers" (no report noun) demotes', ai.demoteReport('report', "give me Rick Scott's latest FEC numbers") === 'none');
ok('"give me a summary of X\'s bills" demotes (soft noun, no compose verb)', ai.demoteReport('report', "give me a summary of Bill Cassidy's recent bills") === 'none');
ok('"give me a rundown of X" demotes', ai.demoteReport('report', 'give me a rundown of the situation in Louisiana') === 'none');
ok('"give me an analysis of X" demotes', ai.demoteReport('report', 'give me an analysis of the recent vote') === 'none');
ok('a bare fragment (no report noun, no verb) demotes', ai.demoteReport('report', "Bill Cassidy's recent bills and their status") === 'none');
// genuine report-DOCUMENT orders → keep report (the adversarial MEDIUM — noun-last / verb-less / question-phrased must survive):
ok('"put together everything we have on X into a report" keeps (verb-last, hard noun)', ai.demoteReport('report', 'Put together everything we have on the Hartfield Foundation into a proper report') === 'report');
ok('"turn our research into a report" keeps (hard noun, verb not listed)', ai.demoteReport('report', 'turn our research on the donor network into a report') === 'report');
ok('"write me a report on X" keeps', ai.demoteReport('report', 'write me a report on the Hartfield Foundation') === 'report');
ok('"compose a dossier on Y" keeps (hard noun)', ai.demoteReport('report', 'compose a dossier on Green South Solutions') === 'report');
ok('"give me a report on X" keeps (hard report-document noun)', ai.demoteReport('report', 'give me a report on the donor network') === 'report');
ok('"draft a summary of X" keeps (soft noun + compose verb)', ai.demoteReport('report', 'draft a summary of the committee findings') === 'report');
ok('"a Hartfield dossier — build it" keeps (hard noun anywhere)', ai.demoteReport('report', 'a Hartfield Foundation dossier — build it') === 'report');
ok('"can you write me a report on X?" keeps (compose order, politely question-phrased)', ai.demoteReport('report', 'can you write me a report on the donor network?') === 'report');
ok('"can you summarize our research into a report?" keeps (question-phrased, verb=summarize)', ai.demoteReport('report', 'can you summarize our research into a report?') === 'report');
ok('"could you knock together a dossier on X?" keeps (question-phrased, verb=knock together)', ai.demoteReport('report', 'could you knock together a dossier on Green South?') === 'report');
ok('"could you flesh out our findings into a dossier?" keeps', ai.demoteReport('report', 'could you flesh out our findings into a dossier?') === 'report');
// …but "who WROTE the brief?" (past-tense authorship question) stays a lookup — "wrote" is deliberately NOT a compose verb
ok('"who wrote the brief on X?" stays none (wrote ≠ compose)', ai.demoteReport('report', 'who wrote the brief on the donor network?') === 'none');
// only "report" is ever touched — every other intent passes through unchanged
for (const i of ['canvas_edit', 'canvas_create', 'roster', 'pullup', 'none']) ok(`${i} passes through demoteReport unchanged`, ai.demoteReport(i, 'what are the latest numbers?') === i);
// the sharpened wantText carries the question≠report doctrine
ok('wantText says a bare question is NOT a report', /bare QUESTION/i.test(noSession) && /answered live/i.test(noSession));

console.log(`smoke_artifact_intent: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
