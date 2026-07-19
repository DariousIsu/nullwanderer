/* smoke_route_obs.js — memory path mapping P0: the route observation log.
 * Pure-function coverage (no db, no engine). Run via scripts/run_smokes.js.
 *
 * The load-bearing tests here are the PRIVACY ones (§"shapes never values") and the MISS-vs-ERROR
 * split — a transport failure must never be recordable as evidence of absence, because the absence
 * model (P3) and the gap detector are built on top of misses.
 */
'use strict';
const ro = require('../lib/route_obs');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── sqlTables ──────────────────────────────────────────────────────────────────────────────────
ok(JSON.stringify(ro.sqlTables('SELECT * FROM entities WHERE id=5')) === '["entities"]',
  'sqlTables: simple FROM');
ok(JSON.stringify(ro.sqlTables(
  'SELECT r.x FROM relations r JOIN entities e ON e.id=r.source_id')) === '["entities","relations"]',
  'sqlTables: FROM + JOIN, sorted');
ok(JSON.stringify(ro.sqlTables('select a from T1 join t1 on 1=1')) === '["t1"]',
  'sqlTables: case-insensitive + deduped');
ok(ro.sqlTables('').length === 0 && ro.sqlTables(null).length === 0, 'sqlTables: empty/null → []');

// ── argShape: SHAPES, NEVER VALUES. This is the privacy invariant of the whole log. ────────────
ok(ro.argShape({ entity_id: 5, top_k: 8 }) === 'entity_id:int,top_k:int', 'argShape: ints');
ok(ro.argShape({ name: 'Jane Doe' }) === 'name:str', 'argShape: string VALUE never recorded');
ok(!/Jane|Doe/.test(ro.argShape({ name: 'Jane Doe', note: 'ssn 123-45-6789' })),
  'argShape: PRIVACY — no personal value leaks through');
ok(ro.argShape({ b: 1, a: 2 }) === 'a:int,b:int', 'argShape: keys sorted (stable shape)');
ok(ro.argShape({ xs: [1, 2, 3] }) === 'xs:arr[3]', 'argShape: array → length only');
ok(ro.argShape({ f: 1.5, t: true, z: null }) === 'f:num,t:bool,z:null', 'argShape: num/bool/null');
ok(ro.argShape({ o: { a: 1 } }) === 'o:obj', 'argShape: nested object not descended into');
ok(ro.argShape(null) === '' && ro.argShape(undefined) === '', 'argShape: null/undefined → empty');

const sqlShape = ro.argShape({ sql: "SELECT name FROM entities WHERE name='Jane Doe' JOIN relations r ON 1=1" });
ok(sqlShape === 'sql:tables(entities|relations)', 'argShape: SQL → tables touched');
ok(!/Jane|Doe|SELECT/i.test(sqlShape), 'argShape: PRIVACY — SQL literals never recorded');
ok(ro.argShape({ sql: 'PRAGMA foo' }) === 'sql:sql', 'argShape: SQL with no tables → generic');

const long = ro.argShape(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, 1])));
ok(long.length <= 200, 'argShape: capped so a pathological arg cannot bloat the log');

// ── resultShape ────────────────────────────────────────────────────────────────────────────────
ok(ro.resultShape({ text: '{"rows":[1,2,3]}' }) === 'rows:3', 'resultShape: rows counted');
ok(ro.resultShape({ text: '{"rows":[]}' }) === 'rows:0', 'resultShape: empty rows still counted');
ok(ro.resultShape({ text: '{"neighbors":[1]}' }) === 'neighbors:1', 'resultShape: neighbors');
ok(ro.resultShape({ text: '[1,2]' }) === 'rows:2', 'resultShape: bare array');
ok(ro.resultShape({ text: '' }) === 'empty', 'resultShape: no text → empty');
ok(ro.resultShape({ isError: true, text: 'boom' }) === 'error', 'resultShape: error flagged');
ok(ro.resultShape({ text: 'plain words' }) === 'text:11', 'resultShape: non-JSON → length');
ok(ro.resultShape({ text: '{"ok":false}' }) === 'notok', 'resultShape: payload-level failure');
ok(ro.resultShape(null) === 'none', 'resultShape: null → none');

