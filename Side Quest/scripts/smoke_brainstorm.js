/* Smoke: lib/brainstorm — the MIDDLE GEAR between chit-chat and a full research project. Proves the
 * explicit-only commit rule (a command auto-fires; a discussed topic does not), the deterministic KIND
 * backstop (topical/forecast never silently collapse to entity), soft-affirmation offer commit + TTL, and
 * the light-pull gating (active collaborator on topical turns, quiet on self/social). Pure, no I/O.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_brainstorm.js
 */
'use strict';
const b = require('../lib/brainstorm');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ─── isImperativeAssignment: command → auto-fire; topic → stay conversational ───
ok(b.isImperativeAssignment('research the AI arms race and put together a dossier') === true, 'explicit "research X" → imperative (auto-fire)');
ok(b.isImperativeAssignment('go deep on the Environmental Law Institute') === true, '"go deep on X" → imperative');
ok(b.isImperativeAssignment('spin it up') === true, '"spin it up" → imperative');
ok(b.isImperativeAssignment('build me a list of AI datacenter companies') === true, '"build me a list" → imperative');
ok(b.isImperativeAssignment('profile Senator Curtis') === true, '"profile X" → imperative');
ok(b.isImperativeAssignment("what's going on with the AI arms race?") === false, 'a topical QUESTION → not a command (stays brainstorm)');
ok(b.isImperativeAssignment('I wonder how the AI arms race plays out') === false, 'musing → not a command');
ok(b.isImperativeAssignment('what if we researched the arms race angle') === false, '"what if we researched X" → floated idea, not a command');
ok(b.isImperativeAssignment('we could dig into that later') === false, '"we could dig into X" → floated, not a command');
ok(b.isImperativeAssignment('Research whether we should dig into this') === true, 'a LEADING imperative wins even with a muse word later');
ok(b.isImperativeAssignment('tell me about the Environmental Law Institute') === false, '"tell me about X" → topical, not a research command');
ok(b.isImperativeAssignment('hey') === false, 'trivial turn → not a command');

// ─── reconcileKind / classifyKind: the deterministic backstop ───
ok(b.classifyKind('who will win the House in 2026?') === 'forecast', 'classifyKind: "who will win" → forecast');
ok(b.classifyKind('what are the odds the bill passes') === 'forecast', 'classifyKind: "odds ... passes" → forecast');
ok(b.classifyKind('brief me on the Strait of Hormuz situation') === 'topical', 'classifyKind: "brief me on X" → topical');
ok(b.classifyKind("what's going on with the arms race") === 'topical', 'classifyKind: "what\'s going on with X" → topical');
ok(b.classifyKind('find me AI datacenter companies in Texas') === 'entity', 'classifyKind: "find me companies" → entity');
ok(b.classifyKind('hello there friend') === null, 'classifyKind: no signal → null');
// reconcile: a lazy cloud 'entity' on a topical/forecast turn is corrected
ok(b.reconcileKind('entity', 'brief me on the fusion energy landscape') === 'topical', 'reconcile: cloud=entity but topical phrasing → topical (the live bug, fixed)');
ok(b.reconcileKind('entity', 'what are the odds Trump wins') === 'forecast', 'reconcile: forecast signal overrides cloud=entity');
ok(b.reconcileKind('topical', 'find me energy think tanks') === 'topical', 'reconcile: trust a confident cloud kind when no strong override');
ok(b.reconcileKind(null, 'find me AI companies') === 'entity', 'reconcile: cloud down → deterministic entity');
ok(b.reconcileKind(null, 'chat about nothing in particular') === 'entity', 'reconcile: no signal anywhere → safe entity default');
ok(b.reconcileKind('forecast', 'random text') === 'forecast', 'reconcile: cloud forecast preserved');

// ─── isAffirmation + offerFresh: the seed → offer → commit arc ───
ok(b.isAffirmation('yes') === true, '"yes" → affirmation');
ok(b.isAffirmation('do it') === true, '"do it" → affirmation');
ok(b.isAffirmation("yeah, let's go") === true, '"yeah, let\'s go" → affirmation');
ok(b.isAffirmation('sure, go for it') === true, '"sure, go for it" → affirmation');
ok(b.isAffirmation('no thanks') === false, '"no thanks" → not an affirmation');
ok(b.isAffirmation('yes but only the funding angle and also look at the timeline please carefully') === false, 'a long qualified reply is NOT a bare affirmation (carries new scope)');
const now = 1000000;
ok(b.offerFresh(now - 60 * 1000, now) === true, 'offer 1 min old → fresh');
ok(b.offerFresh(now - 20 * 60 * 1000, now) === false, 'offer 20 min old → stale (past TTL)');
ok(b.offerFresh(0, now) === false, 'no timestamp → not fresh');

// ─── shouldLightPull: active collaborator on topical turns, quiet on self/social ───
ok(b.shouldLightPull({ route: 'explore', msgLen: 40, message: 'the AI arms race and export controls' }) === true, 'explore route → always pull fuel');
ok(b.shouldLightPull({ route: 'answer', msgLen: 45, message: "what's the latest on the semiconductor tariffs" }) === true, 'topical answer turn → pull');
ok(b.shouldLightPull({ route: 'converse', msgLen: 8, message: 'lol yeah' }) === false, 'tiny converse turn → no pull');
ok(b.shouldLightPull({ route: 'converse', msgLen: 30, message: 'how are you feeling today buddy' }) === false, 'non-topical chit-chat → no pull');
ok(b.shouldLightPull({ route: 'answer', socialTurn: true, msgLen: 40, message: 'good morning to the whole team' }) === false, 'social → no pull');
ok(b.shouldLightPull({ route: 'answer', devQ: true, msgLen: 40, message: 'what have you been working on lately' }) === false, 'self/dev question → no pull');
ok(b.shouldLightPull({ route: 'status', msgLen: 40, message: "how's the research going along" }) === false, 'status route → no pull');
ok(b.shouldLightPull({ route: 'answer', activityQ: true, msgLen: 40, message: 'what are you up to right now' }) === false, 'activity question → no pull');

// ─── pullTopic: strip the question scaffolding down to the subject ───
ok(b.pullTopic("what's going on with the AI arms race?") === 'the AI arms race', 'pullTopic strips "what\'s going on with" + trailing ?');
ok(b.pullTopic('tell me about the Environmental Law Institute') === 'the Environmental Law Institute', 'pullTopic strips "tell me about"');
ok(b.pullTopic('hey Zoe, what is fusion energy') === 'fusion energy', 'pullTopic strips greeting + "what is"');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
