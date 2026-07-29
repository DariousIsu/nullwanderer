/* Smoke: lib/graph_integrity_tick — the scheduler wire that ends the organ's darkness. Pure core +
 * injected dispatch; every refusal names its door; verify targets never consume budget; dryRun
 * writes nothing (no spend stamp). Offline — a scripted dispatch stands in for echoSuit.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_graph_integrity_tick.js
 */
'use strict';
const T = require('../lib/graph_integrity_tick');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  // --- shapeSnapshot: rows → diff inputs; state resolves from the stripQid'd parent ---
  const snap = T.shapeSnapshot([
    { id: 1, name: 'Kent County', parent: 'Delaware [wd:Q1393]' },
    { id: 2, name: 'Sussex County', parent: null },
    { id: null, name: 'ghost' }, { id: 3, name: '' },
  ]);
  ok(snap.graphPlaces.length === 2, 'shape: only real rows land');
  ok(snap.parentedIds.has(1) && !snap.parentedIds.has(2), 'shape: parented set from the edge');
  ok(snap.stateOf.get(1) === 'DE', 'shape: state resolved from the parent name (QID suffix stripped)');

  // --- pickState: rotation past the cursor; actionable somewhere → picked ---
  const p0 = T.pickState(snap, '');
  ok(p0 && p0.targets.length > 0, 'pick: a sparse graph yields actionable repairs');
  const p1 = T.pickState(snap, 'AL');
  ok(p1 && p1.code !== 'AL', 'pick: cursor rotation moves past the last state');
  ok(p0.targets.every((t) => t.action !== 'verify'), 'pick: verify targets never ride the actionable list');

  // --- runTick refusals name their doors ---
  const meta = {}; const getMeta = (k) => (k in meta ? meta[k] : null); const setMeta = (k, v) => { meta[k] = v; };
  ok((await T.runTick({})).why === 'no-dispatch', 'gate: no dispatch → no-dispatch');
  process.env.ZOE_GRAPH_INTEGRITY = '0';
  ok((await T.runTick({ dispatch: async () => ({ ok: true }) })).why === 'env-off', 'gate: env kill-switch');
  delete process.env.ZOE_GRAPH_INTEGRITY;
  meta['graph_integrity.enabled'] = '0';
  ok((await T.runTick({ dispatch: async () => ({ ok: true }), getMeta, setMeta })).why === 'meta-off', 'gate: meta kill-switch');
  delete meta['graph_integrity.enabled'];
  const today = new Date().toISOString().slice(0, 10);
  meta['graph_integrity.spend'] = JSON.stringify({ day: today, n: 999 });
  ok((await T.runTick({ dispatch: async () => ({ ok: true }), getMeta, setMeta })).why === 'daily-cap', 'gate: daily cap holds');
  delete meta['graph_integrity.spend'];
  ok((await T.runTick({ dispatch: async () => ({ ok: false }), getMeta, setMeta })).why === 'snapshot-failed', 'gate: failed snapshot refuses honestly');

  // --- dryRun happy path: snapshot flows, a state is picked, nothing is written or spent ---
  const calls = [];
  const dispatch = async (msg) => {
    calls.push(msg.args && msg.args.sql ? 'db_query' : msg.name);
    return { ok: true, text: JSON.stringify({ rows: [
      { id: 1, name: 'Kent County', parent: 'Delaware [wd:Q1393]' },
      { id: 2, name: 'Sussex County', parent: null },
    ] }) };
  };
  const r = await T.runTick({ dispatch, getMeta, setMeta, dryRun: true });
  ok(r.ran === true && r.applied > 0, `dryRun: tick runs and counts repairs (applied ${r.applied})`);
  ok(calls.filter((c) => c === 'db_query').length === 1 && calls.length === 1, 'dryRun: ONLY the snapshot query dispatched — zero writes');
  ok(!meta['graph_integrity.spend'], 'dryRun: budget never spent');
  ok(!!meta['graph_integrity.cursor'], 'cursor advances so states rotate across ticks');
  ok(r.applied <= T.BITE_PER_TICK, 'the per-tick bite is bounded');

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
