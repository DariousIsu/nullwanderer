/* Smoke: lib/day_measure — MEASURE A DAY (design §5 item 6; Lucas 09-05 17:40: "start the measure a day").
 * Pure: fixtures in, a ledger out. Pins the counts the read-with-him depends on, and that every organ the
 * ledger reads actually emits what it reads (source pins on the bridge, the face reader, the operator, the gate).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_day_measure.js
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const DM = require(path.join(ROOT, 'lib', 'day_measure'));
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const M = 60000, T0 = 1_800_000_000_000, from = T0, to = T0 + 6 * 3600000;
const e = (ts, lane, kind, data, text = '') => ({ ts, lane, kind, text, data: JSON.stringify(data) });
const events = [
  e(T0 + 1 * M, 'consciousness', 'act', { act: 'look' }), e(T0 + 30 * M, 'consciousness', 'act', { act: 'listen' }), e(T0 + 40 * M, 'consciousness', 'act', { act: 'look' }),
  e(T0 + 50 * M, 'consciousness', 'reason', { op: 'perform', id: 1, act: 'reach' }), e(T0 + 50 * M + 9000, 'consciousness', 'say', { act: 'reach', text: 'You have been quiet an hour.', silent: false }),
  e(T0 + 120 * M, 'consciousness', 'reason', { op: 'reflect', id: 2, act: 'wonder' }), e(T0 + 120 * M + 8000, 'consciousness', 'wonder', { text: 'He said an hour; it has been two.' }),
  e(T0 + 200 * M, 'consciousness', 'reason', { op: 'perform', id: 3, act: 'arrival' }), e(T0 + 200 * M + 5000, 'consciousness', 'say', { act: 'arrival', text: '', silent: true }),
  e(T0 + 210 * M, 'consciousness', 'reason', { op: 'choose', id: 4 }), e(T0 + 210 * M + 3000, 'consciousness', 'reason_fail', { op: 'choose', id: 4, error: 'aborted' }),
  ...Array.from({ length: 30 }, (_, i) => e(T0 + i * M, 'presence', 'face', { present: true, is_him: true })),          // 30 min seen
  ...Array.from({ length: 10 }, (_, i) => e(T0 + (60 + i) * M, 'presence', 'face', { present: false, is_him: false })),
  ...Array.from({ length: 4 }, (_, i) => e(T0 + (90 + i) * M, 'presence', 'face', { present: true, is_him: true })),    // +3 min seen
  e(T0 + 5 * M, 'presence', 'face_ab', { pair: 1, agree: true }), e(T0 + 6 * M, 'presence', 'face_ab', { pair: 2, agree: false }),
  e(T0 + 300 * M, 'operator', 'run_spend', { tokens: 120000, steps: 6, hit: false }), e(T0 + 320 * M, 'operator', 'run_spend', { tokens: 200500, steps: 3, hit: true }),
  e(T0 + 10 * M, 'quota', 'closed', { lane: 'idle' }),
  e(to + 5 * M, 'consciousness', 'act', { act: 'look' }),   // outside the window
];
const turns = [
  { ts: T0 + 2 * M, speaker: 'user', content: 'hi' }, { ts: T0 + 3 * M, speaker: 'ai_said', model: 'glm-5.2:cloud', unprompted: 0, content: 'hi back' },
  { ts: T0 + 50 * M + 9000, speaker: 'ai_said', model: 'consciousness', unprompted: 1, content: 'You have been quiet an hour.' },
  { ts: T0 + 122 * M, speaker: 'ai_thought', content: 'He said an hour; it has been two.' },
  { ts: T0 + 250 * M, speaker: 'user', content: 'back' },
];
const traces = [
  ...Array.from({ length: 6 }, (_, i) => ({ ts: T0 + i * 30 * M, task: 'autonomy_tick', model: 'gpt-oss:120b-cloud', valid: i % 2 })),
  { ts: T0 + 5 * M, task: 'news_topic_classify', model: 'gemma4:31b-cloud', valid: 1 },
];
const spend = [
  { ts: T0 + 10 * M, lane: 'directed', model: 'deepseek-v4-pro', tokens: 100000 }, { ts: T0 + 20 * M, lane: 'presence', model: 'glm-5.2:cloud', tokens: 2000 },
  { ts: T0 + 70 * M, lane: 'interactive', model: 'gemma4:31b-cloud', tokens: 50000 }, { ts: to + M, lane: 'idle', model: 'glm-5.2:cloud', tokens: 999999 },
];
const weightFor = (m) => (/pro/.test(m) ? 400 : /glm/.test(m) ? 300 : 31);
const { md, summary } = DM.ledger({ from, to, events, turns, traces, spend, quota: { limit: 10_000_000, startPct: 0.5, endPct: 0.52 }, weightFor, now: to });
ok(summary.acts.look === 2 && summary.acts.listen === 1 && !summary.acts.rest, `acts are counted by kind inside the window only (${JSON.stringify(summary.acts)})`);
ok(summary.reason.requests === 4 && summary.reason.says === 2 && summary.reason.silent === 1 && summary.reason.wonders === 1 && summary.reason.failed === 1, `requests → her words (one silence), a wondering, a failure (${JSON.stringify(summary.reason)})`);
ok(summary.him.seenMin === 32 && summary.him.turns === 2 && summary.him.longestQuietMin === 248, `the camera's minutes with him, his turns and the longest quiet (${JSON.stringify(summary.him)})`);
ok(summary.her.prompted === 1 && summary.her.unprompted === 1 && summary.her.unpromptedBy.consciousness === 1 && summary.her.thoughts === 1, 'her replies, her unprompted words by source, her thoughts');
ok(summary.faceAb.pairs === 2 && summary.faceAb.agree === 1, 'the camera trial tally');
ok(summary.decider.ticks === 6 && summary.decider.decided === 3, 'the decider: ticks vs decisions from the traces');
ok(summary.pool.compute === 40000 + 600 + 1550 && summary.pool.byLane.directed === 40000 && summary.runs.n === 2 && summary.runs.budgetHits === 1 && summary.runs.max === 200500, `the pool by lane with the quota weights, the operator runs (${JSON.stringify(summary.pool)})`);
ok(/## 8\. To read with him/.test(md) && /Did any of her unprompted words feel like HERS/.test(md) && /reach: "You have been quiet an hour\."/.test(md) && /arrival: \(silence\)/.test(md) && /closed: idle/.test(md), 'the ledger reads as a page and ends with the questions only he answers');
ok(DM.seenMinutes([]) === 0 && DM.parseData({ data: 'not json' }) && Object.keys(DM.parseData({ data: null })).length === 0, 'empty and malformed inputs read as nothing, never throw');
// the organs emit what the ledger reads
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
ok(/_ev\('reason'/.test(src('lib/consciousness.js')) && /_ev\('say'/.test(src('lib/consciousness.js')) && /_ev\('wonder'/.test(src('lib/consciousness.js')) && /_ev\('reason_fail'/.test(src('lib/consciousness.js')), 'the bridge emits its requests, her words, the wonderings and the failures');
ok(/kind: 'face_ab'/.test(src('lib/face_sense.js')) && /kind: 'run_spend'/.test(src('lib/operator.js')) && /kind: 'closed'/.test(src('lib/quota_gate.js')) && /kind: 'reopened'/.test(src('lib/quota_gate.js')), 'the face reader, the operator and the gate emit their pairs, runs and closures');
ok(/readonly: true/.test(src('scripts/day_measure.js')) && !/\.run\(|INSERT|UPDATE|DELETE/i.test(src('scripts/day_measure.js').replace(/\/\*[\s\S]*?\*\//g, '')), 'the reader opens the database read-only and has no write');
console.log(`\nsmoke_day_measure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
