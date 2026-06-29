/* Smoke: lib/self_state — live-state introspection (self-awareness Layer 1).
 * Deterministic: every volatile field injected, fixed `now`, no db/runtime.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_self_state.js
 */
const ss = require('../lib/self_state');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- detectStateQuestion: positives ---
ok(ss.detectStateQuestion('what are you doing right now?'), 'what are you doing → fires');
ok(ss.detectStateQuestion('what can you see right now'), 'what can you see → fires');
ok(ss.detectStateQuestion("what's your status"), "what's your status → fires");
ok(ss.detectStateQuestion('are you connected to the database'), 'are you connected → fires');
ok(ss.detectStateQuestion('what tools do you have'), 'what tools do you have → fires');

// --- detectStateQuestion: negatives ---
ok(!ss.detectStateQuestion('what is the price of oil'), 'live-info → does NOT fire');
ok(!ss.detectStateQuestion("what's your favorite color"), 'taste → does NOT fire');
ok(!ss.detectStateQuestion('who is my daughter'), 'personal-fact → does NOT fire');

// --- snapshot: deps override the live reads (fully testable) ---
const NOW = 1_000_000_000_000;
const snap = ss.snapshot({
  offClock: false, away: false, echoConnected: true, sharedBrowser: false, ownBrowser: true,
  lastSearchAt: NOW - 5 * 60 * 1000, threads: [{ content: 'research 6G privacy implications' }]
});
ok(snap.echoConnected === true && snap.ownBrowser === true && snap.sharedBrowser === false, 'snapshot reflects injected deps');

// --- buildBlock: renders only true facts, with the "speak from this, don't invent" rail ---
const block = ss.buildBlock(snap, 'Lucas', NOW);
ok(/RIGHT NOW, OPERATIONALLY/.test(block), 'block headers live operational state');
ok(/do NOT guess or invent state/i.test(block), 'block forbids inventing state');
ok(/Echo\): CONNECTED/i.test(block), 'reports Echo CONNECTED when connected');
ok(/your own browser open/i.test(block) && !/shared browser/i.test(block), 'reports only the browser that is actually open');
ok(/Last web lookup you ran: 5m ago/.test(block), 'humanizes last-search age (5m)');
ok(/research 6G privacy/.test(block), 'lists active threads she is carrying');
ok(/working \/ on the clock/.test(block) && /here with you/.test(block), 'mode + presence rendered');

// --- buildBlock omits unknown facts gracefully ---
const sparse = ss.buildBlock(ss.snapshot({ echoConnected: false, sharedBrowser: false, ownBrowser: false, lastSearchAt: 0, threads: [] }), 'Lucas', NOW);
ok(!/Last web lookup/.test(sparse) && !/Active threads/.test(sparse), 'omits last-search + threads when none');
ok(/not connected this moment/.test(sparse) && /not currently open/.test(sparse), 'honestly reports disconnected/closed');

// --- humanAge ---
ok(ss.humanAge(30 * 1000) === '30s' && ss.humanAge(90 * 1000) === '1m' && ss.humanAge(2 * 3600 * 1000) === '2h', 'humanAge buckets');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