// ── classify: MISS vs ERROR must stay distinct ─────────────────────────────────────────────────
ok(ro.classify({ text: '{"rows":[1]}' }) === 'hit', 'classify: rows>0 → hit');
ok(ro.classify({ text: '{"rows":[]}' }) === 'miss', 'classify: rows=0 → MISS (a real answer)');
ok(ro.classify({ text: '' }) === 'miss', 'classify: empty → miss');
ok(ro.classify({ isError: true }) === 'error', 'classify: transport error → ERROR, not miss');
ok(ro.classify({ blocked: true, ok: false }) === 'error', 'classify: tier-gate block → error');
ok(ro.classify({ ok: false, text: '{"rows":[1]}' }) === 'error', 'classify: ok:false → error');
ok(ro.classify(null) === 'error', 'classify: null → error');
ok(ro.classify({ text: '{"ok":false}' }) === 'error', 'classify: notok → error not miss');
// the invariant, stated directly:
ok(ro.classify({ isError: true }) !== 'miss',
  'INVARIANT: a transport failure is NEVER recorded as a miss (absence needs evidence)');

// ── tag → tool identity ────────────────────────────────────────────────────────────────────────
ok(ro.tagTool({ kind: 'do', name: 'db_query' }) === 'db_query', 'tagTool: do');
ok(ro.tagTool({ kind: 'recipe', name: 'search-vault' }) === 'recipe:search-vault', 'tagTool: recipe');
ok(ro.tagTool({ kind: 'propose', proposeKind: 'entity' }) === 'propose_entity', 'tagTool: propose');
ok(ro.tagTool({ kind: 'delegate' }) === 'spawn_agent_async', 'tagTool: delegate');
ok(ro.tagTool({ kind: 'find', query: 'x' }) === 'find', 'tagTool: find');
ok(ro.tagTool({ kind: 'guide' }) === 'guide', 'tagTool: guide');
ok(ro.tagTool(null) === null && ro.tagTool({}) === null, 'tagTool: bad tag → null');

ok(ro.argShape(ro.tagArgs({ kind: 'find', query: 'secret name' })) === 'query:str',
  'tagArgs: PRIVACY — find query recorded as shape only');
ok(ro.argShape(ro.tagArgs({ kind: 'recipe', name: 'r', arg: 'Jane Doe' })) === 'arg:str',
  'tagArgs: PRIVACY — recipe arg recorded as shape only');

// ── buildObs ───────────────────────────────────────────────────────────────────────────────────
const obs = ro.buildObs(
  { kind: 'do', name: 'kg_neighborhood', args: { entity_id: 7, top_k: 5 } },
  { text: '{"neighbors":[1,2]}' },
  { ts: 1000, latencyMs: 42.6, focusId: 'beat-x', autonomous: true }
);
ok(obs.tool === 'kg_neighborhood', 'buildObs: tool');
ok(obs.arg_shape === 'entity_id:int,top_k:int', 'buildObs: arg shape');
ok(obs.result_shape === 'neighbors:2' && obs.outcome === 'hit', 'buildObs: result + outcome');
ok(obs.latency_ms === 43, 'buildObs: latency rounded');
ok(obs.focus_id === 'beat-x' && obs.autonomous === 1, 'buildObs: focus + autonomous carried');
ok(obs.ts === 1000, 'buildObs: ts injected (deterministic under test)');
ok(ro.buildObs({}, {}, { ts: 1 }) === null, 'buildObs: unusable tag → null');

const missObs = ro.buildObs({ kind: 'do', name: 'search_entities', args: { name: 'Nobody' } },
  { text: '{"results":[]}' }, { ts: 2000 });
ok(missObs.outcome === 'miss' && missObs.result_shape === 'results:0',
  'buildObs: a genuine empty answer records as a MISS — the gap signal P3/P4 build on');
ok(!/Nobody/.test(JSON.stringify(missObs)), 'buildObs: PRIVACY — no value anywhere in the row');

// ── the flag is off by default (P0 ships inert) ────────────────────────────────────────────────
ok(ro.FLAG === 'route.obs', 'flag name is route.obs');
ok(typeof ro.enabled === 'function' && typeof ro.record === 'function', 'impure edge exported');
ok(ro.record({ kind: 'do', name: 'x' }, { text: '{}' }) === null,
  'record: no db initialised → fail-soft null, never throws');

