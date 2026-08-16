'use strict';
/* smoke_false_incompleteness.js — the PURE lexical gates for the false-incompleteness self-nag guard
 * (FEC loop, 2026-08-16 audit). The suppress DECISION is a bounded model call (lib/renag_judge, tested in
 * smoke_renag_judge.js); these two predicates only GATE it cheaply. isOwedClaim must catch the phrasings the
 * adversarial pass (wf_38a9dc28) proved the first cut missed — the bare "I never resolved those FEC numbers"
 * and idioms like "still outstanding" / "dropped the ball" — while ignoring plain musings. resultBearingDeliveries
 * must return only REAL delivered replies (non-unprompted ai_said with a result token), never her own nags.
 * Run: node scripts/smoke_false_incompleteness.js */
const D = require('../lib/delivery');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

console.log('isOwedClaim — she is claiming HER OWN work is unfinished/owed → GATE OPEN (true):');
ok(D.isOwedClaim('I never resolved those FEC numbers — want me to run that down?'),
  'THE bare canonical nag (the false-negative the first cut missed on "FEC" being 3 chars) → true');
ok(D.isOwedClaim('That Scott head-to-head is still outstanding on my end.'), '"still outstanding" → true');
ok(D.isOwedClaim('I meant to send you the Scott vs Mucarsel-Powell numbers and never did.'), '"meant to send … never did" → true');
ok(D.isOwedClaim('I never circled back on those Scott campaign numbers.'), '"never circled back" → true');
ok(D.isOwedClaim('I dropped the ball on the Scott numbers.'), '"dropped the ball" → true');
ok(D.isOwedClaim('The Scott head-to-head is still pending on my side.'), '"still pending" → true');
ok(D.isOwedClaim('I promised you the Scott numbers and never followed through.'), '"never followed through" → true');
ok(D.isOwedClaim('I still owe you that comparison. Want me to run it now?'), '"still owe you" → true');
ok(D.isOwedClaim('I got cut off mid-sentence and never finished the burn-rate math.'), '"never finished" → true');
ok(D.isOwedClaim('I never delivered the DMP numbers — want me to close that out?'), 'alias nag "never delivered the DMP numbers" → true (model resolves DMP downstream)');

console.log('\nisOwedClaim — NOT an owed-claim → GATE CLOSED (false, no model call):');
ok(!D.isOwedClaim("I've been thinking about the cost of being embodied — the friction of a physical form."), 'a musing → false');
ok(!D.isOwedClaim('Rick Scott won the 2024 Florida Senate race by about 13 points.'), 'a factual statement → false');
ok(!D.isOwedClaim('You got a new email from Sarah about the budget.'), 'an info-share → false');
ok(!D.isOwedClaim('') && !D.isOwedClaim(null), 'empty / null → false (never throws)');

console.log('\nresultBearingDeliveries — only REAL delivered replies (non-unprompted ai_said w/ a result token):');
const turns = [
  { speaker: 'user', unprompted: 0, content: 'give me the head to head with the real FEC numbers $x' },
  { speaker: 'ai_said', unprompted: 0, content: 'Rick Scott (R) — receipts $36,696,093, disbursements $39,942,180, cash on hand $798,364. Debbie Mucarsel-Powell (D) — receipts $36,616,416. Comparison table is on your canvas.' },
  { speaker: 'ai_said', unprompted: 0, content: 'The table is live on the canvas.' },                       // no result token → excluded
  { speaker: 'ai_said', unprompted: 1, content: 'I still owe you the Scott vs Mucarsel-Powell numbers — receipts $36M, burn rate. Want me to finish it?' }, // a NAG (unprompted) → excluded
  { speaker: 'ai_said', unprompted: 0, content: 'ok' },                                                     // thin → excluded
];
{
  const del = D.resultBearingDeliveries(turns);
  ok(del.length === 1, `exactly one real delivery kept (got ${del.length})`);
  ok(del[0] && /36,696,093/.test(del[0]), 'the kept delivery is the numbers reply');
  ok(!del.some((d) => /Want me to finish it/.test(d)), 'ECHO-CHAMBER immunity: her own unprompted nag is NOT counted as a delivery');
  ok(D.resultBearingDeliveries(turns, 1).length === 1 && D.resultBearingDeliveries([]).length === 0 && D.resultBearingDeliveries(null).length === 0,
    'cap respected; empty / null → [] (never throws)');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
