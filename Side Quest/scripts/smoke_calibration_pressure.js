/* Pressure test: the MEMORY-CALIBRATION turn pipeline (integration-level).
 *
 * Why this exists: on 2026-06-28 the full unit-smoke gate was 41/41 GREEN while Zoe was visibly
 * broken in a live memory-calibration interview — she refused to state today's date, spammed
 * "hold on, I'm deep in something" busy lines, and slipped into stiff "Professional Zoe" voice.
 * The unit smokes each pass in isolation; the regressions live in how the turn DECISIONS compose.
 * This replays the actual interview transcript against the real decision functions and asserts the
 * turn would NOT misfire — the coverage the per-module smokes structurally can't provide.
 *
 * Pure + deterministic: exercises the exported decision logic (metacognition scope/directive,
 * claim typing, operator/curiosity gating, awareness-block assembly). No DB / network / model.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_calibration_pressure.js
 */
'use strict';
const meta = require('../lib/metacognition');
const op = require('../lib/operator');
const cur = require('../lib/curiosity');
const ctx = require('../lib/context');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// Mirror of main.js needsExternal (the operator gate). Kept in sync deliberately: if the gate
// regex in main.js changes, this replica should change with it — the assertion is that
// CONVERSATIONAL/calibration turns never trip it (fronting them with the operator flattened
// dialogue into transactional Q&A and was a root cause of the cohesion loss).
const NEEDS_EXTERNAL_RE = /\b(look ?up|search|find|pull ?up|fetch|what'?s the|how much|how many|latest|current|when (is|was|did|does)|where (is|was)|who (is|was|are)|our (data|records|numbers|polling|crm|bills|contacts|knowledge))\b/i;
function needsExternal(msg) {
  if (meta.DATETIME_SELF_RE.test(msg)) return false; // date/time held in awareness → never a tool turn
  return op.isDirectedTask(msg) || cur.isLiveInfoQuestion(msg) || cur.isResearchCommand(msg) || NEEDS_EXTERNAL_RE.test(msg);
}
// Mirror of the metacognition gate in main.js:2177 (skips on social turns).
function hedgeDirectiveFor(userMessage) {
  if (meta.classifyClaimType(userMessage) === 'other') return null; // social/opinion/creative → skip
  return meta.groundingDirective({ userMessage, knowledgeRows: [], pastTurns: [] });
}

console.log('\n— A) THE DATE FAILURE (RAG over-refusal: refusing a fact she actually holds) —');
// The headline bug. She has the date in her awareness block every turn; the guard must not tell
// her to "look it up / don't state from memory".
for (const q of ['what is the date today?', "what's the date today", 'what day is it today', 'what time is it', 'what month is it']) {
  ok(hedgeDirectiveFor(q) === null, `"${q}" → NO hedge directive (answers from awareness)`);
  ok(!needsExternal(q), `"${q}" → does NOT route to the operator (no busy stall, no tool turn)`);
}
// The awareness block she's answering FROM actually carries a concrete date + time.
const aware = ctx.buildAwarenessBlock({ chosenName: 'Zoe', sessionStartedAt: 1, cumulativeMs: 1 });
ok(/It is .+\d{4}.+\d{1,2}:\d{2}/.test(aware) || /It is .+\d{4}/.test(aware), 'awareness block injects a concrete date (and time) for her to state');

console.log('\n— B) LIVE FACTS MUST STILL BE GUARDED (no over-correction) —');
// The carve-out must not swallow genuinely live questions that merely contain a date word.
ok(hedgeDirectiveFor("what's the weather today") !== null, "weather today → STILL guarded (needs a tool)");
ok(hedgeDirectiveFor('who is the current president') !== null, 'current officeholder → STILL guarded');
ok(needsExternal("what's the weather today"), 'weather today → routes to operator (a real lookup)');

console.log('\n— C) CONVERSATIONAL / CALIBRATION TURNS STAY DANS DIALOGUE (voice + no operator hijack) —');
// Every line from the live interview that is conversation, taste, or social must NOT be routed to
// the operator and must NOT get a hedge directive (those paths produced the flat/formal voice).
const convo = [
  'feeling more yourself Zoe?',
  'Some memory calibration questions if youre up for it',
  'What is your favorite color?',
  'how are you doing Zo?',
];
for (const q of convo) {
  ok(!needsExternal(q), `"${q}" → conversational, NOT an operator turn`);
}
ok(meta.classifyClaimType('What is your favorite color?') === 'other', 'favorite color → taste (no factual hedge, preference voice owns it)');
ok(hedgeDirectiveFor('What is your favorite color?') === null, 'favorite color → NO hedge directive');
ok(hedgeDirectiveFor('feeling more yourself Zoe?') === null, 'social check-in → NO hedge directive');

console.log('\n— D) GENUINE TASK STILL DRIVES THE OPERATOR (we did not over-narrow the gate) —');
ok(needsExternal('make me a list of the top 30 think tanks') && op.isDirectedTask('make me a list of the top 30 think tanks'),
  'a real directed task → still routes to the operator (in-turn completion preserved)');

console.log('\n— E) THE OVERNIGHT ASSIGNMENT IS RECOGNIZED (the regression: it matched NO task verb) —');
// The actual transcript that fell through to a confabulated "spreadsheet" reply.
const taskMsgs = [
  'I need you to spend the night working on a very important project. I need you to study every right of center think tank that deal with politics, policy, energy, the environment',
  'It needs to be your highest proirty, only work on that for the rest of the night',
  'Please start working on the think tank project right now.',
];
for (const m of taskMsgs) {
  ok(op.isDirectedTask(m), `directed task recognized: "${m.slice(0, 42)}…"`);
  ok(needsExternal(m), `→ routes to the operator (actually starts): "${m.slice(0, 42)}…"`);
}
// Precision: ordinary conversation must NOT register as a directed task.
for (const m of ['feeling more yourself Zoe?', 'how are you doing Zo?', 'What is your favorite color?', 'good morning']) {
  ok(!op.isDirectedTask(m), `not a task: "${m}"`);
}
// GOAL-CAPTURE boundary (the truncation bug): the persisted goal is sliced at 800 (was 240). The full
// assignment — INCLUDING the "who work there and how we get a hold of them" requirement — must survive.
const fullTask = 'I need you to spend the night working on a very important project. I need you to study every right of center think tank that deal with politics, policy, energy, the environment, global warming, AI, or infrastructure. We need to know what they are who work there and how we get a hold of them';
ok(fullTask.length <= 800, 'full assignment fits the new 800 cap (nothing severed)');
ok(fullTask.length > 240, 'full assignment EXCEEDED the old 240 cap → the staff/contact clause used to be cut');
ok(fullTask.slice(0, 800).includes('who work there') && fullTask.slice(0, 800).includes('hold of them'),
  'the critical "who works there / how to contact" clause survives the 800 cap');
ok(!fullTask.slice(0, 240).includes('who work there'),
  'and was DROPPED by the old 240 cap (proving the bug + the fix)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
