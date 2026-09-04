/* smoke_boot_cycle_guard.js — THE LIVE GUARD in scripts/boot_cycle.py (2026-09-04).
 * The law ("live-guard before ANY kill — user-turn age > 3 min, never over his conversation") lived in
 * memory, not in the script: the 02:30 cycle on 09-04 killed boot_p282 thirteen seconds after his
 * message landed, unanswered. The guard now reads the app's own /status before any kill. Pinned here
 * through the script's --check-guard door (stdin JSON → verdict, exit 0 / 2), with the bare python.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_boot_cycle_guard.js
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const script = path.join(__dirname, 'boot_cycle.py');
const verdict = (status, extra = []) => {
  const r = spawnSync('python', [script, '--root-pid', '0', '--check-guard', ...extra], { input: typeof status === 'string' ? status : JSON.stringify(status), encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
};

const quiet = { ok: true, inFlight: false, lastUserTurnAgoMs: 5378883, lastRealUserTurnAgoMs: 5378882, realUnanswered: false, port: 8767 };
let v = verdict(quiet);
ok(v.code === 0 && /^OK /.test(v.out), `quiet for 1.5h, nothing in flight, nothing unanswered → OK (${v.out || v.err})`);
v = verdict({ ...quiet, lastUserTurnAgoMs: 42972, lastRealUserTurnAgoMs: 42972, realUnanswered: true });
ok(v.code === 2 && /REFUSED/.test(v.out) && /unanswered/.test(v.out), `⭐ the 02:30 shape verbatim (his turn 43 s old, unanswered) → REFUSED (${v.out})`);
v = verdict({ ...quiet, lastRealUserTurnAgoMs: 13000, realUnanswered: false });
ok(v.code === 2 && /13s ago/.test(v.out) && /never over his conversation/.test(v.out), 'a real turn 13 s old → REFUSED even when answered (three minutes of quiet first)');
v = verdict({ ...quiet, lastRealUserTurnAgoMs: 179000 });
ok(v.code === 2, 'at 179 s → still refused');
v = verdict({ ...quiet, lastRealUserTurnAgoMs: 181000 });
ok(v.code === 0, 'at 181 s → OK (the three-minute line)');
v = verdict({ ...quiet, inFlight: true });
ok(v.code === 2 && /in flight/.test(v.out), 'a reply in flight → REFUSED');
v = verdict('not json');
ok(v.code === 2 && /guess/.test(v.out), 'an unreadable status → REFUSED (a kill never proceeds on a guess)');
v = verdict({ ok: true });
ok(v.code === 2 && /turn age is unreadable/.test(v.out), 'a status without a turn age → REFUSED');
v = verdict({ ...quiet, lastRealUserTurnAgoMs: 13000 }, ['--min-quiet', '10']);
ok(v.code === 0, 'the quiet window is an operator knob (--min-quiet 10 → 13 s passes)');
const src = fs.readFileSync(script, 'utf8');
ok(/ok, why = live_guard\(body, args\.min_quiet\)/.test(src) && /if not ok and not args\.force:\s*\n\s*log\(f'REFUSED by the live guard: \{why\}'\)\s*\n\s*return 2/.test(src), 'the cycle path runs the guard BEFORE the kill and returns 2 on a refusal');
ok(/if body is None:\s*\n\s*if not args\.force:\s*\n\s*log\('REFUSED: the app does not answer \/status/.test(src), 'an app that does not answer /status is not killed without --force');
ok(/lastRealUserTurnAgoMs/.test(src) && /realUnanswered/.test(src) && /inFlight/.test(src), 'the guard reads the three signals the status carries: turn age, unanswered, in flight');

console.log(`\nsmoke_boot_cycle_guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
