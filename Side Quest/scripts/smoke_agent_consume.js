'use strict';
/* smoke_agent_consume.js — B1 consume step (lib/agent_consume.js).
 * The load-bearing case (run-2, 2026-08-19): a chat-triggered agent run succeeded in 21s and nothing
 * read the output — she re-spawned the same research 3× and asked the user to paste her own data.
 * The ledger must register runs, dedupe same-input re-spawns (read-through done / refuse in-flight),
 * expire honestly, and build the consume/reuse texts. Pure, injected store. Run: node scripts/smoke_agent_consume.js */
const ac = require('../lib/agent_consume');
const rf = require('../lib/review_fanout');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const mkStore = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };

// ── hashInput: stable, envelope-blind, input-sensitive ───────────────────────────────────────────────────
{
  const envelope = '\n\nYour final reply IS the return value — not a message to anyone. End with a compact summary in this shape: FOUND: x · NOT FOUND: y · SOURCES: z.';
  const a = ac.hashInput('delegate', { task: 'sponsors for the 2026 anti-China land bills', agent: 'legislative-analyst' });
  const b = ac.hashInput('delegate', { task: 'sponsors for the 2026 anti-China land bills' + envelope, agent: 'legislative-analyst' });
  const c = ac.hashInput('delegate', { task: 'SPONSORS for the 2026 Anti-China land bills', agent: 'legislative-analyst' });
  const d = ac.hashInput('delegate', { task: 'something entirely different', agent: 'legislative-analyst' });
  ok(a === b, 'hashInput: the dispatch envelope never changes the hash (same request ± envelope)');
  ok(a === c, 'hashInput: case-insensitive (same request, different casing)');
  ok(a !== d, 'hashInput: a different task hashes differently');
  ok(ac.hashInput('delegate_to_x', { a: 1, b: 2 }) === ac.hashInput('delegate_to_x', { b: 2, a: 1 }), 'hashInput: key order never matters');
}

// ── register / lookup / markDone lifecycle ───────────────────────────────────────────────────────────────
{
  const store = mkStore();
  const h = ac.hashInput('delegate_to_legislative_analyst', { input: 'anti-china sponsors' });
  ok(ac.register({ runId: 'r1', tool: 'delegate_to_legislative_analyst', hash: h, at: 1000 }, store), 'register: a fresh run registers');
  ok(!ac.register({ runId: 'r1', tool: 'delegate_to_legislative_analyst', hash: h, at: 1000 }, store), 'register: the same runId never double-registers');
  const hit = ac.lookup(h, store, { now: 2000 });
  ok(hit && hit.state === 'pending' && hit.runId === 'r1', 'lookup: a same-input re-spawn finds the IN-FLIGHT run (refuse re-spawn)');
  ok(ac.lookup('deadbeef', store, { now: 2000 }) === null, 'lookup: a different input finds nothing');
  ok(ac.lookup(h, store, { now: 1000 + ac.DEDUPE_WINDOW_MS + 1 }) === null, 'lookup: outside the window → no dedupe (fresh spawn allowed)');
  ac.markDone({ runId: 'r1', tool: 'delegate_to_legislative_analyst', hash: h, at: 1000 }, store);
  ok(ac.pending(store).length === 0, 'markDone: removed from pending');
  const done = ac.lookup(h, store, { now: 2000 });
  ok(done && done.state === 'done' && done.runId === 'r1', 'lookup: a completed same-input run reads through the DONE ledger');
}
{
  const store = mkStore();
  for (let i = 0; i < 30; i++) ac.register({ runId: 'r' + i, tool: 't', hash: 'h' + i, at: i }, store);
  ok(ac.pending(store).length <= 20, 'register: the pending ledger is capped (no unbounded growth)');
}
{
  const store = mkStore();
  ok(ac.register({ runId: null, tool: 't', hash: 'h', at: 1 }, store) === false, 'register: no runId → refused, never a phantom entry');
  ok(ac.lookup('h', null) === null && ac.lookup('', mkStore()) === null, 'lookup: missing store/hash → fail open (null)');
}

// ── the honest texts ─────────────────────────────────────────────────────────────────────────────────────
{
  const reuse = ac.reuseNote('r9', 5 * 60 * 1000, 'FOUND: UT HB0291 Pierucci …');
  ok(/REUSING/.test(reuse) && /do NOT re-spawn/i.test(reuse) && /UT HB0291/.test(reuse), 'reuseNote: names the run, forbids re-spawn, carries the output');
  const running = ac.stillRunningNote('r9', 90 * 1000);
  ok(/ALREADY RUNNING/.test(running) && /r9/.test(running) && /Do NOT spawn it again/i.test(running), 'stillRunningNote: refuses the re-spawn honestly');
  const cp = ac.consumePrompt({ tool: 'delegate:legislative-analyst', runId: 'r9', output: 'FOUND: the sponsors …', userName: 'Lucas' });
  ok(/COMPLETED/.test(cp) && /Lucas/.test(cp) && /FOUND: the sponsors/.test(cp) && /Do NOT re-run/i.test(cp), 'consumePrompt: delivers the output + forbids re-running + no bare acks');
}

// ── the proven parsers this rides on (review_fanout) ─────────────────────────────────────────────────────
ok(rf.parseRunId('{"run_id": "88ceb5f9b8ed4c5a92a03036bc3ed6b4", "state": "queued"}') === '88ceb5f9b8ed4c5a92a03036bc3ed6b4', 'parseRunId: reads the spawn result');
ok(rf.parseRunState('{"state": "succeeded"}') === 'succeeded' && rf.isTerminal('succeeded') && !rf.isTerminal('running'), 'parseRunState/isTerminal: terminal detection');
ok(rf.parseRunOutput('{"rows":[{"output":"short"},{"output":"the much longer real research body"}]}') === 'the much longer real research body', 'parseRunOutput: pulls the longest output body');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
