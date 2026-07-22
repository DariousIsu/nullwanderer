/* Smoke: the CLOUD OPERATOR agent loop (lib/operator). Deterministic: injected `complete` (scripted
 * cloud steps) + injected tool executors. No model/network/db.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_operator.js
 */
'use strict';
const op = require('../lib/operator');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // --- parseAction ---
  ok(op.parseAction('{"thought":"x","action":{"tool":"web_search","args":{"query":"oil"}}}').action.tool === 'web_search', 'parses an action step');
  ok(op.parseAction('{"thought":"x","final":"done"}').final === 'done', 'parses a final step');
  ok(op.parseAction('sure, here you go {"thought":"a","final":"hi"} ok') !== null, 'tolerates surrounding prose');
  ok(op.parseAction('no json here') === null, 'no JSON → null (caller treats prose as the answer)');
  // The greedy-span regression: prose braces BEFORE the real step used to poison first-{…last-} and
  // the garbled step was voiced as the answer. Balanced scan skips them.
  ok(op.parseAction('Let me weigh {the options} first. {"thought":"ok","action":{"tool":"recall","args":{"query":"x"}}}').action.tool === 'recall', 'prose braces before the step no longer poison the parse');
  ok(op.parseAction('{"rows":[1,2]} then {"final":"the answer"}').final === 'the answer', 'a parseable NON-step blob is skipped whole, the real step is found');
  ok(op.parseAction('{"final":"truncated mid-strin') === null, 'unbalanced/truncated JSON → null (repair path, not a voiced fragment)');
  ok(op.looksLikeJsonStep('{"action":{"tool":"x"}}') && !op.looksLikeJsonStep('Just a friendly hello.'), 'looksLikeJsonStep separates attempted steps from genuine prose');

  // --- ONE repair reprompt on a malformed ATTEMPTED step (genuine prose still passes straight through) ---
  let rs = 0;
  const repairScript = [
    'I will search now: {"thought":"go","action":{"tool":"web_search","args":{"query":"oil"',   // truncated → unparseable, but clearly an attempted step
    '{"thought":"go","action":{"tool":"web_search","args":{"query":"oil"}}}',                    // the repaired re-emit
    '{"final":"repaired and finished"}',
  ];
  const rr = await op.runOperator({ userMessage: 'x', deps: { complete: async () => ({ text: repairScript[rs++] }), tools: { web_search: async () => 'ok' } }, maxSteps: 4 });
  ok(rr && rr.answer === 'repaired and finished' && rr.steps.length === 1 && rr.steps[0].tool === 'web_search', 'malformed attempted step → ONE repair reprompt → tool still runs (not voiced as the answer)');

  // --- multi-step loop: web_search → echo → final, executing real (mock) tools ---
  const calls = [];
  const tools = {
    web_search: async (a) => { calls.push('web_search:' + a.query); return 'Oil is $80/bbl today.'; },
    echo: async (a) => { calls.push('echo:' + a.need); return 'LAMP has 42 members in FL.'; },
    recall: async () => 'nothing in memory',
  };
  const script = [
    '{"thought":"need price","action":{"tool":"web_search","args":{"query":"oil price"}}}',
    '{"thought":"need our data","action":{"tool":"echo","args":{"need":"LAMP members in Florida"}}}',
    '{"thought":"have both","final":"Oil is $80/bbl, and LAMP has 42 members in Florida."}',
  ];
  let si = 0;
  const complete = async () => ({ text: script[si++] });
  const r = await op.runOperator({ userMessage: 'oil price and our LAMP florida count', deps: { complete, tools }, maxSteps: 6 });
  ok(r && /\$80/.test(r.answer) && /42 members/.test(r.answer), 'loop produces the grounded final answer');
  ok(r.steps.length === 2 && r.toolsUsed.join(',') === 'web_search,echo', 'executed BOTH tools in order before answering');
  ok(calls.includes('web_search:oil price') && calls.includes('echo:LAMP members in Florida'), 'passed the model-chosen args to the executors');

  // --- unknown tool → error fed back (not a crash), loop continues to a final ---
  let s2 = 0;
  const script2 = ['{"action":{"tool":"nope","args":{}}}', '{"final":"recovered and answered"}'];
  const r2 = await op.runOperator({ userMessage: 'x', deps: { complete: async () => ({ text: script2[s2++] }), tools: {} }, maxSteps: 4 });
  ok(r2.answer === 'recovered and answered' && /no tool named/i.test(r2.steps[0].result), 'unknown tool → error string fed back, loop recovers');

  // --- tool throws → captured as ERROR, never crashes ---
  let s3 = 0;
  const script3 = ['{"action":{"tool":"web_search","args":{"query":"q"}}}', '{"final":"done despite error"}'];
  const r3 = await op.runOperator({ userMessage: 'x', deps: { complete: async () => ({ text: script3[s3++] }), tools: { web_search: async () => { throw new Error('net down'); } } }, maxSteps: 4 });
  ok(/ERROR: net down/.test(r3.steps[0].result) && r3.answer === 'done despite error', 'tool exception captured + loop continues');
  ok(/UNSATISFIED/.test(r3.steps[0].result), 'a failed result carries the mechanical change-approach signal');

  // --- empty result → UNSATISFIED marker (absence is a signal, not an answer) ---
  let s3b = 0;
  const script3b = ['{"action":{"tool":"localdb","args":{"sql":"SELECT 1"}}}', '{"final":"adjusted"}'];
  const r3b = await op.runOperator({ userMessage: 'x', deps: { complete: async () => ({ text: script3b[s3b++] }), tools: { localdb: async () => 'no rows' } }, maxSteps: 4 });
  ok(/UNSATISFIED/.test(r3b.steps[0].result), '"no rows" carries the marker — the next step must confront it');
  const rOk = await op.runOperator({ userMessage: 'x', deps: { complete: async () => ({ text: '{"final":"fine"}' }), tools }, maxSteps: 2 });
  ok(rOk.answer === 'fine', 'a substantive result carries NO marker (sanity)');

  // --- plain prose (no JSON) → treated as the answer ---
  const r4 = await op.runOperator({ userMessage: 'hi', deps: { complete: async () => ({ text: 'Just a friendly hello.' }), tools }, maxSteps: 3 });
  ok(r4.answer === 'Just a friendly hello.' && r4.steps.length === 0, 'prose reply with no tool → direct answer, no steps');

  // --- runs out of steps → forces a final answer from gathered work ---
  let s5 = 0;
  const always = async () => ({ text: s5++ < 2 ? '{"action":{"tool":"recall","args":{"query":"x"}}}' : 'Final synthesis from what I gathered.' });
  const r5 = await op.runOperator({ userMessage: 'x', deps: { complete: always, tools }, maxSteps: 2 });
  ok(r5.answer && /Final synthesis/.test(r5.answer), 'out of steps → forced final answer (no infinite loop)');

  // --- isDirectedTask: assignments (in-turn completion budget) vs quick questions (snappy) ---
  ok(op.isDirectedTask('make a list of left-of-center think tanks'), '"make a list" → directed task');
  ok(op.isDirectedTask('research and compile the major AI labs'), '"research and compile" → directed task');
  ok(op.isDirectedTask('put together a rundown of our LAMP chapters'), '"put together a rundown" → directed task');
  ok(op.isDirectedTask('find me a good documentary on neuromorphics'), '"find me" → directed task');
  ok(!op.isDirectedTask('what is the price of oil?'), 'a quick question is NOT a directed task (stays snappy)');
  ok(!op.isDirectedTask('how are you doing?'), 'small talk is not a directed task');
  // PAST-TENSE references are NOT new assignments (the live mis-fire: spun a duplicate run + confab)
  ok(!op.isDirectedTask('you were doing research on right of center think tanks'), '"you were doing research…" → NOT a new task (past reference)');
  ok(!op.isDirectedTask("you've been researching the AI safety orgs"), '"you\'ve been researching…" → NOT a new task');
  ok(!op.isDirectedTask('we were working on the think tank project'), '"we were working on…" → NOT a new task');
  ok(!op.isDirectedTask('remember you were studying nuclear energy think tanks'), '"remember you were studying…" → NOT a new task');
  ok(op.isDirectedTask('research every right-of-center think tank for me'), 'a fresh "research … for me" IS still a directed task');
  ok(op.isDirectedTask('study the AI safety organizations'), 'a fresh "study …" IS still a directed task');

  // --- wall-clock budget: over maxMs → stop looping, force a final (no minutes-long block) ---
  let nowVal = 0; const nowFn = () => nowVal;
  let bs = 0;
  const budgetComplete = async () => { nowVal += 30000; return { text: bs++ < 2 ? '{"action":{"tool":"recall","args":{"query":"x"}}}' : 'forced final from gathered work' }; };
  const rb = await op.runOperator({ userMessage: 'x', deps: { complete: budgetComplete, tools, now: nowFn }, maxSteps: 10, maxMs: 45000 });
  ok(rb.answer && /forced final/.test(rb.answer) && rb.steps.length <= 2, 'wall-clock budget caps the loop + forces a final (no 2-minute block)');

  // --- no cloud (complete returns null) → null (caller falls back to local) ---
  ok((await op.runOperator({ userMessage: 'x', deps: { complete: async () => null, tools } })) === null, 'no cloud → null (fail-safe to local)');

  // --- parseSliceResult: the directed-driver anti-loop teeth (the Heritage-222× fix) ---
  const s_new = op.parseSliceResult('## The Cato Institute\nLibertarian think tank…\nCOVERED: The Cato Institute', ['Heritage Foundation', 'AEI']);
  ok(s_new.org === 'The Cato Institute' && s_new.isNew === true, 'a genuinely NEW org → isNew (counts as progress)');
  ok(/## The Cato Institute/.test(s_new.body) && !/COVERED:/.test(s_new.body), 'body keeps the findings, strips the COVERED control line');
  const s_dupe = op.parseSliceResult('## Heritage Foundation again\n…\nCOVERED:  heritage   foundation ', ['Heritage Foundation', 'AEI']);
  ok(s_dupe.isNew === false, 'a REPEAT org (case/space-insensitive) → NOT new (no progress → drives it onward / strikes out)');
  const s_done = op.parseSliceResult('ALL-COVERED', ['Heritage Foundation']);
  ok(s_done.done === true, 'ALL-COVERED with a non-empty covered set → done (closes the focus)');
  ok(op.parseSliceResult('ALL-COVERED', []).done === false, 'ALL-COVERED on an EMPTY set → NOT done (can\'t finish before starting)');
  ok(op.parseSliceResult('## Some Org\n…(no covered line)…', []).org === '' && op.parseSliceResult('…', []).isNew === false, 'a missing COVERED line → no org, not progress (no phantom advance)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
