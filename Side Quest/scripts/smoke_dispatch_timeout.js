/* Smoke: per-tool DISPATCH TIMEOUT (echo_suit._raceTimeout) — the first line beneath the 150s turn-watchdog.
 *
 * Every Echo tool call funnels through dispatch → callTool with NO client-side timeout (only db_query has a
 * 20s budget). A hung research/browse/spawn tool stalls the whole turn until the watchdog. _raceTimeout
 * races the call against a timer and, on timeout, RESOLVES a soft error (so the turn keeps going) + logs the
 * tool name. This pins: timeout → soft error (not a throw); fast call passes through; a real error still
 * throws; ms<=0 disables. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_dispatch_timeout.js
 */
'use strict';
const { _raceTimeout } = require('../lib/echo_suit');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const never = () => new Promise(() => {});           // hangs forever

(async () => {
  // 1. A hung call times out into a SOFT ERROR (resolves, does not throw) with the tool name.
  const t0 = Date.now();
  let r;
  try { r = await _raceTimeout(never(), 60, 'browse-read'); }
  catch (e) { r = { threw: true }; }
  const elapsed = Date.now() - t0;
  ok(r && r.timedOut === true && r.isError === true, 'hung tool → soft error result (timedOut, isError)');
  ok(r && r.tool === 'browse-read' && /browse-read/.test(r.text || ''), 'soft error names the tool');
  ok(!r.threw, 'timeout RESOLVES (turn continues) — does not throw');
  ok(elapsed >= 55 && elapsed < 500, `fired near the deadline (~60ms), took ${elapsed}ms`);

  // 2. A fast call passes straight through, untouched.
  const good = await _raceTimeout(Promise.resolve({ ok: true, text: 'done' }), 1000, 'search_entities');
  ok(good && good.ok === true && good.text === 'done' && !good.timedOut, 'fast call passes through unchanged');

  // 3. A real tool error still THROWS (existing self-correction path preserved), not swallowed as a timeout.
  let threw = false;
  try { await _raceTimeout(Promise.reject(new Error('bad args')), 1000, 'propose_relation'); }
  catch (e) { threw = /bad args/.test(e.message); }
  ok(threw, 'a genuine tool error still throws (not masked as a timeout)');

  // 4. ms<=0 disables the guard — returns the core promise as-is.
  const raw = await _raceTimeout(Promise.resolve({ ok: true, n: 7 }), 0, 'x');
  ok(raw && raw.n === 7, 'ms<=0 disables the timeout (pass-through)');

  // 5. A LATE rejection after a timeout does not surface as an unhandled rejection.
  let unhandled = null;
  const onUnh = (e) => { unhandled = e; };
  process.on('unhandledRejection', onUnh);
  const late = new Promise((_, rej) => setTimeout(() => rej(new Error('late fail')), 30));
  await _raceTimeout(late, 10, 'slow');            // timeout wins at 10ms; late rejects at 30ms
  await new Promise(r => setTimeout(r, 60));         // let the late rejection settle
  process.removeListener('unhandledRejection', onUnh);
  ok(unhandled === null, 'late rejection after timeout is swallowed (no unhandled rejection)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
