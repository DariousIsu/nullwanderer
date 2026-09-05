'use strict';
/**
 * smoke_core_probe — the core's probe (scripts/core_probe.js) with an injected model call: the loose JSON
 * parser, the agreement scorer (arrays by id, objects field-wise, the decision field), the voice contract,
 * the one-shot prompt shape, and the report. No daemon, no store, no model.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_core_probe.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./core_probe');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

console.log('smoke_core_probe');

// ── parser ──
ok(JSON.stringify(P.parseJsonLoose('```json\n{"a":1}\n```')) === '{"a":1}', 'fenced JSON parses');
ok(JSON.stringify(P.parseJsonLoose('Sure! Here it is: {"type":"tool","name":"db_query"} hope that helps')) === '{"type":"tool","name":"db_query"}', 'chatter around an object is stripped');
ok(JSON.stringify(P.parseJsonLoose('<think>hmm</think>[{"id":1,"cat":"politics"}]')) === '[{"id":1,"cat":"politics"}]', 'a think block before an array is ignored');
ok(P.parseJsonLoose('no json here') === null, 'prose yields null');

// ── scorer ──
ok(P.looseEqual('Politics ', 'politics') && P.looseEqual(0.96, 0.96) && P.looseEqual('7', 7) && !P.looseEqual('a', 'b'), 'loose equality: case, space, numeric strings');
ok(P.decisionField({ id: 3, cat: 'health' }) === 'cat' && P.decisionField({ type: 'tool', name: 'x' }) === 'type' && P.decisionField({ objects: [] }) === null, 'the decision field is the first scalar that is not id');
let a = P.agreement([{ id: 1, cat: 'politics' }, { id: 2, cat: 'health' }], [{ id: 2, cat: 'health' }, { id: 1, cat: 'culture' }]);
ok(a.decision === 0.5 && a.fields === 0.75, `arrays match by id regardless of order; id counts as a field, so decision is the headline (${JSON.stringify(a)})`);
a = P.agreement({ type: 'tool', name: 'db_query', arg: '', reason: 'x' }, { type: 'tool', name: 'quick_lookup', arg: '', reason: 'y' });
ok(a.decision === 1 && a.fields === 0.5, `objects: decision field equal, half the fields equal (${JSON.stringify(a)})`);
a = P.agreement({ intent: 'deliver', size: 'report' }, null);
ok(a.decision === 0 && a.fields === 0, 'an unparsable answer scores zero');
a = P.agreement({ intent: 'chat', objects: [{ mention: 'Orpheus', type: 'organization' }] }, { intent: 'chat', objects: [{ mention: 'orpheus', type: 'organization' }] });
ok(a.decision === 1 && a.fields === 1, 'nested arrays compare loosely');
ok(P.agreement([], []).fields === 1 && P.agreement('same', 'same').decision === 1, 'empty arrays and equal scalars agree');

// ── voice contract ──
ok(P.voiceShape('<think>he means the vote</think>\n<say>It passed.</say>').ok, 'think then say passes');
ok(P.voiceShape('<say>It passed.</say>').ok && !P.voiceShape('It passed.').ok && !P.voiceShape('<say>It passed.</say> and more').ok && !P.voiceShape('<say></say>').ok, 'bare text, trailing text, and an empty say fail');

// ── the probe with a fake call, on a synthetic holdout ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_core_probe_'));
fs.mkdirSync(path.join(dir, 'holdout'));
const ex = (task, id, input, output) => JSON.stringify({ id: `trace:${id}`, kind: 'trace', task, day: '2026-09-05', messages: [{ role: 'system', content: `Task: ${task}. Read the input and return only the JSON output this task requires.` }, { role: 'user', content: input }, { role: 'assistant', content: output }], meta: {} });
const traceLines = [];
for (let i = 1; i <= 6; i++) traceLines.push(ex('news_topic_classify', i, JSON.stringify([{ id: i, text: `story ${i}` }]), JSON.stringify([{ id: i, cat: i % 2 ? 'politics' : 'health' }])));
for (let i = 10; i <= 13; i++) traceLines.push(ex('echo_pick', i, JSON.stringify({ need: `need ${i}` }), JSON.stringify({ type: 'tool', name: 'db_query', arg: '', reason: 'r' })));
traceLines.push(ex('lonely_task', 99, '{}', '{}'));   // one example → cannot probe
fs.writeFileSync(path.join(dir, 'holdout', 'trace.jsonl'), traceLines.join('\n') + '\n');
const voiceLine = JSON.stringify({ id: 'voice:1', kind: 'voice', day: '2026-09-05', messages: [{ role: 'system', content: 'You are Zoe. …' }, { role: 'user', content: 'How did the vote go?' }, { role: 'assistant', content: '<think>the committee</think>\n<say>It passed 7 to 4.</say>' }], meta: {} });
fs.writeFileSync(path.join(dir, 'holdout', 'voice.jsonl'), voiceLine + '\n');

const seen = [];
const fake = async ({ messages, numCtx, think, numPredict }) => {
  seen.push({ messages, numCtx, think, numPredict });
  const last = messages.at(-1).content;
  if (/Now this input:/.test(last)) {
    // parrot the example's shape but flip half the classifications; echo_pick picks a different tool once
    const m = last.match(/Now this input:\n([\s\S]+)$/);
    const input = JSON.parse(m[1]);
    if (Array.isArray(input)) return { text: '```json\n' + JSON.stringify(input.map((x) => ({ id: x.id, cat: x.id === 3 ? 'culture' : (x.id % 2 ? 'politics' : 'health') }))) + '\n```', ms: 120, error: null };
    return { text: JSON.stringify({ type: 'tool', name: input.need === 'need 12' ? 'quick_lookup' : 'db_query', arg: '', reason: 'r' }), ms: 80, error: null };
  }
  if (/How did the vote go/.test(last)) return { text: '<say>It passed, seven to four.</say>', ms: 200, error: null };
  return { text: 'Hi there. Who are you, and how can I help?', ms: 150, error: null };
};

P.probe({ model: 'fake:1b', coreDir: dir, tasks: ['news_topic_classify', 'echo_pick', 'lonely_task', 'absent_task'], n: 20, voiceN: 1, numCtx: 4096, think: false, call: fake }).then((r) => {
  const t = r.tasks.news_topic_classify;
  ok(t && t.n === 5, `one example is the demo, the rest are tests (n=${t && t.n})`);
  ok(t && t.valid_pct === 100, 'fenced answers count as valid');
  ok(t && t.agree_decision_pct === 80 && t.agree_fields_pct === 90, `one flipped category of five → decision 80 %, fields 90 % (${t && t.agree_decision_pct}/${t && t.agree_fields_pct})`);
  const e = r.tasks.echo_pick;
  ok(e && e.n === 3 && e.agree_decision_pct === 100 && e.agree_fields_pct === Math.round(100 * (1 + 1 + 0.75) / 3), `echo_pick: decision field always right, one wrong tool costs a field (${e && e.agree_fields_pct})`);
  ok(r.tasks.lonely_task.n === 0 && /fewer than 2/.test(r.tasks.lonely_task.note), 'a task with one held-out example is skipped with a note');
  ok(r.tasks.absent_task.n === 0, 'an absent task is skipped');
  ok(r.voice && r.voice.n === 1 && r.voice.shape_ok_pct === 100 && r.voice.samples[0].his === 'How did the vote go?', 'voice: the model answers his line without seeing hers; the contract is checked');
  ok(r.loop.length === P.LOOP_MOMENTS.length && r.loop.every((l) => !l.error && l.sentences >= 1), 'every loop moment is exercised');
  const oneShot = seen.find((s) => /Example input:/.test(s.messages.at(-1).content));
  ok(oneShot && /Example output:/.test(oneShot.messages.at(-1).content) && /shape of the example/.test(oneShot.messages[0].content), 'the trace prompt is one-shot with the teacher\'s own example');
  ok(seen.every((s) => s.numCtx === 4096 && s.think === false), 'window and think flag ride every call');
  ok(t && typeof t.median_ms === 'number' && t.p90_ms >= t.median_ms, 'latency is summarised');
  const s = P.summary(r);
  ok(/\[core-probe\] fake:1b/.test(s) && /news_topic_classify/.test(s) && /voice contract 100%/.test(s), 'summary() is one readable table');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nsmoke_core_probe: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.log('FAIL probe threw', e && e.stack || e); process.exit(1); });
