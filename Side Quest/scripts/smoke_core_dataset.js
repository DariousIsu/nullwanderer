'use strict';
/**
 * smoke_core_dataset — the core's dataset builder (scripts/core_dataset_build.js) against a synthetic store.
 * Every filter branch fires once; the think/say contract is exact; the holdout freezes across runs and only
 * grows for a NEW task; the index matches the files; nothing needs a database file or a model.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_core_dataset.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('./core_dataset_build');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_core_ds_'));
const T0 = 1788600000000; // 2026-09-05-ish, ms
let nid = 1;
const turn = (session_id, speaker, content, dt, extra = {}) => ({ id: nid++, session_id, ts: T0 + dt, speaker, content, model: 'glm-5.2:cloud', truncated: 0, unprompted: 0, speech_class: null, ...extra });

const turns = [
  // s1: a prompted exchange with a paired thought (5 s apart) → voice, think/say
  turn('s1', 'user', 'How did the vote go?', 0),
  turn('s1', 'ai_thought', 'He means the committee vote this morning.', 5000),
  turn('s1', 'ai_said', 'It passed 7 to 4, with the chair voting yes.', 10000),
  // s1: a thought too far from its say (3 min) → thought dropped as orphan; the say stands alone
  turn('s1', 'user', 'And the amendment?', 60000),
  turn('s1', 'ai_thought', 'Stale interior.', 65000),
  turn('s1', 'ai_said', 'The amendment was withdrawn before the vote.', 65000 + 180000),
  // s2: an unprompted say (no user turn in 30 min) → voice_unprompted
  turn('s2', 'ai_said', 'I finished the roster pass while you were out.', 0, { unprompted: 1 }),
  // rejections, one each
  turn('s3', 'user', 'q1', 0), turn('s3', 'ai_said', 'cut off mid', 1000, { truncated: 1 }),
  turn('s3', 'user', 'q2', 100000), turn('s3', 'ai_said', 'a replayed line', 101000, { speech_class: 'replay' }),
  turn('s3', 'user', 'q3', 200000), turn('s3', 'ai_said', 'research writeup text', 201000, { model: 'research' }),
  turn('s3', 'user', 'q4', 300000), turn('s3', 'ai_said', 'here is the key sk-abcdefghijklmnopqrstuvwxyz1234', 301000),
  turn('s3', 'user', 'q5', 400000), turn('s3', 'ai_said', 'A NOTE FROM CLAUDE, the engineer who builds your program: leaked', 401000),
  turn('s3', 'user', 'q6', 500000), turn('s3', 'ai_said', '[say EXACTLY this in your voice] fine', 501000),
  turn('s3', 'user', 'q7', 600000), turn('s3', 'ai_said', 'It passed 7 to 4, with the chair voting yes.', 601000), // duplicate of s1
  turn('s3', 'user', 'q8', 700000), turn('s3', 'ai_said', '<say>tag residue</say>', 701000),
];

const trace = (id, task, input, output, extra = {}) => ({ id, ts: T0 + id * 1000, task, model: 'gemma4:31b-cloud', input_json: input, raw_response: output, parsed_json: output, valid: 1, accepted: 1, repaired: 0, ...extra });
const traces = [];
for (let i = 1; i <= 40; i++) traces.push(trace(i, 'news_topic_classify', JSON.stringify([{ id: i, text: `story ${i}` }]), JSON.stringify([{ id: i, cat: 'politics' }])));
for (let i = 41; i <= 52; i++) traces.push(trace(i, 'echo_pick', JSON.stringify({ need: `need ${i}` }), JSON.stringify({ type: 'tool', name: 'db_query' })));
traces.push(trace(100, 'autonomy_tick', '{"x":1}', '{"y":2}'));                       // not a target
traces.push(trace(101, 'echo_pick', '{"x":1}', '{"y":2}', { valid: 0, accepted: 0 }));  // invalid
traces.push(trace(102, 'echo_pick', 'x'.repeat(9000), '{"y":2}'));                     // too long
traces.push(trace(103, 'echo_pick', '{"x":1}', '', { parsed_json: null, raw_response: '' })); // empty output
traces.push(trace(104, 'echo_pick', '{"k":"Bearer abcdefghijklmnopqrstuv"}', '{"y":2}'));     // secret

console.log('smoke_core_dataset');

// ── pure pieces ──
ok(B.rejectReason('') === 'empty', 'empty text rejected');
ok(B.rejectReason('x'.repeat(5000)) === 'too_long', 'over-long text rejected');
ok(B.rejectReason('token ghp_abcdefghijklmnopqrstuvwxyz') === 'secret', 'a GitHub token rejects the line');
ok(B.rejectReason('plain words about a vote') === null, 'ordinary text passes');
ok(B.stableHash('voice:1') === B.stableHash('voice:1') && B.stableHash('voice:1') !== B.stableHash('voice:2'), 'stable hash is stable and distinct');
ok(B.dayOf(T0) === new Date(T0).toISOString().slice(0, 10), 'day of a ms timestamp');
ok(B.dayOf(Math.floor(T0 / 1000)) === new Date(T0).toISOString().slice(0, 10), 'day of a seconds timestamp');

// ── the build ──
const r1 = B.build({ out, store: { turns, traces }, log: () => {} });
ok(r1.per_kind.voice === 2, `two prompted voice examples (got ${r1.per_kind.voice})`);
ok(r1.per_kind.voice_unprompted === 1, 'one unprompted voice example');
ok(r1.per_task.news_topic_classify === 40 && r1.per_task.echo_pick === 12, 'trace targets counted per task');
const rv = r1.rejected.voice;
ok(rv.truncated === 1 && rv.class_replay === 1 && rv.non_voice_lane === 1 && rv.secret === 1 && rv.engineer_note === 1 && rv.directive_leak === 1 && rv.duplicate === 1 && rv.tag_residue === 1, `every voice rejection reason fired once (${JSON.stringify(rv)})`);
const rt = r1.rejected.trace;
ok(rt.task_not_target === 1 && rt.invalid_or_unaccepted === 1 && rt.input_too_long === 1 && rt.empty_output === 1 && rt.secret === 1, `every trace rejection reason fired once (${JSON.stringify(rt)})`);

// the think/say contract, exact
const idx = fs.readFileSync(path.join(out, 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
ok(idx.length === r1.examples, 'index has one row per example');
const allLines = [];
for (const dir of ['examples', 'holdout']) {
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.jsonl')) allLines.push(...fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))); } };
  walk(path.join(out, dir));
}
ok(allLines.length === r1.examples, `files hold every example (${allLines.length})`);
const paired = allLines.find((e) => e.id === 'voice:3');
ok(paired && paired.messages.at(-1).content === '<think>He means the committee vote this morning.</think>\n<say>It passed 7 to 4, with the chair voting yes.</say>', 'a paired thought rides inside <think>, the say inside <say>');
ok(paired && paired.messages.at(-2).role === 'user' && paired.messages.at(-2).content === 'How did the vote go?', 'the exchange ends on his message');
const lone = allLines.find((e) => e.id === 'voice:6');
ok(lone && lone.messages.at(-1).content === '<say>The amendment was withdrawn before the vote.</say>', 'an orphaned thought is dropped; the say stands alone');
ok(lone && lone.messages.some((m) => m.role === 'assistant' && m.content === '<say>It passed 7 to 4, with the chair voting yes.</say>'), 'the earlier say rides as context, thought omitted');
const unp = allLines.find((e) => e.id === 'voice:7');
ok(unp && unp.kind === 'voice_unprompted' && /No message from Lucas/.test(unp.messages.at(-2).content), 'an unprompted say carries the no-message marker');
const tr = allLines.find((e) => e.id === 'trace:41');
ok(tr && tr.kind === 'trace' && tr.task === 'echo_pick' && /^Task: echo_pick\./.test(tr.messages[0].content) && tr.messages[2].content === '{"type":"tool","name":"db_query"}', 'a trace example is task-instructed input → parsed output');
ok(allLines.every((e) => !/sk-|ghp_|Bearer /.test(JSON.stringify(e))), 'no secret pattern anywhere in the corpus');

// ── the holdout: frozen, append-only ──
const h1 = JSON.parse(fs.readFileSync(path.join(out, 'holdout.json'), 'utf8'));
ok(Array.isArray(h1.voice) && h1.voice.length === 2, 'voice holdout takes what exists when fewer than 100 (2)');
ok(h1.trace.news_topic_classify.length === 10 && h1.trace.echo_pick.length === 10, 'per-task holdout = max(10, 5 %) capped by count');
ok(r1.holdout === 22 && r1.train === r1.examples - 22, 'held examples are in holdout/, not in examples/');
const heldIds = new Set([...h1.voice, ...Object.values(h1.trace).flat()]);
ok(idx.filter((e) => e.holdout).every((e) => heldIds.has(e.id)) && idx.filter((e) => e.holdout).length === 22, 'index holdout flags match the frozen membership');

// second run: more rows + a new task; the old membership must not move, the new task gets its own
const traces2 = traces.slice();
for (let i = 200; i < 260; i++) traces2.push(trace(i, 'news_topic_classify', JSON.stringify([{ id: i, text: `later ${i}` }]), JSON.stringify([{ id: i, cat: 'health' }])));
for (let i = 300; i < 315; i++) traces2.push(trace(i, 'decompose', JSON.stringify({ user: `u${i}` }), JSON.stringify({ intent: 'chat', objects: [] })));
const turns2 = turns.concat([turn('s9', 'user', 'new q', 0), turn('s9', 'ai_said', 'a brand new say', 1000)]);
const r2 = B.build({ out, store: { turns: turns2, traces: traces2 }, log: () => {} });
const h2 = JSON.parse(fs.readFileSync(path.join(out, 'holdout.json'), 'utf8'));
ok(JSON.stringify(h2.voice) === JSON.stringify(h1.voice), 'voice holdout unchanged by new rows (frozen)');
ok(JSON.stringify(h2.trace.news_topic_classify) === JSON.stringify(h1.trace.news_topic_classify), 'an existing task holdout unchanged though the task grew');
ok(Array.isArray(h2.trace.decompose) && h2.trace.decompose.length === 10 && r2.holdout_added === 10, 'a NEW task gets its holdout once (10)');
ok(h2.frozen_at === h1.frozen_at, 'frozen_at is kept from the first build');
ok(r2.per_kind.voice === 3 && r2.per_task.decompose === 15, 'new rows land as train examples');

// ── determinism ──
const r3 = B.build({ out, store: { turns: turns2, traces: traces2 }, log: () => {} });
const idxA = fs.readFileSync(path.join(out, 'index.jsonl'), 'utf8');
B.build({ out, store: { turns: turns2, traces: traces2 }, log: () => {} });
ok(idxA === fs.readFileSync(path.join(out, 'index.jsonl'), 'utf8') && r3.examples === r2.examples, 'the same store yields the same index');

// ── describe ──
ok(/\[core-dataset\] \d+ examples/.test(B.describe(r2)) && /rejected voice:/.test(B.describe(r2)), 'describe() is one readable report');

fs.rmSync(out, { recursive: true, force: true });
console.log(`\nsmoke_core_dataset: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
