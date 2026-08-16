'use strict';
/* smoke_internal_action.js — INTERNAL THOUGHTS → INTERNAL ACTIONS (Lucas 2026-08-16).
 * A self-noticed tension surfaced as an unprompted "want me to pull it up?" is a NAG → route to an
 * internal action (open a line of inquiry) and stay silent. A GENUINE question (a decision/preference/
 * info only Lucas holds) is PRESERVED. Conservative: 'act' ONLY for a clear self-work permission-offer.
 * Run: node scripts/smoke_internal_action.js */
const ia = require('../lib/internal_action');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const act = (s, o) => ia.classifyUnpromptedAsk(s, o) === 'act';
const surface = (s, o) => ia.classifyUnpromptedAsk(s, o) === 'surface';

console.log('classifyUnpromptedAsk — a self-directed self-work nag → ACT (internalize):');
ok(act('Parish clean-up doc stalled, want me to pull it up?'), 'the live disease: "…stalled, want me to pull it up?" → act');
ok(act('Do you want me to look into why the FEC data stalled?'), '"do you want me to look into …?" → act');
ok(act('Should I dig into the Monroe proposals?'), '"should I dig into …?" → act');
ok(act('The parish sweep is half-finished — want me to finish it?'), '"…want me to finish it?" → act');
ok(act('Want me to resume the Louisiana roster?'), '"want me to resume …?" → act');
ok(act('Should I keep digging into the outside-money numbers?'), '"should I keep digging …?" → act');

console.log('\nclassifyUnpromptedAsk — an UNENUMERATED self-work verb still internalizes (the allowlist→blocklist fix):');
ok(act('I never resolved those FEC numbers for Rick Scott and Debbie Mucarsel-Powell. I pulled committee IDs and some figures, but the totals shifted between pulls and I didn\'t get you a clean comparison. Want me to run that down properly?'),
  'THE leaked screenshot: "…want me to run that down properly?" ("run down" not in the old allowlist) → act');
ok(act('Want me to nail down the final totals?'), '"nail down" (never enumerated) → act');
ok(act('Should I sort out the committee figures?'), '"sort out" (never enumerated) → act');
ok(act('Want me to reconcile the two numbers?'), '"reconcile" (never enumerated) → act');
ok(act('Want me to track that down?'), '"track that down" (never enumerated) → act');
ok(act('I think I botched the totals in that old Gaetz paper — want me to fix it?'),
  'THE governing rule: a self-discovered error in HER OWN old paper → fix it (act), never ask permission');
ok(act('That brief I sent you last week has a stale figure. Should I correct it?'),
  'fixing her own prior deliverable is not "something new" → act (she corrects + presents; Lucas redirects if he wants)');

console.log('\nclassifyUnpromptedAsk — an OUTWARD action keeps surfacing (the safety boundary the blocklist preserves):');
ok(surface('Want me to send the draft to the committee?'), '"send …" is an external side effect → surface (needs his sign-off)');
ok(surface('Should I email Sarah the numbers?'), '"email …" is outward → surface');
ok(surface('Want me to post it?'), '"post it" is outward/publish → surface');
ok(surface('Should I delete the stale roster?'), '"delete …" is destructive → surface');
ok(surface('Want me to schedule the call with them?'), '"schedule …" commits externally → surface');

console.log('\nclassifyUnpromptedAsk — a GENUINE question or info-share → SURFACE (preserve):');
ok(surface('Which cycle did you mean — 2022 or 2024?'), 'disambiguation "2022 or 2024?" → surface (genuine)');
ok(surface('Do you want the brief formal or casual?'), 'preference "formal or casual?" → surface (genuine)');
ok(surface('You got a new email from Sarah about the budget.'), 'a plain info-share (no "?") → surface');
ok(surface("I've been thinking about the Gaetz numbers."), 'a musing statement → surface (not a nag)');
ok(surface('Want me to pull up the parish doc, or should I wait until you review it?'),
  'self-work offer BUT carries a genuine decision ("or should I wait until you review") → surface');
ok(surface('Want me to run it by the committee first?'), '"run it by the committee" is outward-facing approval, not self-work → surface');
ok(surface('Should we go with the formal tone or keep it casual?'), '"…or keep it casual?" → surface (genuine)');
ok(surface(''), 'empty → surface (nothing to internalize)');
ok(surface('Want me to hold off on it?'), 'an offer to STOP ("hold off") is a genuine "should I pause?" check → surface');

console.log('\nclassifyUnpromptedAsk — the injectable model-confirm seam overrides the regex:');
ok(surface('Want me to pull it up?', { confirm: () => false }), 'confirm()=false → surface (model vetoes the regex)');
ok(act('Want me to pull it up?', { confirm: () => true }), 'confirm()=true → act');

console.log('\ntensionToInquiry — strips the offer/self-work clause into a durable line-of-inquiry seed:');
{
  const seed = ia.tensionToInquiry('Parish clean-up doc stalled, want me to pull it up?');
  ok(seed && seed.length >= 15 && /parish clean-up doc stalled/i.test(seed), `seed carries the tension subject: "${seed}"`);
  ok(!/want me to|pull it up/i.test(seed), 'seed drops the "want me to pull it up" permission clause');
}
ok(ia.tensionToInquiry('want me to pull it up?') === null, 'a bare offer with no subject → null (nothing to pursue)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
