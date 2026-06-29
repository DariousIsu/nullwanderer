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
