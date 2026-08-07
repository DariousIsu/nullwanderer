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
ok('long messages never nominate', !ai.prefilter('x'.repeat(450), { workingFresh: true }));

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
ok('all standing intents offered', ['canvas_create', 'report', 'pullup', 'none'].every((i) => noSession.includes(i)));
ok('typo doctrine rides the contract', /typos/i.test(noSession) && /pullet/.test(noSession));
ok('unsure→none doctrine rides the contract', /When unsure, "none"/.test(noSession));

console.log(`smoke_artifact_intent: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
