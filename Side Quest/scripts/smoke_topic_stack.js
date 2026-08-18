/* smoke: lib/topic_stack — the anaphoric-RETURN resolver (elastic memory E3a). Pure. Resolves "the first
 * thing we talked about" to the conversationally-first topic BY TURN ORDER, not by salience (drill T4).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_topic_stack.js */
'use strict';
const ts = require('../lib/topic_stack');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- detectReturn: fires on a genuine return, with the right ordinal ---
const dr = (s) => ts.detectReturn(s);
ok(dr('Okay, circle back for me — what was the weakest part of that first thing we talked about?').isReturn
  && dr('… that first thing we talked about?').ordinal === 'first', 'T4: "that first thing we talked about" → return, ordinal=first');
ok(dr('what we were saying earlier about the budget').isReturn && dr('what we were saying earlier').ordinal === 'first' || dr('what we were saying earlier').ordinal === 'earlier', '"what we were saying earlier" → return');
ok(dr('going back to the first point you raised').isReturn && dr('going back to the first point you raised').ordinal === 'first', '"going back to the first point" → return, first');
ok(dr('the second thing you mentioned').isReturn && dr('the second thing you mentioned').ordinal === 'second', '"the second thing you mentioned" → return, second');
ok(dr('circle back to the last topic we discussed').isReturn && dr('circle back to the last topic we discussed').ordinal === 'last', '"the last topic we discussed" → return, last');

// --- NON-returns (idioms, plain factual, forward asks) must NOT fire ---
ok(!dr('the last thing I need is a headache').isReturn, 'idiom "the last thing I need" → NOT a return (noun not followed by we/you)');
ok(!dr('what is the first bill about?').isReturn, '"the first bill about" → NOT a return (not thing/topic + we/you)');
ok(!dr('tell me about the report').isReturn, 'plain "the report" → NOT a return');
ok(!dr('who is Bill Cassidy').isReturn, 'an entity lookup → NOT a return');
ok(!dr('what did you work on today').isReturn, 'a self-activity question → NOT a return');
ok(!dr('the first thing you need to do is reboot the server').isReturn, 'imperative "the first thing you need to do" → NOT a return');
ok(!dr('the last thing you said was wrong').isReturn, 'correction "the last thing you said was wrong" → NOT a return');
ok(!dr('tell me about the first report you generated yesterday').isReturn, 'past-artifact "the first report you generated" → NOT a return');

// --- referentForOrdinal: resolves BY TURN ORDER; excludes the current (last) turn ---
const turns = [
  { id: 11, content: 'Give me the current picture on Louisiana energy policy' },  // first
  { id: 12, content: "what's your read on the 2026 Senate map" },
  { id: 13, content: 'who is Bill Cassidy to us' },
  { id: 14, content: 'circle back to the first thing we talked about' },          // current (the return)
];
ok(ts.referentForOrdinal(turns, 'first').id === 11, 'ordinal "first" → the conversationally-first topic (turn 11, LA energy)');
ok(ts.referentForOrdinal(turns, 'second').id === 12, 'ordinal "second" → turn 12');
ok(ts.referentForOrdinal(turns, 'last').id === 13, 'ordinal "last" → the topic just before the current (turn 13)');
ok(ts.referentForOrdinal(turns, 'earlier').id === 13, 'ordinal "earlier" → the immediately-prior topic (turn 13)');
ok(ts.referentForOrdinal([{ id: 1, content: 'only turn' }], 'first') === null, 'single-turn session (only the current turn) → no prior referent → null');
ok(ts.referentForOrdinal([], 'first') === null, 'empty → null (no crash)');

// --- returnDirective carries the resolved topic text + first-thing framing ---
const d = ts.returnDirective('Lucas', { id: 11, content: 'Louisiana energy policy' }, 'first');
ok(/Louisiana energy policy/.test(d) && /FIRST thing/.test(d) && /order/i.test(d), 'directive names the topic + frames it as the FIRST, ordered thing');
ok(!/\[|\]/.test(ts.returnDirective('Lucas', { id: 1, content: 'a ] break ] out' }, 'first').replace(/^\[|\]$/g, '')), 'brackets stripped from interpolated topic content (no directive-frame break-out)');

console.log(`\n${fail === 0 ? 'TOPIC-STACK OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
