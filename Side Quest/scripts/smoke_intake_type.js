/**
 * INTAKE TYPING (2026-08-13): only work-shaped turns may reach the open-thread goal extractor.
 * Pins the live incidents: the 10:00 complaint ("you were supposed to…") and the finalize verb
 * ("finish the paper on applied digital") must NEVER mint; a real work-ask (even in question form)
 * and an ambiguous statement must still fail OPEN to the extractor.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_intake_type.js
 */
const { classify } = require('../lib/intake_type');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };
const t = (msg, wantType, wantMints) => {
  const r = classify(msg);
  ok(`"${msg.slice(0, 58)}" → ${r.type}/${r.mints} (want ${wantType}/${wantMints}, via ${r.via})`,
    r.type === wantType && r.mints === wantMints);
};

// The live complaint that nearly re-armed the hold — a reference to work, never new work.
t('you were supposed to get back to work on that paper almost 4 hours ago, at 0630 and its still not done yet', 'reported', false);
t("why isn't the applied digital paper done yet", 'reported', false);
// Control orders — their lanes change state; a thread beside them is the duplicate reflex.
t("let's put all work projects and tasks on hold until 0630", 'control', false);
t('finish the paper on applied digital', 'control', false);
// Pure questions and acks — conversation, not assignment.
t("what's the weather in Monroe tonight?", 'question', false);
t('any update on the forecast suite', 'question', false);
t('thanks, looks great', 'ack', false);
t('good morning Zo', 'ack', false);
// Real work-asks mint — including question-shaped ones.
t('research the applied digital data centers in Ellendale', 'work-ask', true);
t('can you compile the Louisiana parish leadership list?', 'work-ask', true);
t('the Monroe hardware budget needs to be finished by friday', 'work-ask', true);
// MIXED turns (pre-land sweep Q2): a complaint sentence must not swallow a work sentence beside it.
t("why isn't the parish list done? also add the Georgia runoff to the tracker", 'work-ask', true);
t('you were supposed to finish the paper at 0630. anyway, research the CoreWeave deal for me', 'work-ask', true);
// …but a complaint + cue-less venting still vetoes (nothing was assigned).
t('you were supposed to finish it at 0630. this is really frustrating honestly', 'reported', false);
// Ambiguity fails OPEN — the extractor's own filter stays as the second gate.
t("I've been thinking a lot about how the midterms are shaping up this cycle in the southern states", 'open', true);

// THE REFINEMENT ROUTE (grove audit 08-14): the live 11:26 turn — an explicit ADDITION to the
// Ohio-legislators thread — minted #3883/#3884 beside it. Pure route check with a fake pool.
const ot = require('../lib/open_threads');
const pool = [
  { id: 3881, content: "identify Ohio legislators to anchor Lucas's Energize America event" },
  { id: 3700, content: 'plan the Monroe hardware budget spreadsheet' },
];
const LIVE_REFINE = 'Hey, so something you might want to add to the Ohio legislators to anchor the Energize America event is look at districts with data centers and power generation, and also the county commissioners';
const r1 = ot.routeRefinement(LIVE_REFINE, pool);
ok('the live 11:26 refinement routes to the ORIGINAL thread (#3881), not a mint', r1 && r1.targetId === 3881);
ok('a refinement phrase with NO matching thread fails open (extractor decides)',
  ot.routeRefinement('you might want to add a section on quantum computing exports to Malaysia somewhere', [pool[1]]) === null);
ok('a plain work-ask is NOT a refinement (no refine phrase)',
  ot.routeRefinement('research the applied digital data centers in Ellendale', pool) === null);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
