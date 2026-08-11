'use strict';
/* smoke_swarm_roster.js — R4 (docs/INTEGRATED_BUILD_TRACK_2026-08-10.md §A1/R4).
 * The directed roster swarm: openTasks filters ONE state's open local-roster tasks; drainSwarm fans them out in
 * a BOUNDED parallel pool (never all N at once), fail-soft per task, each task carrying the R3-scoped contract.
 * Pure — mock rq + mock runTask, no DB/cloud (heldContext's DB miss is swallowed → buildPrompt still renders).
 * Run: node scripts/smoke_swarm_roster.js */
const lr = require('../lib/local_roster');
const rq = require('../lib/recheck_queue');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // ── openTasks: filter open local-roster tasks to ONE state ────────────────────────────────────────────────
  {
    const mockRq = { openByKind: ({ kind }) => kind === 'local-roster' ? [
      { id: 1, kind: 'local-roster', subject: 'Acadia Parish Police Jury', detail: { state: 'LA', place: 'Acadia Parish' } },
      { id: 2, kind: 'local-roster', subject: 'Ada County Commission', detail: { state: 'ID', place: 'Ada County' } },
      { id: 3, kind: 'local-roster', subject: 'Allen Parish Police Jury', detail: { state: 'LA', place: 'Allen Parish' } },
    ] : [] };
    const la = lr.openTasks('LA', { rq: mockRq });
    ok(la.length === 2 && la.every((t) => t.detail.state === 'LA'), 'openTasks: filters to the target state only (LA → 2, ID excluded)');
    ok(lr.openTasks('la', { rq: mockRq }).length === 2, 'openTasks: state code is case-insensitive');
    ok(lr.openTasks('', { rq: mockRq }).length === 3, 'openTasks: no state → all local-roster tasks');
  }

  // ── drainSwarm: bounded parallel pool, every task runs, concurrency capped, no double-run ─────────────────
  {
    const tasks = Array.from({ length: 10 }, (_, i) => ({ id: i, subject: `Task ${i}` }));
    let inFlight = 0, peak = 0; const seen = [];
    const runTask = async (item) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(item.id); inFlight--;
      return { action: 'resolved', id: item.id };
    };
    const results = await lr.drainSwarm({ tasks, workers: 3, runTask });
    ok(results.length === 10 && results.every((r) => r.ok), 'drainSwarm: every task ran and succeeded');
    ok(peak <= 3, `drainSwarm: concurrency capped at workers=3 (peak ${peak})`);
    ok(peak >= 2, 'drainSwarm: genuinely parallel (peak ≥ 2, not serial)');
    ok(new Set(seen).size === 10, 'drainSwarm: each task processed exactly once (no double-run)');
  }

  // ── drainSwarm: workers capped to task count; fail-soft per task ──────────────────────────────────────────
  {
    const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    let cur = 0, peak = 0;
    const runTask = async (item) => { cur++; peak = Math.max(peak, cur); await new Promise((r) => setTimeout(r, 3)); cur--; if (item.id === 'b') throw new Error('boom'); return 'ok'; };
    const results = await lr.drainSwarm({ tasks, workers: 10, runTask });
    ok(peak <= 3, 'drainSwarm: never more workers than tasks (peak ≤ 3 for 3 tasks)');
    ok(results.length === 3 && results[0].ok && results[2].ok, 'drainSwarm: fail-soft — a throwing task does not sink the others');
    ok(results[1].ok === false && /boom/.test(results[1].error), 'drainSwarm: the failed task is recorded, not silently dropped');
  }

  // ── drainSwarm: onResult fires per task (live coverage hook); empty/invalid input is safe ─────────────────
  {
    let landed = 0;
    await lr.drainSwarm({ tasks: [{}, {}], workers: 2, runTask: async () => 1, onResult: () => { landed++; } });
    ok(landed === 2, 'drainSwarm: onResult fires once per completed task');
    ok((await lr.drainSwarm({ tasks: [], workers: 2, runTask: async () => 1 })).length === 0, 'drainSwarm: no tasks → [] (no crash)');
    ok((await lr.drainSwarm({ tasks: [{}], workers: 2 })).length === 0, 'drainSwarm: no runTask → [] (fail-open)');
  }

  // ── the per-task contract stays R3-scoped (the e45085b guardrail): buildPrompt for a local-roster item ────
  {
    const item = { kind: 'local-roster', subject: 'Acadia Parish Police Jury', detail: { state: 'LA', place: 'Acadia Parish', body: 'Police Jury', bodyKinds: ['police jury', 'parish council'], exclude: ['sheriff', 'clerk', 'district attorney', 'assessor'] } };
    const prompt = rq.buildPrompt(item);
    ok(/EXCLUDE:/i.test(prompt) && /sheriff/i.test(prompt) && /district attorney/i.test(prompt), 'R3 guardrail: each task prompt EXCLUDES the row offices (sheriff/DA…)');
    ok(/LEGISLATIVE|governing body/i.test(prompt), 'R3 guardrail: each task targets the LEGISLATIVE/governing body');
    ok(/Acadia Parish/.test(prompt), 'R3 guardrail: the prompt is locality-scoped (Acadia Parish)');
  }

  // ── R2 serve-vs-rebuild trust gate (pure decision) ───────────────────────────────────────────────────────
  {
    const now = 1_000_000_000;
    ok(lr.decideServeOrRebuild({ held: null, currentFilled: 3, now }).action === 'rebuild', 'R2: no held product → rebuild');
    ok(lr.decideServeOrRebuild({ held: { ts: now - 60000, filled: 3 }, currentFilled: 3, now }).action === 'serve', 'R2: fresh held + unchanged coverage → serve');
    const grew = lr.decideServeOrRebuild({ held: { ts: now - 60000, filled: 3 }, currentFilled: 5, now });
    ok(grew.action === 'rebuild' && grew.reason === 'coverage-improved', 'R2: coverage grew since build (5 > 3) → rebuild');
    ok(lr.decideServeOrRebuild({ held: { ts: now - 7 * 3600 * 1000, filled: 3 }, currentFilled: 3, now }).action === 'rebuild', 'R2: stale (older than the 6h TTL) → rebuild');
    ok(lr.decideServeOrRebuild({ held: { ts: now - 60000, filled: 3 }, currentFilled: 3, now, ttlMs: 1000 }).action === 'rebuild', 'R2: custom short TTL → stale → rebuild');
    ok(lr.decideServeOrRebuild({ held: { ts: now, filled: 0 }, currentFilled: 0, now }).reason === 'fresh', 'R2: serve reason reported (fresh)');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
