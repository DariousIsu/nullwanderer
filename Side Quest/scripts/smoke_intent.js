/**
 * Backtest — web-intent detection. Deterministic, no model/db. Proves the exact
 * messages from the live session route correctly (and that normal talk doesn't).
 */
const { detectWebIntent } = require('../lib/intent');
let pass = 0, fail = 0;
function ok(n, c) { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } }
const fires = (msg, frag) => { const r = detectWebIntent(msg); return r && (!frag || r.target.includes(frag)); };

console.log('Backtest — detectWebIntent\n');
console.log('FIRES (should open her browser):');
ok('take a look at this <url>', fires('take a look at this https://www.raineycenter.org/national-summit', 'raineycenter.org'));
ok('try opening a new browser', fires('try opening a new browser', 'duckduckgo'));
ok('use <web-open> its a new tool', fires('use <web-open> its a new tool'));
ok('open a new browser', fires('open a new browser', 'duckduckgo'));
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

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
