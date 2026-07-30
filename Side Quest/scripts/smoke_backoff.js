/* Smoke: lib/backoff — the shared failure-cooldown shape (cloud reply writer's miss latch).
 * Pure: no db, no timers.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_backoff.js
 */
'use strict';
const bk = require('../lib/backoff');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const T = 1000000;

// schedule: 1m → 2m → 4m … capped 30m
ok(bk.next(1) === 60e3 && bk.next(2) === 120e3 && bk.next(3) === 240e3, 'cooldown doubles per consecutive miss (1m, 2m, 4m)');
ok(bk.next(10) === bk.CAP_MS && bk.next(99) === bk.CAP_MS, 'cooldown caps at 30m — a long outage never locks the cloud out for hours');

// state machine
let s = null;
ok(!bk.shouldSkip(s, T) && !bk.shouldSkip({}, T), 'no state / empty state → never skip (cloud is tried)');
s = bk.onFailure(s, T);
ok(s.streak === 1 && s.until === T + 60e3, 'first miss opens a 60s cooldown');
ok(bk.shouldSkip(s, T + 30e3), 'inside the cooldown → skip (local voices immediately)');
ok(!bk.shouldSkip(s, T + 61e3), 'after expiry → probe the cloud again');
s = bk.onFailure(s, T + 61e3);
ok(s.streak === 2 && s.until === T + 61e3 + 120e3, 'second consecutive miss doubles the cooldown');
s = bk.onSuccess();
ok(s.streak === 0 && !bk.shouldSkip(s, T), 'ONE success resets everything — a healthy cloud pays nothing');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
