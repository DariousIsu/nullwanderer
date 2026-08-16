/* Smoke: product_ledger directed-task veto (D-pullup, 2026-08-16 drill). Pure logic, no DB.
 * The live bug: "pull up the electoral CRM and write a python script … run it … paste the output" was
 * captured by the held-product pull-up door (it matched an UNRELATED Claim-Form.pdf) and the analysis lane
 * never ran (T8). A code/execution directive now beats the retrieve verb: detectAsk returns null for it, so
 * the operator owns the turn. detectAskLoose is LEFT UNCHANGED so the correction stand-down keeps its
 * protection. Bare adjective/noun collisions and the "run it by <someone>" review idiom are EXCLUDED.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_product_ledger_veto.js
 */
'use strict';
const pl = require('../lib/product_ledger');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── isDirectedTask: the veto predicate the poll seam consumes ──
ok(pl.isDirectedTask('pull up the electoral CRM and write a python script that counts the rows in each table, run it, and paste the output'),
  'python + run + paste → directed task (the T8 poll-yield is suppressed)');
ok(!pl.isDirectedTask('pull up the aggregate donor report we made'),
  'bare adjective "aggregate" → NOT a task (held-product pull-up preserved)');
ok(!pl.isDirectedTask('pull up the parish roster and run me through it'),
  '"run me through" → NOT a task (not in the run-alternation; ordinary pull-up)');

// ── detectAsk: a directed task is NOT a pull-up (the veto) ──
ok(pl.detectAsk('pull up that table we made and run the query and paste the output') === null,
  'anchored pull-up + "run the query"/"paste the output" → detectAsk null (operator owns it)');

// ── detectAsk: genuine pull-ups survive, incl. the "run it by <someone>" review idiom ──
ok(pl.detectAsk('pull up the memo we wrote and run it by legal') !== null,
  '"run it by legal" review idiom → still a pull-up (negative lookahead on "run it by")');
ok(pl.detectAsk('Can you pull up that most recent list of ten people in Louisiana that we found contact information for?') !== null,
  'live #11102 pull-up unchanged ("contact" != "count", no veto token)');

// ── detectAskLoose: UNCHANGED — the correction guard keeps its protective stand-down ──
ok(pl.detectAskLoose('pull up the electoral CRM and write a python script that counts the rows in each table') !== null,
  'detectAskLoose still matches (via NOUN "table") — the A5 correction stand-down is NOT weakened');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