// ── arg_hash: equality WITHOUT values. The whole point of P2's utility gate. ────────────────────
ok(ro.canonicalize({ b: 1, a: 2 }) === ro.canonicalize({ a: 2, b: 1 }),
  'canonicalize: key ORDER does not change the result (else one call logs as two questions)');
ok(ro.canonicalize({ a: [1, { z: 1, y: 2 }] }) === '{"a":[1,{"y":2,"z":1}]}', 'canonicalize: nested + sorted');
ok(ro.canonicalize(null) === 'null' && ro.canonicalize(5) === '5', 'canonicalize: scalars');

const S = 'test-salt';
ok(ro.argHash({ name: 'Jane' }, S) === ro.argHash({ name: 'Jane' }, S), 'argHash: same args → same hash');
ok(ro.argHash({ name: 'Jane' }, S) !== ro.argHash({ name: 'John' }, S), 'argHash: different args → different hash');
ok(ro.argHash({ a: 1, b: 2 }, S) === ro.argHash({ b: 2, a: 1 }, S), 'argHash: key order irrelevant');
ok(ro.argHash({ name: 'Jane' }, S) !== ro.argHash({ name: 'Jane' }, 'other-salt'), 'argHash: salt changes the digest');
ok(!/Jane/.test(String(ro.argHash({ name: 'Jane' }, S))), 'argHash: PRIVACY — value not present in digest');
ok(/^[0-9a-f]{16}$/.test(ro.argHash({ x: 1 }, S)), 'argHash: 16 hex chars');
ok(ro.argHash(null, S) === null, 'argHash: null args → null');

const hObs = ro.buildObs({ kind: 'do', name: 'get_entity', args: { name: 'Jane Doe' } },
  { text: '{"rows":[1]}' }, { ts: 1, salt: S });
ok(hObs.arg_hash && hObs.arg_hash.length === 16, 'buildObs: carries arg_hash');
ok(!/Jane|Doe/.test(JSON.stringify(hObs)), 'buildObs: PRIVACY holds WITH the hash present');
ok(hObs.arg_hash === ro.buildObs({ kind: 'do', name: 'get_entity', args: { name: 'Jane Doe' } },
  { text: '{"rows":[]}' }, { ts: 999, salt: S }).arg_hash,
  'buildObs: same question at a different time / different RESULT → same hash (repeat detectable)');

// ── error surfacing: the fix for the ROOT cause (a diagnostic that existed but nobody printed) ──
{
  const seen = [];
  const realErr = console.error;
  console.error = (...a) => seen.push(a.join(' '));
  try {
    const row = { tool: 'search_entities', arg_shape: 'limit:int,query:str', outcome: 'error' };
    ro.surfaceError(row, { text: '1 validation error\nlimit\n  Unexpected keyword argument' });
    ro.surfaceError(row, { text: 'same again' });
    ro.surfaceError(row, { text: 'and again' });
    ro.surfaceError({ tool: 'search_entities', arg_shape: 'query:str,top_k:int', outcome: 'error' }, { text: 'different shape' });
    ro.surfaceError({ tool: 'x', arg_shape: 'a:int', outcome: 'hit' }, { text: 'should not print' });
    ro.surfaceError({ tool: 'y', arg_shape: 'a:int', outcome: 'miss' }, { text: 'should not print' });
  } finally { console.error = realErr; }

  ok(seen.length === 2, `surfaceError: de-duped per (tool,arg_shape) — got ${seen.length}, want 2`);
  ok(/Unexpected keyword argument/.test(seen[0]), 'surfaceError: prints the real diagnostic');
  ok(/search_entities\(limit:int,query:str\)/.test(seen[0]), 'surfaceError: names tool + arg shape');
  ok(!seen.join(' ').includes('should not print'), 'surfaceError: only errors surface, never hit/miss');
  ok(!/\n/.test(seen[0]), 'surfaceError: newlines collapsed (one line per error)');

  const longSeen = [];
  const r2 = console.error; console.error = (...a) => longSeen.push(a.join(' '));
  try { ro.surfaceError({ tool: 'z', arg_shape: 'q:str', outcome: 'error' }, { text: 'x'.repeat(5000) }); }
  finally { console.error = r2; }
  ok(longSeen[0].length < 400, 'surfaceError: text hard-capped (cannot flood the log)');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
