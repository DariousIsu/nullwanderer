/* Smoke: operator.isDirectedTask — EXECUTION/PRODUCTION imperatives are directed tasks (D-route, 2026-08-16 drill).
 * Pure logic, no DB/model. The live bug: "write a python script … run it … paste the output" carried NONE of
 * TASK_RE's research verbs, fell through to route=status, and she narrated "I'm on it" instead of running it
 * (T6/T8). isDirectedTask now also recognizes exec/production imperatives (EXEC_RE / EXEC_LEAD_RE) with an
 * interrogative-lead exclusion + the PAST_REF guard, so the four consumers (router sig, needsExternal, the
 * standing-focus fallback, the directed budget) see one truth.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_operator_directed.js
 */
'use strict';
const { isDirectedTask } = require('../lib/operator');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── FIRE: exec/production imperatives (the drill shapes) ──
ok(isDirectedTask('write a python script that counts FEC donors over 10k, run it, and paste the count'),
  'write a python script … run it … paste → task (T6; "write a" misses TASK_RE, caught by EXEC_LEAD)');
ok(isDirectedTask('forget FEC for a second, read the traceback and fix it and run it again'),
  '"run it again" → task (T7 body; EXEC_RE run-with-object)');
ok(isDirectedTask('pull up the electoral CRM and write a python script that counts the rows in each table, run it, and paste the output'),
  'pull up + write + run + paste → task (T8; EXEC_LEAD "^pull up")');

// ── FIRE: existing TASK_RE behavior unchanged (interrogative exclusion is exec-branch only) ──
ok(isDirectedTask('build me a dossier on every energy PAC'), 'TASK_RE verb "build" → task (unchanged)');
ok(isDirectedTask('can you research every right-of-center think tank'),
  'TASK_RE "research" survives a "can you" lead — the interrogative exclusion only gates the exec branch');

// ── NO FIRE ──
ok(!isDirectedTask('how many FEC donors have you researched so far?'),
  'interrogative "how many" + no task/exec verb → NOT a task (a status count, not an order)');
ok(!isDirectedTask('you were working on the FEC research earlier'),
  'PAST_REF "you were working" → NOT a new task (recall, not a command)');
ok(!isDirectedTask('nice'), 'too short (<6) → false');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
