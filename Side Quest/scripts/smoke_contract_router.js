'use strict';
/* smoke_contract_router.js — CONTRACT AGENT slice 3 (docs/CONTRACT_AGENT_SPEC_2026-08-22.md §8)
 * + the yea-misroute cure (conversation-quality audit #3). Pure verdict matrix + wiring greps. */
const rt = require('../lib/contract_router');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── affirmationLead: the yea-misroute cure ──────────────────────────────────────────────────────
ok(JSON.stringify(rt.affirmationLead('Yea more details')) === JSON.stringify({ lead: 'Yea', rest: 'more details' }),
  '⭐ AUDIT #3: "Yea more details" routes on "more details", never on "yea"');
ok(rt.affirmationLead('yes').rest === '', 'a bare affirmation keeps rest empty (the greenlight arcs own it)');
ok(rt.affirmationLead('Sure, add the taxes angle too').rest === 'add the taxes angle too', 'lead + comma strips clean');
ok(rt.affirmationLead('yesterday was fine').lead === '', '"yesterday" never reads as a "yes" lead (word boundary)');

// ── verdict fixtures ────────────────────────────────────────────────────────────────────────────
const A = { contractId: 'ct-a', status: 'open', title: 'LA data-center community benefits — slide table', topicTokens: ['meta', 'applied', 'digital', 'louisiana', 'richland', 'rapides'], entities: ['Meta Hyperion', 'Applied Digital Delta Forge'] };
const B = { contractId: 'ct-b', status: 'open', title: 'Anti-China surveillance report', topicTokens: ['china', 'surveillance', 'procurement'], entities: [] };
const Q1 = { questionId: 'q1', contractId: 'ct-a', text: 'is the company waterless-cooling claim enough for the water cell?', assumption: 'use it, labeled as a company claim', askedTs: 100 };
const Q2 = { questionId: 'q2', contractId: 'ct-b', text: 'include the vetoed bills?', assumption: 'exclude vetoed', askedTs: 200 };
const now = 10 * 60 * 1000;

// answers
ok(rt.verdict({ text: 'yea', contracts: [A], openQuestions: [Q1], now }).kind === 'answer', 'bare "yea" + ONE open question → answer (never a vocabulary tangent)');
ok(rt.verdict({ text: 'yes', contracts: [A, B], openQuestions: [Q1, Q2], now }).kind === 'clarify', 'bare "yes" + TWO open questions → clarify, never guess');
{
  const v = rt.verdict({ text: 'Yes, use the company claim but label it clearly', contracts: [A, B], openQuestions: [Q1, Q2], now });
  ok(v.kind === 'answer' && v.questionId === 'q1', 'an affirmation-led content answer binds to the overlapping question');
}
ok(rt.verdict({ text: 'nope', contracts: [A], openQuestions: [Q1], now }).kind === 'answer', 'a bare negation answers too');

// steering
{
  const v = rt.verdict({ text: 'add the ratepayer angle to the meta louisiana table', contracts: [A, B], openQuestions: [], now });
  ok(v.kind === 'steering' && v.contractId === 'ct-a', 'exact-token steering binds the right contract among several');
}
{
  const v = rt.verdict({ text: 'also add ratepayer impacts, taxes, and bonuses', contracts: [A], openQuestions: [], lastBinding: { inboxId: 3, contractId: 'ct-a', ts: now - 10 * 60 * 1000 }, now });
  ok(v.kind === 'steering' && v.contractId === 'ct-a', '⭐ THE LIVE SHAPE: a zero-token scope-add binds via fresh context when ONE contract runs');
}
ok(rt.verdict({ text: 'add milk to the grocery list', contracts: [A], openQuestions: [], now }).kind === 'none', 'the grocery guard: zero signals never hijack the contract');
ok(rt.verdict({ text: 'what should we add about rapides?', contracts: [A], openQuestions: [], now }).kind === 'none', 'a question is never steering (the recall doors own it)');
{
  const v = rt.verdict({ text: 'fold the china surveillance angle into the meta louisiana work', contracts: [A, B], openQuestions: [], now });
  ok(v.kind === 'clarify' && v.candidates.length === 2, 'a tied two-contract bind CLARIFIES, never guesses');
}

