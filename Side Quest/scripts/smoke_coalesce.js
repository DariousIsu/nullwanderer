/* smoke_coalesce.js — in-flight request coalescing for Echo reads.
 *
 * The load-bearing tests are the SAFETY ones: writes must never coalesce (collapsing two identical
 * proposals would silently drop one), and an entry must not outlive its call (or we would be serving
 * stale answers, which is a result cache — explicitly not what this is).
 */
'use strict';
const c = require('../lib/coalesce');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }
const hashFn = (a) => (a == null ? null : JSON.stringify(a));
function defer() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

(async () => {
  // ── policy ───────────────────────────────────────────────────────────────────────────────────
  ok(c.isCoalescable('search_entities') && c.isCoalescable('db_query'), 'isCoalescable: reads allowed');
  ok(!c.isCoalescable('propose_entity'), 'SAFETY: propose_entity NEVER coalesced');
  ok(!c.isCoalescable('propose_relation'), 'SAFETY: propose_relation NEVER coalesced');
  ok(!c.isCoalescable('auto_promote_grounded'), 'SAFETY: auto_promote_grounded never coalesced');
  ok(!c.isCoalescable('merge_entities') && !c.isCoalescable('run_semantic_dedup'), 'SAFETY: mutations excluded');
  ok(!c.isCoalescable('spawn_agent_async'), 'SAFETY: agent spawning never coalesced');
  ok(!c.isCoalescable('saga_canvas_add_block'), 'SAFETY: canvas writes never coalesced');
  ok(!c.isCoalescable('totally_unknown_tool'), 'SAFETY: unknown tool defaults to NOT coalesced');
  ok(!c.isCoalescable(null) && !c.isCoalescable(undefined), 'isCoalescable: bad input → false');

  ok(c.keyFor('get_entity', { name: 'x' }, hashFn) === 'get_entity|{"name":"x"}', 'keyFor: tool + hash');
  ok(c.keyFor('propose_entity', { name: 'x' }, hashFn) === null, 'keyFor: non-read → null');
  ok(c.keyFor('get_entity', { name: 'x' }, () => null) === null, 'keyFor: null hash → null');

  // ── the core behaviour ───────────────────────────────────────────────────────────────────────
  {
    const co = c.createCoalescer({ hashFn });
    let calls = 0;
    const d1 = defer();
    const thunk = () => { calls++; return d1.promise; };

    const a = co.run('search_entities', { q: 'same' }, thunk);
    const b = co.run('search_entities', { q: 'same' }, thunk);
    const z = co.run('search_entities', { q: 'OTHER' }, () => { calls++; return Promise.resolve('other'); });

    ok(a === b, 'identical in-flight read → the SAME promise object');
    ok(a !== z, 'a DIFFERENT question is not coalesced with it');
    ok(calls === 2, `thunk ran once per DISTINCT question (got ${calls}, want 2)`);
    ok(co.stats().coalesced === 1, 'stats: one coalesced');

    d1.resolve('answer');
    const [ra, rb] = await Promise.all([a, b, z]);
    ok(ra === 'answer' && rb === 'answer', "both callers receive the leader's result");

    // the property that makes this NOT a cache
    ok(co._inFlight.size === 0, 'SAFETY: entry removed once settled (not a result cache)');
    let calls2 = 0;
    await co.run('search_entities', { q: 'same' }, () => { calls2++; return Promise.resolve('fresh'); });
    ok(calls2 === 1, 'SAFETY: a caller arriving AFTER settle gets FRESH work, never a stale answer');
  }

  // ── writes pass through, always ──────────────────────────────────────────────────────────────
  {
    const co = c.createCoalescer({ hashFn });
    let writes = 0;
    // each invocation returns its OWN promise — otherwise identity would hold for reasons that have
    // nothing to do with coalescing, and the test would prove nothing
    const wt = () => { writes++; return Promise.resolve(`write-${writes}`); };
    const w1 = co.run('propose_entity', { name: 'dup' }, wt);
    const w2 = co.run('propose_entity', { name: 'dup' }, wt);
    ok(writes === 2, 'SAFETY: two identical concurrent WRITES both execute (neither dropped)');
    ok(w1 !== w2, 'SAFETY: writes get independent promises');
    const [r1, r2] = await Promise.all([w1, w2]);
    ok(r1 === 'write-1' && r2 === 'write-2', 'SAFETY: each write returns its OWN result');
  }

  // ── failure: propagates to all waiters, does not poison the map ──────────────────────────────
  {
    const co = c.createCoalescer({ hashFn });
    const fd = defer();
    const f1 = co.run('get_entity', { n: 1 }, () => fd.promise);
    const f2 = co.run('get_entity', { n: 1 }, () => fd.promise);
    ok(f1 === f2, 'a failing call is shared while in flight');
    fd.reject(new Error('boom'));
    const rs = await Promise.allSettled([f1, f2]);
    ok(rs.every(r => r.status === 'rejected'), 'a rejection reaches BOTH waiters');
    ok(co._inFlight.size === 0, 'SAFETY: a failed call still clears its entry (no poisoning)');
    // and the next caller gets a real attempt, not the cached failure
    let again = 0;
    await co.run('get_entity', { n: 1 }, () => { again++; return Promise.resolve('ok'); });
    ok(again === 1, 'SAFETY: after a failure the next caller retries for real');
  }

  // ── bound ────────────────────────────────────────────────────────────────────────────────────
  {
    const co = c.createCoalescer({ hashFn, maxInFlight: 2 });
    let n = 0;
    const held = defer();
    const p1 = co.run('get_entity', { a: 1 }, () => { n++; return held.promise; });
    const p2 = co.run('get_entity', { a: 2 }, () => { n++; return held.promise; });
    const p3 = co.run('get_entity', { a: 3 }, () => { n++; return held.promise; });   // over the bound
    ok(n === 3, 'over maxInFlight → passes through (correct-but-slower, never breaks)');
    held.resolve(null);
    await Promise.all([p1, p2, p3]);
  }

  // ── savings attribution ──────────────────────────────────────────────────────────────────────
  {
    let t = 1000;
    const co = c.createCoalescer({ hashFn, now: () => t });
    const d = defer();
    co.run('db_query', { sql: 'x' }, () => d.promise);
    t = 1500;                                   // leader has been running 500ms
    co.run('db_query', { sql: 'x' }, () => d.promise);
    const st = co.stats();
    ok(st.savedMs === 500, `savedMs attributes the leader's elapsed time (got ${st.savedMs})`);
    ok(st.rate === 0.5, `rate = coalesced/calls (got ${st.rate})`);
    d.resolve(null);
  }

  // ── non-coalescable tools never even consult the map ─────────────────────────────────────────
  {
    const co = c.createCoalescer({ hashFn });
    await co.run('propose_relation', { a: 1 }, () => Promise.resolve('w'));
    ok(co.stats().coalesced === 0 && co._inFlight.size === 0, 'writes leave no in-flight residue');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
