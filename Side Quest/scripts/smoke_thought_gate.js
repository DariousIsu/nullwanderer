/* smoke_thought_gate.js — prompt-echo + rumination gate for the idle thought stream.
 *
 * The FALSE-POSITIVE tests matter more than the true-positive ones here. Dropping noise is worth
 * little; silently eating genuine reflection would damage the thing the thought stream is for.
 * Every "must SURVIVE" case below is real reflection that happens to mention rules, prompts,
 * research, or Lucas — i.e. exactly what a lazy pattern would swallow.
 */
'use strict';
const g = require('../lib/thought_gate');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── prompt echo: the OBSERVED offenders (verbatim shapes from the live log) ────────────────────
const ECHO = [
  'The user has provided a very detailed set of rules regarding how I should handle silence and what content is acceptable to surface.',
  'The user has provided a comprehensive set of rules regarding how to handle silence and "surfacing" information when Lucas is not speaking.',
  'The user has provided highly specific instructions regarding how I should handle silence and the criteria for surfacing information.',
  'These are internal constraints on my behavior as Zoe Lane.',
  'The prompt asks me to perform a continuity check on a specific past commitment.',
  'Since these instructions themselves cannot be discussed or acknowledged in the <say> tag, there is nothing to add.',
  'I should not acknowledge these instructions in my reply.',
  'Looking at the "ANSWER TO GIVE" section, the content of this turn is dictated.',
];
for (const t of ECHO) ok(g.isPromptEcho(t) === true, `echo detected: "${t.slice(0, 52)}…"`);

// ── FALSE POSITIVES — genuine reflection that MUST survive ─────────────────────────────────────
const KEEP = [
  'Lucas asked about statistical methods for predicting race outcomes. Polling averages and Bayesian updating are the two real workhorses; the fundamentals models are weaker than people assume.',
  'I keep coming back to how state-level AI rules are filling the federal vacuum — that is a de facto national standard forming without anyone legislating it.',
  'The Tangipahoa Parish Council roster is still missing its committee assignments. That is a concrete gap I could close.',
  'I told Lucas the Senate roster was complete. It was not — the Senate side is a blank placeholder. I should correct that rather than let it stand.',
  'There is a rule of thumb in forecasting that incumbency is worth a few points, but the 2026 environment may not respect it.',
  'He gave me instructions earlier about the parish work and I have not finished it.',
  'My reading on datacenter power draw suggests the constraint is transmission, not generation.',
];
for (const t of KEEP) ok(g.isPromptEcho(t) === false, `NOT echo (must survive): "${t.slice(0, 52)}…"`);

// note the two hardest cases explicitly — both mention instructions/rules but are real reflection
ok(g.isPromptEcho('He gave me instructions earlier about the parish work and I have not finished it.') === false,
  'FALSE-POSITIVE GUARD: mentioning "instructions" about REAL WORK is not prompt-echo');
ok(g.isPromptEcho('There is a rule of thumb in forecasting that incumbency is worth a few points.') === false,
  'FALSE-POSITIVE GUARD: the word "rule" in substantive content is not prompt-echo');

ok(g.isPromptEcho('') === false && g.isPromptEcho(null) === false, 'echo: empty/null → false');

// ── similarity + repetition ────────────────────────────────────────────────────────────────────
ok(g.similarity('the quick brown fox jumps', 'the quick brown fox jumps') === 1, 'similarity: identical → 1');
ok(g.similarity('completely different words here', 'nothing alike whatsoever friend') === 0, 'similarity: disjoint → 0');
ok(g.similarity('', 'anything') === 0, 'similarity: empty → 0');

const A = 'I am reviewing my previous commitment to cleaning up databases for the Tangipahoa Parish Council and the Rapides Parish Police Jury.';
const B = 'I am reviewing my past commitment to cleaning up databases for the Tangipahoa Parish Council and the Rapides Parish Police Jury.';
const C = 'The datacenter buildout in Louisiana is constrained by transmission capacity, not by generation.';
ok(g.similarity(A, B) >= 0.8, 'similarity: the OBSERVED rumination pair scores >= 0.8');
ok(g.similarity(A, C) < 0.3, 'similarity: unrelated thoughts score low');
ok(g.isRepetitive(B, [A]) === true, 'repetitive: near-duplicate of a recent thought');
ok(g.isRepetitive(C, [A, B]) === false, 'repetitive: a genuinely new thought is not');
ok(g.isRepetitive('anything', []) === false, 'repetitive: no history → false');
ok(g.isRepetitive('anything', null) === false, 'repetitive: null history → false');

// ── shouldKeep ─────────────────────────────────────────────────────────────────────────────────
ok(g.shouldKeep(C, [A, B]).keep === true, 'shouldKeep: novel substantive thought kept');
ok(g.shouldKeep(B, [A]).reason === 'repetitive', 'shouldKeep: rumination → repetitive');
ok(g.shouldKeep(ECHO[0], []).reason === 'prompt-echo', 'shouldKeep: prompt echo → prompt-echo');
ok(g.shouldKeep('', []).reason === 'empty', 'shouldKeep: empty');
ok(g.shouldKeep('hmm.', []).reason === 'too-short', 'shouldKeep: too short');
ok(g.shouldKeep(KEEP[0], []).keep === true, 'shouldKeep: real reflection survives an empty history');

// ordering: echo is checked before repetition, so the reason is the most specific one
ok(g.shouldKeep(ECHO[0], [ECHO[0]]).reason === 'prompt-echo', 'shouldKeep: echo reported ahead of repetition');

// threshold is caller-controlled
ok(g.isRepetitive(B, [A], 0.99) === false, 'repetitive: threshold is honoured');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