// late answers (slice 4, §9): expired questions still bind — content only, scoped rework downstream
const QX = { questionId: 'qx', contractId: 'ct-a', slotId: 'rapides-water', text: 'is the company waterless-cooling claim enough for the water cell?', assumption: 'use it, labeled as a company claim', askedTs: 50 };
{
  const v = rt.verdict({ text: 'Use the parish utility filings for the water cell, not the company claim', contracts: [A], openQuestions: [], expiredQuestions: [QX], now });
  ok(v.kind === 'answer' && v.late === true && v.questionId === 'qx' && v.slotId === 'rapides-water', '⭐ SLICE 4: a content answer to an EXPIRED question binds late, carrying the slot for the scoped re-open');
}
ok(rt.verdict({ text: 'yes', contracts: [A], openQuestions: [], expiredQuestions: [QX], now }).kind !== 'answer', 'a bare "yes" NEVER binds an expired question (settled history)');
{
  const v = rt.verdict({ text: 'Yes, use the company claim but label it clearly', contracts: [A], openQuestions: [Q1], expiredQuestions: [QX], now });
  ok(v.kind === 'answer' && !v.late && v.questionId === 'q1', 'an OPEN question outranks an expired twin');
}
ok(rt.verdict({ text: 'is the waterless cooling claim enough for the water cell?', contracts: [A], openQuestions: [], expiredQuestions: [QX], now }).kind !== 'answer', 'a question-shaped turn asks ABOUT the work — never a late answer');
ok(rt.verdict({ text: 'where are we on the water cell claim?', contracts: [A], openQuestions: [], expiredQuestions: [QX], now }).kind === 'status', 'a status ask near an expired question stays status');

// status
{
  const v = rt.verdict({ text: 'where are we on the data-center benefits work?', contracts: [A, B], openQuestions: [], now });
  ok(v.kind === 'status' && v.contractId === 'ct-a', 'a progress ask reads the store (status), never steers and never invents');
}

// repair
{
  const v = rt.verdict({ text: 'no that was for the china report', contracts: [A, B], openQuestions: [], lastBinding: { inboxId: 7, contractId: 'ct-a', ts: now - 60 * 1000 }, now });
  ok(v.kind === 'repair' && v.tombstoneId === 7 && v.contractId === 'ct-b', '⭐ MISROUTE REPAIR: "no, that was for X" tombstones the binding and rebinds the named work in one turn');
}
{
  const v = rt.verdict({ text: 'nope, wrong one', contracts: [A, B], openQuestions: [], lastBinding: { inboxId: 7, contractId: 'ct-a', ts: now - 60 * 1000 }, now });
  ok(v.kind === 'repair' && v.contractId === null, 'an unnamed repair unbinds and asks');
}
ok(rt.verdict({ text: 'no that was for the china report', contracts: [A, B], openQuestions: [], lastBinding: { inboxId: 7, contractId: 'ct-a', ts: now - 6 * 60 * 1000 }, now }).kind !== 'repair', 'the repair window closes at 5 min (an old binding is settled history)');

// boundaries
ok(rt.verdict({ text: 'add the taxes angle', contracts: [], openQuestions: [], now }).kind === 'none', 'no contracts → none');
ok(rt.verdict({ text: 'add the meta louisiana angle', contracts: [{ ...A, status: 'closed' }], openQuestions: [], now }).kind === 'none', 'a closed contract never binds STEERING');
{
  const v = rt.verdict({ text: 'where are we on the meta louisiana data-center work?', contracts: [{ ...A, status: 'closed' }], openQuestions: [], now });
  ok(v.kind === 'status' && v.contractId === 'ct-a', '⭐ P119 FINDING: a status ask about JUST-CLOSED work reads the store ("done, here\'s what landed"), never falls to doc recall');
}

// ── wiring greps ────────────────────────────────────────────────────────────────────────────────
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/CONTRACT ROUTER \(slice 3, spec §8\)/.test(src), 'wiring: the router door sits in the turn flow');
  ok(/CONTRACT STEERING BOUND/.test(src) && /ECHO THE BINDING/.test(src), 'wiring: steering posts to the inbox and the reply echoes the binding');
  ok(/CONTRACT STATUS \(measured/.test(src) && /never invent progress/.test(src), 'wiring: status asks answer from measured store state');
  ok(/contractBinding && turnRoute\.route !== 'converse'/.test(src), 'wiring: a bound turn pins converse — no second research run beside the contract');
  ok(/affirmation lead stripped for routing/.test(src) && /_affLead\.rest \|\| userMessage/.test(src), 'wiring: the route cascade + judge see the stripped text (the yea cure)');
  ok(/CONTRACT LATE ANSWER BOUND/.test(src) && /reopenFromLateAnswer/.test(src), 'wiring: a late answer re-opens only the affected slot through the store primitive');
  ok(/expiredQuestions: _expQs/.test(src), 'wiring: the router sees expired questions from the recent-contract sweep');
  ok(/suppressed — turn is contract-bound/.test(src) && /focusLib\.isDirected\(f\) && contractBinding/.test(src), 'wiring: a contract-bound turn SUPPRESSES the correction net (the p118 scope-add competition)');
}

console.log(`\nsmoke_contract_router: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
