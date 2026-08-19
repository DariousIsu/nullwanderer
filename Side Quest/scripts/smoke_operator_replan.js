'use strict';
/* Smoke: W3 operator replan guard (lib/operator + lib/chain_guard). A retrieval step that comes back
 * UNSATISFIED — or an EXACT repeat of one already tried this run — injects an analyze&replan directive
 * into the NEXT prompt (name what was tried, demand a DIFFERENT step). A productive step never does, and
 * a WRITE tool is never judged (the build lane must not be blocked). Deterministic: injected `complete`
 * that CAPTURES each prompt, + injected tools. No model/network/db.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_operator_replan.js
 */
const op = require('../lib/operator');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// drive runOperator with a scripted model; `prompts` captures each prompt the model was handed.
async function drive(script, tools, maxSteps = 6) {
  const prompts = [];
  let i = 0;
  const complete = async (messages) => { prompts.push(JSON.stringify(messages)); return { text: script[Math.min(i++, script.length - 1)] }; };
  const r = await op.runOperator({ userMessage: 'x', deps: { complete, tools }, maxSteps });
  return { r, prompts };
}

(async () => {
  // (1) a no-progress retrieval (empty result) → analyze&replan injected into the NEXT prompt
  {
    const { r, prompts } = await drive([
      '{"thought":"try","action":{"tool":"search","args":{"query":"womack phone"}}}',
      '{"thought":"again","action":{"tool":"search","args":{"query":"womack phone"}}}',   // exact repeat
      '{"final":"could not find it"}',
    ], { search: async () => 'no rows' });
    ok(/ANALYZE & REPLAN/.test(prompts[1] || ''), 'a no-progress retrieval injects analyze&replan into the next prompt');
    ok(/GENUINELY DIFFERENT|Do NOT re-issue/i.test(prompts[1] || ''), 'the replan names what was tried and demands a different step');
    ok(r && typeof r.answer === 'string', 'the loop still lands a final (never crashes)');
  }

  // (2) a PRODUCTIVE chain (real results, different args) → NEVER triggers replan
  {
    const { prompts } = await drive([
      '{"thought":"a","action":{"tool":"search","args":{"query":"oil price"}}}',
      '{"thought":"b","action":{"tool":"search","args":{"query":"gas price"}}}',
      '{"final":"done"}',
    ], { search: async (a) => `result for ${a.query}: $80/bbl` });
    ok(!/ANALYZE & REPLAN/.test(prompts.join('')), 'a productive chain (real results, different args) never triggers replan');
  }

  // (3) a repeated WRITE (create_*) is never judged — the build lane must not be blocked
  {
    const { prompts } = await drive([
      '{"thought":"save","action":{"tool":"create_contact","args":{"name":"X"}}}',
      '{"thought":"save2","action":{"tool":"create_contact","args":{"name":"X"}}}',   // repeat write, empty result
      '{"final":"saved"}',
    ], { create_contact: async () => '' });
    ok(!/ANALYZE & REPLAN/.test(prompts.join('')), 'a repeated WRITE (create_*) is never judged — no false replan on the build lane');
  }

  // (4) a fully no-progress re-hammer → replan fires on EACH dead-end step, and the run still lands a final
  {
    const { r, prompts } = await drive([
      '{"action":{"tool":"db_query","args":{"sql":"SELECT 1"}}}',
      '{"action":{"tool":"db_query","args":{"sql":"SELECT 1"}}}',
      '{"action":{"tool":"db_query","args":{"sql":"SELECT 1"}}}',
      '{"final":"honest miss"}',
    ], { db_query: async () => 'no rows' }, 6);
    const replanCount = prompts.filter((p) => /ANALYZE & REPLAN|STOP: you've tried/.test(p)).length;
    ok(replanCount >= 2, `a re-hammer gets replan/stop steering on each dead-end step (saw ${replanCount})`);
    ok(r && typeof r.answer === 'string', 'a fully no-progress run still lands a final, never hangs');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error('SMOKE ERROR:', e && e.message); process.exit(1); });
