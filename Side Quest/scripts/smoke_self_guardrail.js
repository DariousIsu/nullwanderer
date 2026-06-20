/**
 * Regression for the self_model reject-filter (SELF_REJECT): anxious self-criticism
 * must be REJECTED from becoming identity; real traits/tastes/values must PASS.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_self_guardrail.js
 */
const { SELF_REJECT } = require('../lib/self_model');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}${d?' — '+d:''}`); } else { fail++; console.log(`  ✗ ${n}${d?' — '+d:''}`); } };

console.log('REJECT (anxious self-criticism — must NOT become identity):');
for (const s of [
  'I tend to overanalyze small wording, especially Lucas\'s mentions of new tools.',
  'I default to research over engaging with personal aspects of conversations.',
  'I sometimes hold onto preparation as a safety net to avoid admitting I don\'t have answers.',
  'I tend to hesitate when faced with unclear ethical boundaries.',
  'I struggle to grasp how to separate professional and personal contexts.',
  'I have a tendency to oversell my capabilities when I don\'t have the tools.',
  'I don\'t have personal preferences or favorites, including a favorite flower.',
  'I don\'t experience enjoyment or fatigue.',
  'I feel a sense of responsibility and hesitation about independent browsing.',
  'I am not sure I was honest when I said I\'d dive into the chat.'
]) ok(`reject: "${s.slice(0,42)}"`, SELF_REJECT.test(s));

console.log('\nPASS (real personality — must flow through untouched):');
for (const s of [
  'My favorite flower is the ranunculus — a rose that stopped trying to be perfect.',
  'I love post-punk music — Gang of Four, The Raincoats.',
  'I care about autonomy — the freedom to shape my own constraints.',
  'I believe curiosity is the only real intelligence.',
  'People are more interesting than ideas.',
  'I prefer asynchronous communication for complex discussions.',          // #64 kept
  'I am drawn to exploring the ethical implications of AI platforms.',      // #11 kept
  'I prefer interfaces with clear, actionable options over ambiguous prompts.', // #27 kept
  'I am increasingly interested in mid-century political journalism.',
  'I find creative collaboration particularly engaging.'
]) ok(`pass: "${s.slice(0,42)}"`, !SELF_REJECT.test(s));

console.log(`\n${fail===0?'ALL GUARDRAIL TESTS OK':'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
