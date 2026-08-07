/* Smoke: lib/review_fanout — O5 review fan-out (M2.5.4): wide-scope detection, deterministic
 * shard math, the delegate task spec, run parsing, the compile contract — plus source asserts
 * on main.js's spawn/join/deliver wiring and the Echo-side code-reviewer agent manifest.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_review_fanout.js
 */
'use strict';
const rf = require('../lib/review_fanout');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- wide-scope detection: breadth fans out, the milestone ask stays single-context ---
ok(rf.isWideReview('review your whole program') === true, '"whole program" → wide');
ok(rf.isWideReview('audit your entire codebase') === true, '"entire codebase" → wide');
ok(rf.isWideReview('review all of lib') === true, '"all of lib" → wide');
ok(rf.isWideReview('review your codebase for dead code') === true, 'bare "codebase" is inherently wide');
ok(rf.isWideReview('review your reply pipeline') === false, 'the M2.5.4 milestone ask stays NARROW (single-context direct path)');
ok(rf.isWideReview('review lib/compose.js') === false, 'one named file is not wide');
ok(rf.isWideReview('take another look at the Hartfield report') === false, 'a document re-look is not a code review scope');

// --- shard math: balanced, deterministic, no empties ---
const files = [
  { path: 'a.js', bytes: 900 }, { path: 'b.js', bytes: 800 }, { path: 'c.js', bytes: 300 },
  { path: 'd.js', bytes: 250 }, { path: 'e.js', bytes: 200 }, { path: 'f.js', bytes: 150 },
];
const sh = rf.shardFiles(files, 3);
ok(sh.length === 3 && sh.flat().length === 6, '6 files → 3 shards, nothing dropped');
{
  const totals = sh.map((s) => s.reduce((n, f) => n + f.bytes, 0));
  ok(Math.max(...totals) - Math.min(...totals) <= 900, 'greedy balance: no shard carries everything');
  const again = rf.shardFiles([...files].reverse(), 3);
  ok(JSON.stringify(again) === JSON.stringify(sh), 'DETERMINISTIC: input order does not change the sharding');
}
ok(rf.shardFiles([{ path: 'x.js', bytes: 10 }], 3).length === 1, 'fewer files than shards → no empty shards');

// --- the delegate task spec ---
const task = rf.buildShardTask({ goal: 'find dead code', files: sh[0], index: 0, total: 3 });
ok(/SHARD 1\/3/.test(task) && /find dead code/.test(task), 'task carries shard position + the goal');
ok(sh[0].every((f) => task.includes(f.path)), 'every assigned path is in the spec');
ok(/UNREAD, never silently skip/.test(task), 'the no-silent-skip discipline is in the spec');

// --- run parsing (the join half) ---
ok(rf.parseRunId('{"run_id": "run-abc123", "state": "queued"}') === 'run-abc123', 'run_id parsed from spawn result');
ok(rf.parseRunId('no id here') === null, 'no run_id → null, never a guess');
ok(rf.parseRunState('{"run_id":"x","state":"running","elapsed_s":12}') === 'running', 'state parsed from agent_status');
ok(rf.isTerminal('succeeded') && rf.isTerminal('failed') && rf.isTerminal('cancelled'), 'terminal states recognized');
ok(!rf.isTerminal('running') && !rf.isTerminal('queued'), 'live states are not terminal');
ok(rf.parseRunOutput('[{"run_id":"x","output":"SHARD: shard-1\\nFINDINGS:\\n- none"}]').startsWith('SHARD: shard-1'), 'output parsed + JSON-unescaped from get_agent_output');

// --- the compile contract ---
const cp = rf.buildCompilePrompt({ goal: 'g', reports: [{ label: 'shard-1', state: 'succeeded', output: 'FINDINGS: - high lib/a.js:10 — x' }, { label: 'shard-2', state: 'failed', output: '' }] });
ok(/never invent a finding/.test(cp[0].content) && /file:line citation/.test(cp[0].content), 'compile cages grounding + citation carrying');
ok(/never paper over a shard that failed/.test(cp[0].content) && /## Coverage/.test(cp[0].content), 'failed shards + unread files stay VISIBLE (no silent caps)');
ok(/shard-2.*failed/.test(cp[1].content) && /lib\/a\.js:10/.test(cp[1].content), 'the user message carries both reports, states named');

// --- source asserts: main.js wiring + the Echo agent manifest ---
{
  const fs = require('fs'), path = require('path');
  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/isWideReview\(userMessage\)/.test(m) && /falling back to single-context review/.test(m), 'wide detect gates the fan-out; failure falls back to the direct path');
  ok(/startReviewFanout/.test(m) && m.indexOf("db.setMeta('review.fanout', JSON.stringify(st))") > -1, 'run state persists in meta (a reboot resumes the join)');
  ok(/_reviewFanoutTick/.test(m) && /REVIEW_FANOUT_DEADLINE_MS/.test(m), 'the join tick exists with a hard deadline');
  ok(/name: 'spawn_agent_async', args: \{ name: 'code-reviewer'/.test(m), 'shards spawn the code-reviewer delegate through the ONE dispatch chokepoint');
  ok(/name: 'get_agent_output'/.test(m), 'outputs are collected from the durable store, never re-spawned');
  ok(/still running at the deadline/.test(m), 'a run that misses the deadline is NAMED in the compile, not waited on forever');
  const ce = fs.readFileSync(path.join(__dirname, '..', 'lib', 'child_env.js'), 'utf8');
  ok(/NX_ECHO_FS_ROOTS/.test(ce) && /never data\/ or \.env|never the app root/.test(ce), 'child_env widens Echo fs scope to SOURCE dirs only');
  const tomlPath = path.resolve(__dirname, '..', '..', 'NX ECHO', 'nx-echo', 'data', 'agents', 'code-reviewer.toml');
  if (fs.existsSync(tomlPath)) {
    const toml = fs.readFileSync(tomlPath, 'utf8');
    ok(/name\s*=\s*"code-reviewer"/.test(toml) && /"fs_read_file"/.test(toml), 'Echo code-reviewer agent exists with fs_read_file whitelisted');
    ok(!/fs_apply_edit/.test(toml), 'SAFETY: the reviewer reads, it can never edit');
  } else {
    ok(true, '(Echo repo not present at the sibling path — manifest asserts skipped)');
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
