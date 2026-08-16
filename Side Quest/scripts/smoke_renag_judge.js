'use strict';
/* smoke_renag_judge.js — the bounded re-nag judge routing + fail-open (FEC loop, 2026-08-16 audit).
 * The real suppress/surface CALL is the model's (proven live in the drill log); here we lock the deterministic
 * scaffolding around it with an INJECTED classify (no network): the gate short-circuits when nothing was
 * delivered, honors the classifier's verdict, and FAILS OPEN (→ surface) on any error or ambiguity — because
 * suppressing a genuine partial/correction is far worse than letting a nag through (the adversarial finding).
 * Run: node scripts/smoke_renag_judge.js */
const J = require('../lib/renag_judge');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const dl = ['Rick Scott receipts $36,696,093 disbursements $39,942,180 — comparison table on your canvas.'];

(async () => {
  console.log('parseVerdict — DONE=suppress, OPEN=surface, ambiguity=surface:');
  ok(J.parseVerdict('DONE') === true, '"DONE" → true (suppress)');
  ok(J.parseVerdict('OPEN') === false, '"OPEN" → false (surface)');
  ok(J.parseVerdict('done — that was already delivered') === true, 'sentence containing DONE → true');
  ok(J.parseVerdict('OPEN, she still owes the correction') === false, 'sentence containing OPEN → false');
  ok(J.parseVerdict('DONE or OPEN') === false, 'an echo of the choices resolves to OPEN (surface) — never a false suppress');
  ok(J.parseVerdict('') === false && J.parseVerdict('maybe') === false && J.parseVerdict(null) === false, 'empty / neither / null → false (fail-open)');

  console.log('\nisRedundantRenag — gating + injected classify:');
  ok(await J.isRedundantRenag('I never resolved those FEC numbers — want me to run that down?', [], { classify: () => true }) === false,
    'NO deliveries → false without ever consulting the classifier (nothing to contradict the nag)');
  ok(await J.isRedundantRenag('', dl, { classify: () => true }) === false, 'empty say → false');
  ok(await J.isRedundantRenag('I never resolved those FEC numbers.', dl, { classify: () => true }) === true,
    'classify DONE → true (suppress the false re-nag)');
  ok(await J.isRedundantRenag('I gave you Scott, still owe you Moody.', dl, { classify: () => false }) === false,
    'classify OPEN → false (a genuine partial surfaces)');
  ok(await J.isRedundantRenag('nag', dl, { classify: () => { throw new Error('model down'); } }) === false,
    'classify THROWS → false (FAIL-OPEN to surface)');
  ok(await J.isRedundantRenag('nag', dl, { classify: async () => true }) === true, 'async classify is awaited');
  ok(await J.isRedundantRenag('nag', dl, { classify: () => 'DONE' }) === false, 'a non-strict-true classify return → false (only ===true suppresses)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
