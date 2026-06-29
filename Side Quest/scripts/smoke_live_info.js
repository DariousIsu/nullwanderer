/* Smoke: lib/curiosity live-info detection — isLiveInfoQuestion + deriveLiveQuery.
 * Pure string functions, fully deterministic (no DB / model / network).
 * This guards the chat-turn live-info safety net: when Lucas asks for up-to-the-minute
 * info and she emits no retrieval tag, the turn auto-runs ONE live lookup and answers.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_live_info.js
 */
const { isLiveInfoQuestion, deriveLiveQuery, detectCuriosity, isResearchCommand, deriveResearchSubject } = require('../lib/curiosity');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- POSITIVES: real live-info questions must trigger ---
ok(isLiveInfoQuestion('ok, can you tell me what the price of oil is right now'), 'price of oil right now → live (the logged failure)');
ok(isLiveInfoQuestion("what's the weather today"), 'weather today → live');
ok(isLiveInfoQuestion('how much is gold right now?'), 'gold price right now → live');
ok(isLiveInfoQuestion('can you check the latest news'), 'latest news → live');
ok(isLiveInfoQuestion('what is the current price of bitcoin'), 'current bitcoin price → live');
ok(isLiveInfoQuestion('what are the stock markets doing today'), 'markets today → live');
ok(isLiveInfoQuestion('pull up the current exchange rate for euros'), 'exchange rate → live');

// --- NEGATIVES: ordinary / timeless / chit-chat must NOT trigger ---
ok(!isLiveInfoQuestion('what do you remember about our meeting with Russ'), 'memory question → not live');
ok(!isLiveInfoQuestion('where does your name come from'), 'identity question → not live');
ok(!isLiveInfoQuestion('can you explain how STDP works'), 'concept question → not live');
ok(!isLiveInfoQuestion('I read the news this morning, it was grim'), 'statement, not a question → not live');
ok(!isLiveInfoQuestion('what is epistemology'), 'timeless "what is" → not live (no live domain)');
ok(!isLiveInfoQuestion('hey'), 'too short → not live');

// --- QUERY EXTRACTION: prefer her stated intent, else clean the user question ---
// Her stated intent (the actual log): "I want to know the current price of oil."
const cur = detectCuriosity('I want to know the current price of oil.');
ok(cur.triggered && /current price of oil/i.test(cur.query), 'her stated intent mined → "current price of oil"');

// Fallback: derive from the raw user question when she stated nothing.
const q1 = deriveLiveQuery('ok, can you tell me what the price of oil is right now');
ok(/price of oil/i.test(q1) && !/can you|tell me|right now/i.test(q1), 'derived query strips framing → "price of oil"');
const q2 = deriveLiveQuery("what's the weather in Chicago today?");
ok(/weather in chicago/i.test(q2) && !/\?|today/i.test(q2), 'derived weather query clean of "?"/"today"');

// --- RESEARCH COMMAND ("do some research then" → real lookup on the prior topic) ---
ok(isResearchCommand('do some research then'), '"do some research then" is a research command');
ok(isResearchCommand('look into it'), '"look into it" is a research command');
ok(isResearchCommand('can you dig into that'), '"dig into that" is a research command');
ok(isResearchCommand('read up on her'), '"read up on her" is a research command');
ok(!isResearchCommand('what do you think about it'), 'an opinion question is not a research command');
ok(!isResearchCommand('how are you'), 'small talk is not a research command');
// subject derived from the prior conversation (the command carries none); pronouns keep antecedent
const subj = deriveResearchSubject('do some research then', [
  'What else did you learn about Zoe Barnes?',
  'learn more about her personality, was she daring and aggressive, was she sexy, was she meek?',
  'do some research then'   // current command + a prior command are dropped
]);
ok(/zoe barnes/i.test(subj) && /personality|daring/i.test(subj), 'subject pulled from recent user turns (Zoe Barnes + personality)');
ok(!/do some research/i.test(subj), 'the command turns are excluded from the subject');
ok(deriveResearchSubject('research it', ['research it']) === null, 'no prior topic → null (nothing to look up)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
