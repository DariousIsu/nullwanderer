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

// --- COVERAGE questions: a different question from "what's running" ---
// These phrasings match NOTHING in STATE_RE, which is why detectCoverageQuestion exists — without it
// the portfolio standing would be computed and never reach the turn asking for it.
for (const q of ['how is the research going', "how's the research going", 'how much have we covered',
  'how far along is the elected officials research', 'what is our coverage', 'research progress?',
  'how many bodies have we done']) {
  ok(ss.detectCoverageQuestion(q) === true, `coverage question detected: "${q}"`);
}
// NARROWNESS is the whole safety property — a social opener must never drag in a progress ledger.
for (const q of ['how is it going', 'how are you', "how's your day", 'how much do you like jazz',
  'how many people were at the meeting', 'good morning']) {
  ok(ss.detectCoverageQuestion(q) === false, `CRITICAL: social/unrelated must NOT match: "${q}"`);
}
ok(ss.detectStateQuestion('what is your status') === true, 'uncontracted "what is your status" now matches too');

// --- research standing: honest denominators, and the anti-overclaim rail ---
{
  const withR = ss.buildBlock(ss.snapshot({
    echoConnected: true, sharedBrowser: false, ownBrowser: false, lastSearchAt: 0, threads: [],
    research: { beats: 223, completeBeats: 3, emptyUniverseBeats: 2, done: 91, total: 52857, remaining: 52766, pct: 0 },
  }), 'Lucas', NOW);
  ok(/91 of 52857 bodies\/offices researched/.test(withR), 'renders done-of-total against the real denominator');
  ok(/52766 still outstanding/.test(withR), 'states what is outstanding, not just what is done');
  ok(/BODIES worked, NOT people on file/.test(withR),
    'CRITICAL: carries the bodies-vs-people rail — a researched chamber is not a complete roster');
  ok(/Never state or imply the research is finished/.test(withR), 'forbids reading the number as completion');
  ok(/2 beat\(s\) have NO worklist/.test(withR), 'surfaces empty-universe beats as a DATA GAP, not as complete');

  // The null case must stay silent rather than render a fabricated 0/0 = "0% researched".
  const noR = ss.buildBlock(ss.snapshot({ echoConnected: true, sharedBrowser: false, ownBrowser: false, lastSearchAt: 0, threads: [], research: null }), 'Lucas', NOW);
  ok(!/research standing/i.test(noR), 'CRITICAL: unknown standing renders NOTHING — never a 0% that reads as "nothing done"');
  const zeroR = ss.buildBlock(ss.snapshot({ echoConnected: true, sharedBrowser: false, ownBrowser: false, lastSearchAt: 0, threads: [], research: { total: 0, done: 0, remaining: 0, pct: 0, beats: 0 } }), 'Lucas', NOW);
  ok(!/research standing/i.test(zeroR), 'a zero-universe summary is also withheld rather than shown as 0%');
}

// --- humanAge ---
ok(ss.humanAge(30 * 1000) === '30s' && ss.humanAge(90 * 1000) === '1m' && ss.humanAge(2 * 3600 * 1000) === '2h', 'humanAge buckets');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
