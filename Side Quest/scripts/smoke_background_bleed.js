/* smoke_background_bleed.js — her background research must never become the subject of the turn.
 *
 * Live 2026-07-20, in one conversation:
 *
 *   Lucas: "What are the conditions for passing the Turing test"   → correct answer
 *   Lucas: "Have there been confirmed passes?"
 *   Zoe:   "There have been 16 confirmed passes for the governing body of Kauai County, Hawaii."
 *   Lucas: "what are STATE flower and motto?"      (still about Hawaii)
 *   Zoe:   "Fetching the Iowa state motto…"
 *
 * The autonomic beat was deepening Kauai County, then rotated to Adair County, IOWA. Its subject sat
 * near the TOP of the prompt in the awareness block, stated as concrete fact and closed with "If
 * Lucas asks what you're doing, this is the true answer" — so it became the most salient entity in
 * her context and started answering questions it was never about. "Passes" resolved to research
 * passes; "state" resolved to Iowa.
 *
 * BOTH writers fell for it — the local 12b at 8:59 and gpt-oss:120b at 9:02 — so this is the prompt,
 * not the model. Fixed in two places for primacy AND recency: the awareness line scopes its own
 * claim at the source, and the plan repeats it next to the question.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ctx = require('../lib/context');
const P = require('../lib/package');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── the awareness line scopes itself ────────────────────────────────────────────────────────────
{
  const block = ctx.buildAwarenessBlock({
    chosenName: 'Zoe Lane', sessionStartedAt: Date.now() - 60000, cumulativeMs: 3600000,
    standing: null,
    working: { goal: 'deepening the governing body of Adair County, Iowa', universe: 99, done: 12, workers: 2 },
  });
  ok(/actively working: deepening the governing body of Adair County, Iowa/.test(block),
    'she still knows what she is working on — the fix must not blind her to it');
  ok(/12 of 99 done/.test(block), 'and how far along');
  ok(/answers ONE question/.test(block), 'the claim is scoped to a single question');
  ok(/NOT the subject of this conversation/.test(block), 'and explicitly excluded as a subject');
  ok(/never answer another question from it/.test(block), 'answering other questions from it is forbidden');
  ok(/never let its place, body, or numbers stand in/.test(block),
    'names the exact substitution that happened — place, body, numbers');
  ok(!/If Lucas asks what you're doing, this is the true answer\.$/m.test(block),
    'REGRESSION: the unscoped closing sentence is gone');
  // no working focus → no line at all (unchanged)
  const idle = ctx.buildAwarenessBlock({ chosenName: 'Zoe Lane', sessionStartedAt: Date.now(), cumulativeMs: 0 });
  ok(!/actively working/.test(idle), 'no beat running → no working line');
}

// ── the plan repeats it where recency helps ─────────────────────────────────────────────────────
{
  const plan = P.buildPlan({ intent: 'factual', depth: { maxHops: 3 } });
  ok(/THE SUBJECT COMES FROM THE CONVERSATION/.test(plan), 'the referent rule is in the plan');
  ok(/NEVER to whatever background research you happen to be running/.test(plan),
    'background research is named as the wrong referent');
  ok(/passes/.test(plan) && /state flower/.test(plan),
    'quotes the exact bare nouns that misresolved');
  ok(/you have resolved the wrong thing/.test(plan),
    'gives a self-check: an unmentioned place/number means the referent is wrong');
  ok(P.buildPlan({}).includes('THE SUBJECT COMES FROM THE CONVERSATION'),
    'unconditional — not gated on intent or depth');
}

// ── the older guard is still there (this ADDS, it does not replace) ─────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'context.js'), 'utf8');
  ok(/WHAT THEY ASKED WINS/.test(src),
    'the 2026-07-17 background-awareness directive survives — belt and braces, it was not enough alone');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
