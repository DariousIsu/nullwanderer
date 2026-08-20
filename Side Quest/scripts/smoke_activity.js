/* Smoke: lib/activity — the cross-lane activity source (classify + grounded summary + heartbeat pointers).
 * Pure, snapshot injected. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_activity.js
 */
'use strict';
const act = require('../lib/activity');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- classification ---
ok(act.isActivityQuestion('what are you doing?'), '"what are you doing" → activity question');
ok(act.isActivityQuestion('what are you working on right now'), '"working on" → activity question');
ok(act.isActivityQuestion('are you watching something?'), '"are you watching" → activity question');
ok(act.isActivityQuestion('you busy?'), '"you busy" → activity question');
ok(!act.isActivityQuestion('how many think tanks did you find'), 'a deliverable question is NOT an activity question');
ok(!act.isActivityQuestion('thanks, that was great'), 'gratitude is NOT an activity question');

// --- PAST self-activity recall (E2): "what did YOU do today" — answered from her own activity log ---
ok(act.isSelfActivityRecall('what did you actually work on earlier today? walk me through it'), 'T6: "what did you actually work on today" → self-activity recall');
ok(act.isSelfActivityRecall('walk me through what you did today'), '"walk me through what you did" → self-activity recall');
ok(act.isSelfActivityRecall('what have you been up to?'), '"what have you been up to" → self-activity recall');
ok(act.isSelfActivityRecall('what were you working on this morning'), '"what were you working on" → self-activity recall');
ok(act.isSelfActivityRecall('how was your day?'), '"how was your day" → self-activity recall');
ok(!act.isSelfActivityRecall('what are you doing?'), 'present "what are you doing" is NOT past self-activity (activityQ owns it)');
ok(!act.isSelfActivityRecall('what can you do?'), 'a capability question is NOT self-activity recall');
ok(!act.isSelfActivityRecall('what did you say about the schema'), 'a recall-of-statement is NOT self-activity (isRecallQuery owns it)');
ok(!act.isSelfActivityRecall('who is Bill Cassidy'), 'an entity lookup is NOT self-activity recall');

// --- F10 (run-2, stable-FAIL twice): "what did you LEARN" routes to the LEARN door, never user-recall ---
ok(act.isSelfLearnRecall('what did you learn today?'), 'F10: "what did you learn today" → self-learn recall');
ok(act.isSelfLearnRecall("what's the most interesting thing you learned today"), 'F10: the live gap-fill-2 phrasing → self-learn recall');
ok(act.isSelfLearnRecall('most interesting thing you\'ve learned this week?'), 'F10: bare "most interesting thing you\'ve learned" → self-learn');
ok(act.isSelfLearnRecall('did you learn anything new tonight'), 'F10: "did you learn anything" → self-learn');
ok(act.isSelfLearnRecall('what have you been learning'), 'F10: "what have you been learning" → self-learn');
ok(!act.isSelfLearnRecall('what did you work on today'), 'a DOING question stays with self-activity, not learn');
ok(!act.isSelfLearnRecall('you learn something new every day, huh'), 'the idiom (not a question about her) does not fire');
ok(!act.isSelfLearnRecall('teach me what I should learn about redistricting'), 'the USER\'s learning is not her learn-recall');
// F30 (saturation run 3, live-missed ×2): the net covered a phrase FAMILY, not the KIND — the
// inverted teach-shape and the lesson-from-mistake shape both fell through (the second landed in
// entity land: her own "you" disambiguated against contact tags).
ok(act.isSelfLearnRecall('What did the last few days teach you about your own work?'), 'F30 REGRESSION: the inverted teach-you shape → self-learn');
ok(act.isSelfLearnRecall('Name one mistake you caught yourself making recently and what you changed.'), 'F30 REGRESSION: the lesson-from-mistake shape → self-learn');
ok(act.isSelfLearnRecall('what has this week taught you?'), 'generic "what has X taught you" → self-learn');
ok(act.isSelfLearnRecall('any lessons you picked up from the overnight runs?'), '"any lessons you picked up" → self-learn');
ok(!act.isSelfLearnRecall('the mistake you made was in the query, not the data'), 'a declarative CORRECTION about her error never enters the learn door');
ok(!act.isSelfLearnRecall("I'll teach you a new trick for parsing these files"), 'the user offering to teach is not her learn-recall');

// --- a snapshot with all three lanes active ---
const snap = {
  research: { goal: 'study every right-of-center think tank', covered: ['Heritage', 'Cato', 'AEI'], target: { name: 'Hoover' } },
  media: { title: 'Journey with Philosophy', url: 'youtube.com/watch?v=e2', stage: 'watching', understanding: 'intro to epistemology' },
  meeting: { url: 'meet.google.com/abc', stage: 'awaiting_admit', awaitingAdmit: true }
};
const s = act.summarize(snap);
ok(s.active === 3, 'all three active lanes counted');
ok(/researching .*think tank.*3 done.*Hoover/i.test(s.block), 'research lane: goal + count + current target, grounded');
ok(/watching "Journey with Philosophy".*epistemology/i.test(s.block), 'media lane: title + understanding');
ok(/meeting.*waiting to be let in/i.test(s.block), 'meeting lane: awaiting-admit surfaced');
ok(s.pointers.length === 3, 'one heartbeat pointer per active lane');
ok(s.pointers.some(p => /→ research lane/.test(p)) && s.pointers.some(p => /→ media lane/.test(p)), 'pointers carry a dereferenceable lane ref');

// --- finished/none lanes are not reported as active ---
const snap2 = { research: { goal: 'g', covered: ['a'] }, media: { stage: 'done' }, meeting: { stage: 'none' } };
const s2 = act.summarize(snap2);
ok(s2.active === 1 && /researching/.test(s2.block) && !/watching/.test(s2.block) && !/meeting/.test(s2.block), 'done/none lanes excluded; only the live research reported');

// --- empty snapshot → honest "not in the middle of anything" ---
const s3 = act.summarize({});
ok(s3.active === 0 && /not in the middle of any active task/i.test(s3.block) && s3.pointers.length === 0, 'no active lanes → honest idle answer, no pointers');

// --- fail-safe on junk ---
ok(act.summarize(null).active === 0, 'null snapshot → no crash, 0 active');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
