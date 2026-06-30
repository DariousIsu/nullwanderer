/* Smoke: lib/records_interp — the INWARD fallback detector + cloud prompt. Proves a question about our
 * held research that misses the fixed intents is recognized (so the cloud reads our records) instead of
 * falling through to a web search, and that the prompt hard-forbids inventing / web-searching. Pure. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_records_interp.js
 */
'use strict';
const ri = require('../lib/records_interp');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- isRecordsQuestion: catches the evaluative/novel phrasings the regex menu misses ---
ok(ri.isRecordsQuestion('which do we have the most complete record on') === true, '"most complete record" → records question');
ok(ri.isRecordsQuestion('where is our coverage thin') === true, '"our coverage thin" → records question');
ok(ri.isRecordsQuestion('compare our profiles of Heritage and Cato') === true, '"compare our profiles" → records question');
ok(ri.isRecordsQuestion("what's in our dossier so far") === true, '"in our dossier" → records question');
ok(ri.isRecordsQuestion('which orgs are we weakest on') === true, '"weakest on" → records question (eval + ours)');
ok(ri.isRecordsQuestion('how thorough is our research on energy groups') === true, '"how thorough is our research" → records question');
// --- and does NOT hijack general turns ---
ok(ri.isRecordsQuestion('what time is it') === false, '"what time is it" → NOT a records question');
ok(ri.isRecordsQuestion('do you know the weather today') === false, '"do you know the weather" → NOT a records question');
ok(ri.isRecordsQuestion('tell me a joke') === false, 'chit-chat → NOT a records question');
ok(ri.isRecordsQuestion('hi') === false, 'too short → NOT a records question');

// --- buildRecordsPrompt: grounding contract + completeness annotations + the question ---
const sections = [
  { heading: 'Heritage Foundation', body: '- **Key people:** Roger Severino – VP\n- **Contact:** https://heritage.org' },
  { heading: 'Cato Institute', body: '- **Key people:** not found\n- **Contact:** not found' }
];
const msgs = ri.buildRecordsPrompt({ question: 'which is the most complete?', goal: 'right-of-center think tanks', sections });
ok(Array.isArray(msgs) && msgs.length === 2, 'prompt = [system, user]');
ok(/ONLY from the research records/i.test(msgs[0].content), 'system: answer ONLY from our records');
ok(/do NOT.*(?:invent|search the web|look)/is.test(msgs[0].content), 'system: forbids inventing / web search');
ok(/\[.*data points.*not-found\]/i.test(msgs[1].content), 'records are annotated with the completeness measure');
ok(/## Heritage Foundation/.test(msgs[1].content) && /## Cato Institute/.test(msgs[1].content), 'all records included');
ok(/which is the most complete/i.test(msgs[1].content), 'the question is carried into the prompt');
ok(/right-of-center think tanks/i.test(msgs[1].content), 'the task/goal is included for context');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
