/* smoke_route_derive.js — P1 route derivation from linked observations.
 *
 * The load-bearing tests: branching chains split correctly, a template's cross-episode flag is only
 * true when it genuinely spans >1 focus, and a lone unlinked call is never a route.
 */
'use strict';
const rd = require('../lib/route_derive');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// tiny row factory
let _id = 0;
function row(tool, parent, { focus = 'f1', ms = 100, outcome = 'hit', seq = 0 } = {}) {
  return { id: ++_id, tool, parent_id: parent, focus_id: focus, latency_ms: ms, outcome, seq };
}

// ── extractChains: a straight chain ─────────────────────────────────────────────────────────────
{
  _id = 0;
  const a = row('search_entities', null);
  const b = row('kg_neighborhood', a.id);
  const c = row('get_entity', b.id);
  const chains = rd.extractChains([a, b, c]);
  ok(chains.length === 1, 'straight chain → one chain');
  ok(chains[0].map(r => r.tool).join(',') === 'search_entities,kg_neighborhood,get_entity', 'chain preserves order');
}

// ── branching: one parent, two children → two chains sharing the prefix ─────────────────────────
{
  _id = 0;
  const a = row('search_entities', null);
  const b = row('kg_neighborhood', a.id);
  const c = row('get_entity', a.id);
  const chains = rd.extractChains([a, b, c]);
  ok(chains.length === 2, `branch → two chains (got ${chains.length})`);
  ok(chains.every(ch => ch[0].tool === 'search_entities'), 'both branches share the root');
}

// ── a lone call, or a single unlinked pair, is not a route ──────────────────────────────────────
{
  _id = 0;
  const solo = row('search_entities', null);
  ok(rd.extractChains([solo]).length === 0, 'lone call → no chain (a route needs a hop)');
}

// ── parent outside the set → treated as a root ──────────────────────────────────────────────────
{
  _id = 0;
  const b = row('kg_neighborhood', 9999);  // parent not present
  const c = row('get_entity', b.id);
  const chains = rd.extractChains([b, c]);
  ok(chains.length === 1 && chains[0][0].tool === 'kg_neighborhood', 'orphaned parent → child is the root');
}

// ── cycle guard: must terminate, never loop ─────────────────────────────────────────────────────
{
  // pure 2-cycle with no root → no entry point → [] (safe: terminates, invents nothing)
  _id = 0;
  const a = row('search_entities', null);
  const b = row('kg_neighborhood', a.id);
  a.parent_id = b.id;                        // a ⇄ b, neither is a root
  const chains = rd.extractChains([a, b]);
  ok(Array.isArray(chains) && chains.length === 0, 'rootless cycle → [] (terminates, no infinite loop)');
}
{
  // rooted cycle: root → x → y → x. The seen-guard must stop the walk re-entering x.
  _id = 0;
  const root = row('db_query', null);
  const x = row('search_entities', root.id);
  const y = row('get_entity', x.id);
  x.parent_id = root.id;                      // keep x rooted
  y.parent_id = x.id;
  // add the back-edge that would loop: y also parents x's twin — emulate by pointing a child of y at x
  const z = row('kg_neighborhood', y.id);
  z.parent_id = y.id;
  const chains = rd.extractChains([root, x, y, z]);
  ok(chains.length >= 1 && chains[0][0].tool === 'db_query', 'rooted chain with a deep tail terminates and keeps the root');
}

// ── deriveTemplates: two identical-shape chains roll into ONE template with count 2 ─────────────
{
  _id = 0;
  const mk = (focus) => { const a = row('search_entities', null, { focus }); const b = row('kg_neighborhood', a.id, { focus }); return [a, b]; };
  const rows = [...mk('f1'), ...mk('f1')];
  const t = rd.deriveTemplates(rows);
  ok(t.length === 1, 'two same-shape chains → one template');
  ok(t[0].count === 2, 'template count = 2');
  ok(t[0].key === 'search_entities → kg_neighborhood', 'template key is the tool sequence');
  ok(t[0].crossEpisode === false, 'both chains in one focus → NOT cross-episode');
  ok(t[0].focusCount === 1, 'focusCount = 1');
}

// ── the load-bearing distinction: same template across TWO focuses → crossEpisode ───────────────
{
  _id = 0;
  const mk = (focus) => { const a = row('search_entities', null, { focus }); const b = row('kg_neighborhood', a.id, { focus }); return [a, b]; };
  const rows = [...mk('f1'), ...mk('f2')];
  const t = rd.deriveTemplates(rows);
  ok(t.length === 1 && t[0].crossEpisode === true, 'same template in 2 focuses → crossEpisode true');
  ok(t[0].focusCount === 2, 'focusCount = 2');
}

// ── savings ceiling + tail outcome ──────────────────────────────────────────────────────────────
{
  _id = 0;
  const mk = (outcome) => { const a = row('search_entities', null, { ms: 1000 }); const b = row('get_entity', a.id, { ms: 1000, outcome }); return [a, b]; };
  const rows = [...mk('hit'), ...mk('miss')];
  const t = rd.deriveTemplates(rows)[0];
  ok(t.totalMs === 4000, 'totalMs sums all step latencies across chains');
  // 2 chains, ceiling = totalMs * (count-1)/count = 4000 * 1/2 = 2000
  ok(t.savingsCeilingMs === 2000, `savings ceiling = later-instance time (got ${t.savingsCeilingMs})`);
  ok(t.tail.hit === 1 && t.tail.miss === 1, 'tail outcome mix tracked (does the route LAND?)');
}

// ── derive(): the full report, and its honest headline ──────────────────────────────────────────
{
  _id = 0;
  const mk = (focus) => { const a = row('search_entities', null, { focus }); const b = row('kg_neighborhood', a.id, { focus }); return [a, b]; };
  // an unlinked row must be ignored by derive (seq null)
  const noise = { id: ++_id, tool: 'x', parent_id: null, focus_id: 'f1', latency_ms: 5, outcome: 'hit', seq: null };
  const oneFocus = rd.derive([...mk('f1'), ...mk('f1'), noise]);
  ok(oneFocus.crossEpisodeTemplates.length === 0, 'one-focus corpus → no cross-episode templates');
  ok(/within-episode structure only/.test(oneFocus.summary.note), 'headline is honest about single-focus limits');
  ok(oneFocus.linkedObservations === 4, 'unlinked (seq null) rows excluded from derivation');

  _id = 0;
  const multi = rd.derive([...mk('f1'), ...mk('f2'), ...mk('f3')]);
  ok(multi.crossEpisodeTemplates.length === 1, 'three-focus corpus → the template is cross-episode');
  ok(/recur across >1 focus/.test(multi.summary.note), 'headline flags a candidate durable route');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
