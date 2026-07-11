/**
 * Backtest — web-intent detection. Deterministic, no model/db. Proves the exact
 * messages from the live session route correctly (and that normal talk doesn't).
 */
const { detectWebIntent, detectRecordCommand } = require('../lib/intent');
let pass = 0, fail = 0;
function ok(n, c) { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } }
const fires = (msg, frag) => { const r = detectWebIntent(msg); return r && (!frag || r.target.includes(frag)); };

console.log('Backtest — detectWebIntent\n');
console.log('FIRES (should open her browser):');
ok('take a look at this <url>', fires('take a look at this https://www.raineycenter.org/national-summit', 'raineycenter.org'));
ok('try opening a new browser', fires('try opening a new browser', 'google'));
ok('use <web-open> its a new tool', fires('use <web-open> its a new tool'));
ok('open a new browser', fires('open a new browser', 'google'));
ok('check out this link <url>', fires('check out this link https://example.com/x', 'example.com'));
ok('look up the summit online', fires('look up the rainey center summit online', 'rainey'));
ok('can you search something from here', fires('can you search something from here?', 'something'));
ok('search the latest AI news', fires('search the latest AI news', 'latest AI news'));
ok('google rainey center', fires('google rainey center', 'rainey center'));
ok('look up X (imperative)', fires('look up the maastricht treaty', 'maastricht'));
ok('explicit <web-open>body</web-open>', fires('<web-open>nytimes.com</web-open>', 'nytimes.com'));
ok('go to example.com', fires('go to https://example.com', 'example.com'));

console.log('\nDOES NOT FIRE (normal talk):');
ok("'let's search for a better approach'", detectWebIntent("let's search for a better approach to the problem") === null);
ok("'what do you think about that'", detectWebIntent('what do you think about that') === null);
ok("'i read your last message'", detectWebIntent('i read your last message and agree') === null);
ok('empty', detectWebIntent('') === null);

console.log('\n--- detectRecordCommand ---');
console.log('START (begin a demonstration recording):');
const start1 = detectRecordCommand('record a recipe for publishing on substack.com');
ok('"record a recipe for publishing on substack.com"', start1 && start1.action === 'start' && start1.site === 'substack.com' && /publish/i.test(start1.task));
const start2 = detectRecordCommand('record how to create an event on https://calendar.google.com');
ok('"record how to create an event on <url>"', start2 && start2.action === 'start' && start2.site === 'calendar.google.com' && /create an event/i.test(start2.task));
const start3 = detectRecordCommand('let me show you how to file an expense at concur.com');
ok('"let me show you how to file an expense"', start3 && start3.action === 'start' && /file an expense/i.test(start3.task));
ok('capture the steps to … → start', (detectRecordCommand('capture the steps to upload a doc') || {}).action === 'start');

console.log('STOP (finish + save):');
ok('"stop recording" (strict, any time)', (detectRecordCommand('stop recording', false) || {}).action === 'stop');
ok('"save the recipe" (strict)', (detectRecordCommand('ok save the recipe now', false) || {}).action === 'stop');
ok('"done" only stops while recording is live', (detectRecordCommand("ok i'm done", true) || {}).action === 'stop');
ok('"done" does NOT stop when not recording', detectRecordCommand("ok i'm done", false) === null);
ok('"that\'s it" stops while recording', (detectRecordCommand("that's it", true) || {}).action === 'stop');

console.log('DOES NOT FIRE (normal talk / other intents):');
ok('"publish a post about journalists" is NOT a record cmd', detectRecordCommand('write and publish a post about female journalists') === null);
ok('"open substack.com" is NOT a record cmd', detectRecordCommand('open substack.com for me') === null);
ok('plain conversation', detectRecordCommand('what do you think about that?') === null);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
