/**
 * Offline smoke for lib/memory_tiers.js + lib/memory_map.js — ONE MEMORY, TWO TIERS (unification
 * stage 3, 2026-09-02). Fixtures are in-memory better-sqlite3 stores; Echo's half is a fake spawn.
 *
 * Run: node scripts/smoke_memory_map.js
 */
const path = require('path');
const Database = require('better-sqlite3');
const T = require('../lib/memory_tiers');
const M = require('../lib/memory_map');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  // ── classification: explicit > shape > default; a smell is named, never silently defaulted ──
  ok('sq.documents is an explicit short-term record', T.classify('sq', 'documents').kind === 'record' && T.classify('sq', 'documents').declared === 'explicit');
  ok('sq.graph_entity_proposals is staging', T.classify('sq', 'graph_entity_proposals').kind === 'staging');
  ok('sq.agent_events is a log', T.classify('sq', 'agent_events').kind === 'log');
  ok('documents_fts_idx resolves to index by shape', T.classify('sq', 'documents_fts_idx').kind === 'index' && T.classify('sq', 'documents_fts_idx').declared === 'shape');
  const u = T.classify('sq', 'weird_candidates');
  ok('an undeclared *_candidates table resolves by default AND names its staging smell', u.declared === 'default' && u.smell === 'staging' && u.tier === 'short-term');
  ok('a view is an index', T.classify('sq', 'v_anything', 'view').kind === 'index');
  ok('every store on this side is short-term by doctrine', Object.values(T.REGISTRY).every((r) => r.default.tier === T.SHORT));
  let threw = false; try { T.classify('nope', 'x'); } catch { threw = true; }
  ok('an unknown registry throws (never a silent tier)', threw);

  // ── renderStore over an in-memory fixture: kinds, counts (capped), bridges with real SQL ──
  const mem = new Database(':memory:');
  mem.exec(`
    CREATE TABLE documents (id INTEGER PRIMARY KEY, promoted INTEGER DEFAULT 0);
    INSERT INTO documents (promoted) VALUES (0),(0),(0),(1);
    CREATE TABLE graph_relations (id INTEGER PRIMARY KEY, promoted_up INTEGER, deleted INTEGER DEFAULT 0);
    INSERT INTO graph_relations (promoted_up, deleted) VALUES (0,0),(NULL,0),(1,0),(0,1);
    CREATE TABLE graph_entity_proposals (id INTEGER PRIMARY KEY, status TEXT);
    INSERT INTO graph_entity_proposals (status) VALUES ('pending'),('rejected');
    CREATE TABLE agent_events (id INTEGER PRIMARY KEY);
    CREATE TABLE weird_candidates (id INTEGER PRIMARY KEY);
    CREATE VIRTUAL TABLE documents_fts USING fts5(body);
    CREATE VIEW v_docs AS SELECT id FROM documents;
  `);
  for (let i = 0; i < 30; i++) mem.prepare('INSERT INTO agent_events DEFAULT VALUES').run();
  const openFn = () => ({ conn: mem, close() {} });
  const fakeFs = { statSync: () => ({ size: 1234567 }) };
  const s = T.renderStore('sq', { path: 'x/sq.db', registry: 'sq', optional: false, live: true }, { openFn, cap: 10, fs: fakeFs });
  ok('renderStore: reachable, sized', s.reachable === true && s.size_mb === 1.2, JSON.stringify([s.reachable, s.size_mb]));
  ok('renderStore: kinds land per table', s.tables.documents.kind === 'record' && s.tables.graph_entity_proposals.kind === 'staging' && s.tables.agent_events.kind === 'log' && s.tables.v_docs.kind === 'index');
  ok('renderStore: counts are capped (30 rows, cap 10 → "10+")', s.tables.agent_events.rows === '10+' && s.tables.documents.rows === 4);
  ok('renderStore: an FTS vtable is not counted', !('rows' in s.tables.documents_fts));
  ok('renderStore: the undeclared smell rides the entry', s.tables.weird_candidates.smell === 'staging');
  const by = Object.fromEntries(s.bridges.map((b) => [b.from, b]));
  ok('bridge: documents → vault measures promoted=0 (3)', by['sq.documents'] && by['sq.documents'].pending === 3, JSON.stringify(by['sq.documents']));
  ok('bridge: graph_relations → Echo measures promoted_up=0/NULL and not deleted (2)', by['sq.graph_relations'] && by['sq.graph_relations'].pending === 2, JSON.stringify(by['sq.graph_relations']));
  ok('bridge: graph_entity_proposals pending (1)', by['sq.graph_entity_proposals'] && by['sq.graph_entity_proposals'].pending === 1);
  ok('declared-but-missing is drift (e.g. sq.turns absent in the fixture)', s.warnings.some((w) => /sq\.turns: declared but no longer exists/.test(w)), s.warnings.join(' | '));

  // ── render(): tiers, backlog, a missing required store warns, an optional one does not ──
  const paths = {
    sq: { path: 'x/sq.db', registry: 'sq', optional: false, live: true },
    puller: { path: 'x/missing_puller.db', registry: 'puller', optional: true },
    news_bucket: { path: 'x/missing_news.db', registry: 'news_bucket', optional: false },
  };
  const fs2 = { statSync: (p) => { if (/missing/.test(p)) { const e = new Error('ENOENT'); throw e; } return { size: 100 }; } };
  const origRender = T.renderStore;
  const half = T.render({ paths, openFn, cap: 10, nowMs: 1000, fs: fs2 });
  ok('render: side=sq, every table short-term, backlog summed', half.side === 'sq' && half.tiers[T.LONG].tables === 0 && half.tiers[T.SHORT].tables >= 6 && half.backlog === 3 + 2 + 1, JSON.stringify([half.tiers, half.backlog]));
  ok('render: a missing REQUIRED store warns, a missing optional one does not', half.warnings.some((w) => /news_bucket: store missing/.test(w)) && !half.warnings.some((w) => /puller/.test(w)), half.warnings.join(' | '));
  void origRender;

  // ── ⭐ CONTINUITY (Lucas 09-02: "all the memory rechecked for continuity across all memory schema") ──
  ok('every store on this side keeps ONE clock (epoch-ms)', s.clock === 'epoch-ms' && half.clocks.sq === 'epoch-ms' && T.CLOCK === 'epoch-ms');
  ok('every declared staging table on this side has a bridge (no exit-less staging in the registry)',
    Object.entries(T.REGISTRY.sq.tables).filter(([, d]) => d.kind === 'staging').every(([t]) => T.BRIDGES.some((b) => b.from[0] === 'sq' && b.from[1] === t)),
    Object.entries(T.REGISTRY.sq.tables).filter(([t, d]) => d.kind === 'staging' && !T.BRIDGES.some((b) => b.from[1] === t)).map(([t]) => t).join(','));
  {
    // a NEW staging table declared without a bridge is drift — probe via a temporary declaration
    T.REGISTRY.sq.tables.__probe_proposals = { tier: T.SHORT, kind: 'staging', note: 'probe' };
    mem.exec('CREATE TABLE __probe_proposals (id INTEGER PRIMARY KEY)');
    const s2 = T.renderStore('sq', { path: 'x/sq.db', registry: 'sq', optional: false, live: true }, { openFn, cap: 10, fs: fakeFs });
    ok('⭐ staging with no bridge is a WARNING, not a quiet default', s2.warnings.some((w) => /sq\.__probe_proposals: staging with no promotion bridge/.test(w)), s2.warnings.join(' | '));
    delete T.REGISTRY.sq.tables.__probe_proposals; mem.exec('DROP TABLE __probe_proposals');
  }
  {
    // last-crossed rides the bridge where a timestamp exists; continuityOf names stalls + dead ends
    mem.exec('ALTER TABLE documents ADD COLUMN updated_ts INTEGER; UPDATE documents SET updated_ts = 5000 WHERE promoted = 1');
    const s3 = T.renderStore('sq', { path: 'x/sq.db', registry: 'sq', optional: false, live: true }, { openFn, cap: 10, fs: fakeFs });
    const doc = s3.bridges.find((b) => b.from === 'sq.documents');
    ok('bridge: documents carries last_crossed = MAX(updated_ts) of promoted rows', doc.last_crossed === 5000 && doc.last_measured === true && doc.built === true, JSON.stringify(doc));
    const rel = s3.bridges.find((b) => b.from === 'sq.graph_relations');
    ok('bridge: graph_relations has no timestamp → last_measured false (honest unmeasured)', rel.last_measured === false && rel.last_crossed === null);
    const day = 86400000;
    const c1 = T.continuityOf([
      { from: 'a', to: 'b', gate: 'g', pending: 3, built: true, last_measured: true, last_crossed: 100 * day - 30 * day },
      { from: 'c', to: 'd', gate: 'g', pending: 3, built: true, last_measured: true, last_crossed: 100 * day - 2 * day },
      { from: 'e', to: 'f', gate: 'never written', pending: 9, built: false, last_measured: false, last_crossed: null },
      { from: 'h', to: 'i', gate: 'g', pending: 4, built: true, last_measured: true, last_crossed: null },
      { from: 'j', to: 'k', gate: 'g', pending: 4, built: true, last_measured: false, last_crossed: null },
      { from: 'l', to: 'm', gate: 'g', pending: 0, built: true, last_measured: true, last_crossed: null },
    ], 100 * day);
    ok(`⭐ continuity: quiet > STALL_DAYS (${T.STALL_DAYS}) = STALLED; quiet 2 days is not`, c1.stalled.some((x) => x.from === 'a' && x.days === 30 && /quiet 30 days/.test(x.why)) && !c1.stalled.some((x) => x.from === 'c'), JSON.stringify(c1.stalled));
    ok('⭐ continuity: a gate never built = DEAD END (its rows counted)', c1.dead_ends.length === 1 && c1.dead_ends[0].from === 'e' && c1.dead_ends[0].pending === 9 && /never built/.test(c1.dead_ends[0].why));
    ok('⭐ continuity: pending rows that NEVER crossed (timestamp exists, none set) = stalled "never crossed"', c1.stalled.some((x) => x.from === 'h' && x.why === 'never crossed'));
    ok('continuity: no timestamp to measure → never called stalled; nothing pending → never stalled', !c1.stalled.some((x) => x.from === 'j' || x.from === 'l'));
  }
  {
    // the sweep for files outside the map (fake fs): unknown non-empty = unmapped (+warning),
    // dated archives are declared, 0-byte = phantoms, Chromium *_profile dirs are never entered
    const ent = (name, dir = false) => ({ name, isDirectory: () => dir, isFile: () => !dir });
    const tree = { 'D:/data': [ent('sq.db'), ent('stray.db'), ent('sq_eloise_archive_20260618_201852.db'), ent('ghost.db'), ent('web_profile', true), ent('sub', true), ent('notes.txt')],
      'D:/data/web_profile': [ent('first_party_sets.db')], 'D:/data/sub': [ent('deep.sqlite')] };
    const sizes = { 'stray.db': 2_500_000, 'ghost.db': 0, 'sq_eloise_archive_20260618_201852.db': 6_300_000, 'deep.sqlite': 10, 'first_party_sets.db': 69632, 'sq.db': 5 };
    const fakeFs2 = { readdirSync: (d) => tree[d.split(path.sep).join('/')] || [], statSync: (p) => ({ size: sizes[path.basename(p)] }) };
    const sw = T.sweepUnmapped('D:/data', { sq: { path: 'D:/data/sq.db' } }, { fs: fakeFs2 });
    ok('⭐ sweep: unknown non-empty files are OUTSIDE THE MAP; the known store is not', sw.unmapped.map((u) => u.path).sort().join(',') === 'stray.db,sub/deep.sqlite', JSON.stringify(sw));
    ok('sweep: a dated archive is declared as archive (never a warning), a 0-byte file is a phantom', sw.archives.length === 1 && /archive_20260618/.test(sw.archives[0].path) && sw.phantoms.length === 1 && sw.phantoms[0].path === 'ghost.db');
    ok('sweep: Chromium *_profile dirs are browser state, never memory — not entered', !JSON.stringify(sw).includes('first_party_sets'));
    ok('sweep: a fake fs without readdirSync sweeps nothing (the fixture render above listed no disk)', T.sweepUnmapped('D:/x', {}, { fs: {} }).unmapped.length === 0 && half.unmapped.length === 0 && half.phantoms.length === 0);
  }

  // ── assemble(): the two halves become one map; a missing half is SAID, never assumed ──
  const echoHalf = {
    side: 'echo', tiers: { 'short-term': { tables: 40, stores: ['saga', 'jobs'] }, 'long-term': { tables: 300, stores: ['civic_graph', 'electoral'] } },
    bridges: [{ from: 'tenant_rainey.entity_proposals', to: 'civic_graph.entities', gate: 'promote_proposal', pending: 153820 }, { from: 'civic_graph.resolution_proposals', to: 'civic_graph.entities', gate: 'run_dedup_adjudication', pending: 33299 }],
    cross_file_staging: [{ store: 'civic_graph', table: 'resolution_proposals', kind: 'staging', rows: 45931, note: 'inside the long-term file' }],
    warnings: [],
  };
  const raw = M.assemble({ echo: echoHalf, sq: half, nowMs: 5000 });
  ok('assemble: warnings carry over side-prefixed (the fixture half has drift + a missing store)', half.warnings.length > 0 && raw.warnings.length === half.warnings.length && raw.warnings.every((w) => /^sq: /.test(w)));
  const cleanHalf = { ...half, warnings: [] };
  const map = M.assemble({ echo: echoHalf, sq: cleanHalf, nowMs: 5000 });
  ok('assemble: tiers sum across halves with side-qualified stores', map.tiers['long-term'].tables === 300 && map.tiers['short-term'].tables === 40 + half.tiers['short-term'].tables && map.tiers['long-term'].stores.includes('echo.civic_graph') && map.tiers['short-term'].stores.includes('sq.sq'));
  ok('assemble: backlog sums both halves', map.backlog === 153820 + 33299 + 6, String(map.backlog));
  ok('assemble: both halves present', map.halves.echo && map.halves.sq && map.warnings.length === 0);
  const noEcho = M.assemble({ echo: { error: 'exit 2: boom' }, sq: cleanHalf, nowMs: 5000 });
  ok('assemble: a missing Echo half is a NAMED warning, not a silent zero', noEcho.halves.echo === false && noEcho.warnings.some((w) => /echo half unavailable: exit 2: boom/.test(w)));

  // ── describe(): the one-liner + the block ──
  const d = M.describe(map);
  ok('describe: the one-liner names both tiers and the backlog', /one memory: \d[\d,]* short-term \/ 300 long-term tables · promotion backlog 187,125 rows/.test(d.line), d.line);
  ok('describe: the block leads with the tiers, then bridges sorted by backlog', d.block[0].startsWith('One memory, two tiers') && /Promotion bridges \(backlog 187,125 rows[^)]*\): tenant_rainey\.entity_proposals → civic_graph\.entities: 153,820 pending/.test(d.block[1]), d.block[1]);
  ok('describe: cross-file staging is named', d.block.some((l) => /Short-term staging living inside a long-term file: civic_graph\.resolution_proposals \(45,931\)/.test(l)));
  ok('describe: no warnings → says so', d.block.some((l) => /Tier warnings: none/.test(l)));
  const dn = M.describe(noEcho);
  ok('describe: a partial map says which half is missing', /\(Echo half missing\)/.test(dn.line) && /Tier warnings \(1\)/.test(dn.block.find((l) => /Tier warnings/.test(l)) || ''));
  ok('describe: an empty map is null/empty (fail-absent)', M.describe(null).line === null && M.describe(null).block.length === 0);
  {
    // ⭐ continuity + outside-the-map ride BOTH halves into the one map, side-tagged, and the line names them
    const echoC = { ...echoHalf, continuity: { dead_ends: [{ from: 'electoral._pending_data_stream_tags', to: 'x', pending: 23504, gate: 'never built', why: 'gate never built' }], stalled: [{ from: 'tenant_rainey.inbox', to: 'y', pending: 11064, gate: 'g', last_crossed: null, days: null, why: 'never crossed' }] },
      unmapped: [], phantoms: [{ path: 'sq.db', note: '0 bytes' }], clocks: { civic_graph: 'epoch-s' } };
    const sqC = { ...cleanHalf, continuity: { dead_ends: [], stalled: [{ from: 'sq.capability_needs', to: 'z', pending: 31, gate: 'g', last_crossed: 1, days: 40, why: 'quiet 40 days' }] }, unmapped: [{ path: 'stray.db', size_mb: 2.5 }], phantoms: [], clocks: { sq: 'epoch-ms' } };
    const mc = M.assemble({ echo: echoC, sq: sqC, nowMs: 5000 });
    ok('assemble: dead ends + stalls merge side-tagged', mc.continuity.dead_ends.length === 1 && mc.continuity.dead_ends[0].side === 'echo' && mc.continuity.stalled.map((s) => s.side).join(',') === 'sq,echo');
    ok('assemble: unmapped + phantoms + clocks merge side-qualified', mc.unmapped[0].side === 'sq' && mc.phantoms[0].side === 'echo' && mc.clocks['echo.civic_graph'] === 'epoch-s' && mc.clocks['sq.sq'] === 'epoch-ms');
    const dc = M.describe(mc);
    ok('describe: the one-liner names the discontinuities and the files outside the map', /continuity: 1 dead end\(s\), 2 stalled bridge\(s\) · 1 store\(s\) outside the map/.test(dc.line), dc.line);
    ok('describe: the block carries the continuity line and the outside-the-map line', dc.block.some((l) => /^Continuity — memory that enters and never leaves: DEAD END electoral\._pending_data_stream_tags \(23,504 rows, gate never built\) · STALLED sq\.capability_needs \(31 pending, quiet 40 days\) · STALLED tenant_rainey\.inbox \(11,064 pending, never crossed\)\./.test(l)) && dc.block.some((l) => /^Outside the map: sq:stray\.db \(2\.5 MB, unmapped\) · echo:sq\.db \(phantom — 0 bytes\)\./.test(l)), dc.block.join('\n'));
    ok('describe: a clean map says continuity holds', d.block.some((l) => /^Continuity: every bridge has a built gate/.test(l)) && !/continuity:/.test(d.line));
  }

  // ── readEchoMap(): the Echo spawn contract (fake spawn) ──
  const mkSpawn = (stdout, code) => () => { const h = {}; const proc = { on(ev, fn) { h[ev] = fn; }, kill() {}, stdout: { on(ev, fn) { h.out = fn; } }, stderr: { on(ev, fn) { h.err = fn; } } };
    setTimeout(() => { if (stdout) h.out(Buffer.from(stdout)); if (code !== 0) h.err(Buffer.from('bad')); h.exit(code); }, 5); return proc; };
  const good = await M.readEchoMap({ python: 'py', cwd: 'x', spawnFn: mkSpawn(JSON.stringify(echoHalf), 0) });
  ok('readEchoMap: JSON on stdout + exit 0 → the half', good.side === 'echo' && good.tiers['long-term'].tables === 300);
  const bad = await M.readEchoMap({ python: 'py', cwd: 'x', spawnFn: mkSpawn('', 2) });
  ok('readEchoMap: a non-zero exit → { error } with the stderr tail', /^exit 2: bad/.test(bad.error), bad.error);
  const junk = await M.readEchoMap({ python: 'py', cwd: 'x', spawnFn: mkSpawn('not json', 0) });
  ok('readEchoMap: unreadable stdout → { error }', /^unreadable/.test(junk.error));
  const none = await M.readEchoMap({ python: null, cwd: null });
  ok('readEchoMap: no python/cwd → { error }, never a throw', /no python/.test(none.error));

  // ── refresh(): stores the merged map in meta ──
  const meta = {};
  const fakeDb = { setMeta: (k, v) => { meta[k] = v; }, getMeta: (k) => meta[k] };
  const r = await M.refresh({ deps: { db: fakeDb, tiers: { render: () => half }, echoMap: echoHalf }, nowMs: 9000 });
  ok('refresh: merges and persists under memory.map', r.at === 9000 && JSON.parse(meta[M.META_KEY]).backlog === 187125);
  ok('stored(): reads it back (null when absent)', M.stored({ db: fakeDb }).backlog === 187125 && M.stored({ db: { getMeta: () => null } }) === null);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
