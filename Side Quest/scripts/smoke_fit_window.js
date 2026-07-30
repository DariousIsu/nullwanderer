/* Smoke: lib/context.fitToWindow — the LOCAL lane's fit discipline (2026-07-30, "everything in
 * the thinking and in the chat seems to be getting truncated"). The chat prompt straddled num_ctx
 * 8192: just under → a 30-90 token reply sliver (daemon pinned at n_tokens=8191); just over →
 * ollama silently keeps the LAST half-window, killing the protocols/identity at the system HEAD.
 * Pins: oldest-history-first, system middle-cut (head+tail survive), final-message last resort,
 * honest report, never-throw.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_fit_window.js
 */
'use strict';
const { fitToWindow } = require('../lib/context');
const pkg = require('../lib/package');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const budget = pkg.inputBudgetChars({ num_ctx: 8192, num_predict: 1200 });
ok(budget > 10000 && budget < 8192 * 4, `budget derives from the shared package math (${budget}ch)`);

// --- under budget: untouched, no report ---
{
  const m = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }];
  const r = fitToWindow(m, { numCtx: 8192, numPredict: 1200 });
  ok(r.report === null && r.messages.length === 2 && r.messages[0].content === 'SYS', 'a fitting prompt passes through untouched');
}

// --- oldest history falls first; system and the live message survive whole ---
{
  const turn = 'x'.repeat(2000);
  const m = [{ role: 'system', content: 'HEAD-PROTOCOLS ' + 'i'.repeat(3000) + ' TAIL-HOWTOREPLY' }];
  for (let i = 0; i < 40; i++) m.push({ role: i % 2 ? 'assistant' : 'user', content: `turn${i} ${turn}` });
  m.push({ role: 'user', content: 'THE LIVE MESSAGE' });
  const r = fitToWindow(m, { numCtx: 8192, numPredict: 1200 });
  const total = r.messages.reduce((n, x) => n + x.content.length, 0);
  ok(total <= budget, `fits under budget (${total} <= ${budget})`);
  ok(r.report.droppedTurns > 0, `dropped ${r.report.droppedTurns} oldest turn(s)`);
  ok(!r.messages.slice(1, -1).some((x) => /^turn0 /.test(x.content)), 'turn0 (oldest) was the first to fall');
  ok(r.messages[r.messages.length - 1].content === 'THE LIVE MESSAGE', 'the live message survives whole');
  ok(/^HEAD-PROTOCOLS/.test(r.messages[0].content) && /TAIL-HOWTOREPLY$/.test(r.messages[0].content), 'system head and tail survive whole');
  ok(r.report.systemCut === 0, 'system untouched while dropping history sufficed');
}

// --- giant system: middle-cut with a visible marker; head and tail survive ---
{
  const m = [
    { role: 'system', content: 'PROTOCOLS-AT-HEAD ' + 'y'.repeat(budget * 2) + ' NUDGES-AT-TAIL' },
    { role: 'user', content: 'live' },
  ];
  const r = fitToWindow(m, { numCtx: 8192, numPredict: 1200 });
  ok(r.messages[0].content.length < budget * 2, `giant system cut (${r.report.systemCut}ch removed)`);
  ok(/^PROTOCOLS-AT-HEAD/.test(r.messages[0].content), 'protocols at the head survive');
  ok(/NUDGES-AT-TAIL$/.test(r.messages[0].content), 'nudges at the tail survive');
  ok(r.messages[0].content.includes('context trimmed to fit'), 'the cut is MARKED, never silent');
  ok(r.messages[1].content === 'live', 'live message untouched');
}

// --- giant final message: last resort, middle-cut, head/tail survive ---
{
  const m = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'HIS-WORDS-FIRST ' + 'z'.repeat(budget * 2) + ' NUDGE-LAST' },
  ];
  const r = fitToWindow(m, { numCtx: 8192, numPredict: 1200 });
  const fin = r.messages[r.messages.length - 1].content;
  ok(fin.length < budget * 2 && r.report.finalCut > 0, `oversized final message cut (${r.report.finalCut}ch)`);
  ok(/^HIS-WORDS-FIRST/.test(fin) && /NUDGE-LAST$/.test(fin), 'his words and the tail nudge survive');
}

// --- never throws ---
ok(fitToWindow(null).report === null, 'null input never throws');
ok(fitToWindow([]).report === null, 'empty input never throws');
ok(fitToWindow([{ role: 'system' }]).report === null, 'contentless message never throws');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
