/* Smoke: reasoning-model headroom (cloud-leverage Slice 2). A reasoning model (gpt-oss/qwen3/…) stashes
 * its answer in message.thinking and can leave content EMPTY; pickText must fall back so callers never get
 * "" (the empty-dossier / empty-section bug). isReasoningModel flags the reasoners, not the utility models.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_reasoning_headroom.js
 */
'use strict';
const { pickText, isReasoningModel } = require('../lib/ollama');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// pickText: content wins; empty content falls back to thinking; both empty → ''
ok(pickText({ content: 'the answer', thinking: 'reasoning…' }) === 'the answer', 'pickText: clean content wins over thinking');
ok(pickText({ content: '', thinking: 'answer-in-thinking' }) === 'answer-in-thinking', 'pickText: EMPTY content → falls back to thinking (never returns empty when the model produced output)');
ok(pickText({ content: '   ', thinking: 'ans' }) === 'ans', 'pickText: whitespace-only content → falls back to thinking');
ok(pickText({ content: '', thinking: '' }) === '' && pickText(null) === '', 'pickText: genuinely empty → ""');

// isReasoningModel: flags reasoners, not the utility/voice models
for (const m of ['gpt-oss:120b', 'qwen3:32b', 'deepseek-r1:70b', 'kimi-k2', 'qwq:32b'])
  ok(isReasoningModel(m), `isReasoningModel: ${m} → true`);
for (const m of ['gemma4:31b', 'gemma4:31b-cloud', 'mistral-small3.2:24b', 'minimax-m3:cloud', 'mistral-large-3:675b'])
  ok(!isReasoningModel(m), `isReasoningModel: ${m} → false (utility/voice, not a reasoner)`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
