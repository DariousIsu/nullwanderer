/* smoke_test_port_guard.js — the run-4 collision guard (built 2026-08-20).
 *
 * The proven gap (turns 12874-12884): the port's live-guard counted its OWN injected turns as "the
 * user" and ignored unanswered real turns older than 120s — Lucas's live clarification sat
 * unanswered while the suite kept firing into the same session; replies cross-threaded. The pure
 * predicates here decide REAL-user ownership; the wiring greps pin the /turn gate + /status fields.
 */
'use strict';
const tp = require('../lib/test_port');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── realTurnFrom: injected windows are invisible; the newest OUTSIDE row is the real user ───────
const rows = [
  { id: 5, session_id: 's1', ts: 10000 },   // newest — inside an injection window (a test turn)
  { id: 4, session_id: 's1', ts: 7000 },    // real user turn
  { id: 3, session_id: 's1', ts: 4000 },    // inside another window
];
const windows = [{ a: 9000, b: 11000 }, { a: 3500, b: 4500 }];
ok(tp.realTurnFrom(rows, windows).id === 4, 'the newest NON-injected user turn is the real user');
ok(tp.realTurnFrom([{ id: 9, ts: 10500 }], windows) === null, 'all rows injected → no real user found');
ok(tp.realTurnFrom([], windows) === null, 'no rows → null (fail-open upstream)');
ok(tp.realTurnFrom(rows, []).id === 5, 'no windows (fresh boot) → newest row counts as real (errs toward blocking, never colliding)');

// ── blockVerdict: recent real turn blocks; unanswered blocks longer; stale clears ───────────────
ok(tp.blockVerdict({ agoMs: 126000, unanswered: false }).block === true, 'the LIVE collision case: a 126s-old real turn now BLOCKS (was allowed at >120s)');
ok(tp.blockVerdict({ agoMs: 126000, unanswered: true }).block === true, '…and unanswered too');
ok(/UNANSWERED/.test(tp.blockVerdict({ agoMs: 12 * 60000, unanswered: true }).why || ''), 'a 12min-old UNANSWERED real turn still blocks, and says why');
ok(tp.blockVerdict({ agoMs: 12 * 60000, unanswered: false }).block === false, 'a 12min-old ANSWERED real turn clears (past the 10min window)');
ok(tp.blockVerdict({ agoMs: 31 * 60000, unanswered: true }).block === false, 'the unanswered block caps at 30min (an abandoned turn cannot wedge testing forever)');
ok(tp.blockVerdict({ agoMs: null, unanswered: false }).block === false, 'no real user on record → no block');

// ── wiring: the /turn gate consults the verdict; /status exposes the real-user fields ───────────
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'test_port.js'), 'utf8');
ok(/const rv = blockVerdict\(real\);[\s\S]{0,200}send\(409/.test(src), 'wiring: POST /turn refuses on the real-user verdict');
ok(/lastRealUserTurnAgoMs: real\.agoMs/.test(src) && /realUnanswered: real\.unanswered/.test(src), 'wiring: /status exposes the real-user state');
ok(/_noteInjectionWindow\(_injectStart, Date\.now\(\)\)/.test(src), 'wiring: every injected turn records its window (finally — even on error)');
const harness = fs.readFileSync(path.join(__dirname, 'hard_test.js'), 'utf8');
ok(/lastRealUserTurnAgoMs/.test(harness) && /yielding until his conversation clears/.test(harness), 'wiring: the harness yields patiently instead of colliding or dying');

console.log(`\nsmoke_test_port_guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
