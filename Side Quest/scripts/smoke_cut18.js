/* smoke_cut18.js — CUT 18 (2026-09-03): the Side Quest siblings from the post-freeze stall ledger.
 *
 * Measured since the 01:24 freeze (17h, data/stall_attrib.log): findUndecomposed 59 × ≥1s (317s),
 * listValueScopedTargets 70 × (130s), searchDocuments 7 × + a 16s profiled block, gatherFragments 6
 * blocks / 32s, localdb inventory 7 blocks / 14.7s, promoteDocsBacklog 4 × + 9.9s of blocks,
 * getRecentMonologueByType 7 × (12s), web.ensure's module load + spawn 8.4s + 6.3s, foldOnce 1.4s per
 * tick, getKnowledgeVectorRows 1.2–1.6s. Each cure here is pinned by its MECHANISM (a query plan, a
 * worker door, a head read), never by "runs". Hermetic temp files for sq.db and puller.db.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_cut18.js
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cut18-smoke-'));
process.env.SQ_DB_PATH = path.join(tmp, 'sq.db');
process.env.PULLER_DB_PATH = path.join(tmp, 'puller.db');
const db = require('../lib/db');
db.init();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const plan = (sql, params = []) => db.getDb().prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map((r) => r.detail).join(' | ');
const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

(async () => {
  // ── 1. the three index cures, pinned by their PLANS ────────────────────────────────────────────
  console.log('index cures (plans):');
  const pm = plan('SELECT * FROM monologue WHERE type = ? ORDER BY id DESC LIMIT ?', ['reading', 5]);
  ok(/idx_monologue_type_id/.test(pm) && !/TEMP B-TREE/.test(pm), `getRecentMonologueByType walks idx_monologue_type_id, no temp B-tree (${pm})`);
  // NB: SQLite's plan text says "USING INDEX", not "COVERING", for a partial index whose predicate names a
  // column outside the index — but the bytecode reads every selected column from the index cursor.
  // Measured on a 60k-row table with 7.5KB blobs on one row in eight: 39ms → 3ms for the same 7,500 rows.
  const pk = plan('SELECT id, kind, source, importance, created_ts, last_used_ts, level, parent_id FROM knowledge WHERE embedding IS NOT NULL');
  ok(/USING (?:COVERING )?INDEX idx_knowledge_vec_meta/.test(pk), `getKnowledgeVectorRows walks idx_knowledge_vec_meta — no row (blob) pages (${pk})`);
  const pd = plan('SELECT COUNT(*) n FROM documents INDEXED BY idx_documents_backlog WHERE promoted = 0 AND superseded_by IS NULL');
  ok(/idx_documents_backlog/.test(pd) && /COVERING/.test(pd), `promoteDocsBacklog's pending COUNT is covered by idx_documents_backlog (${pd})`);
  const pe = plan("SELECT substr(promote_error, 1, 60) error, COUNT(*) n FROM documents INDEXED BY idx_documents_backlog WHERE promoted = 0 AND superseded_by IS NULL AND promote_error IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 4");
  ok(/idx_documents_backlog/.test(pe) && /COVERING/.test(pe), `…and its error histogram reads the same index, pinned by INDEXED BY (${pe})`);
  ok((src('lib/db.js').match(/FROM documents INDEXED BY idx_documents_backlog WHERE promoted = 0/g) || []).length === 3, 'all three backlog statements carry the INDEXED BY pin');

  // ── 2. searchDocuments: the IDS shape + the title-only fallback ────────────────────────────────
  console.log('\nsearchDocuments (IDS shape, title-only fallback):');
  const d1 = db.insertDocument({ title: 'Alpha roster', body: 'the quorum needle sits in this body', source: 'smoke' });
  const d2 = db.insertDocument({ title: 'Beta roster', body: 'no match words here at all', source: 'smoke' });
  const d3 = db.insertDocument({ title: 'Gamma superseded', body: 'the quorum needle again', source: 'smoke' });
  const d4 = db.insertDocument({ title: 'Delta eedl fragment', body: 'nothing relevant', source: 'smoke' });
  const idOf = (r) => (r && (r.id != null ? r.id : r.lastInsertRowid)) || r;
  db.getDb().prepare('UPDATE documents SET superseded_by = ? WHERE id = ?').run(idOf(d1), idOf(d3));
  for (let i = 0; i < 20; i++) { const r = db.syncDocumentsFts({ batch: 100 }); if (r && r.caughtUp) break; }
  ok(db.documentsFtsReady() === true, 'documents_fts built for the smoke store');
  const hit = db.searchDocuments('needle', 10);
  ok(hit.length === 1 && hit[0].id === idOf(d1), `a body word found through the index; the superseded twin is filtered by LIVE (got ${hit.map((r) => r.id).join(',')})`);
  const sub = db.searchDocuments('eedl', 10);
  ok(sub.length === 1 && sub[0].id === idOf(d4), 'no FTS hit → the fallback matches a TITLE substring');
  ok(db.searchDocuments('eedl fragmen', 10).length === 1, 'a multi-word title fragment still falls back to the title LIKE');
  ok(db.searchDocuments('quoru', 10).length === 0, '⭐ a BODY substring inside a word is no longer found — the 1.35GB body LIKE is gone from the main thread');
  const dbSrc = src('lib/db.js');
  ok(/SELECT rowid FROM documents_fts WHERE documents_fts MATCH \? ORDER BY rowid DESC LIMIT \?/.test(dbSrc), 'the FTS ask is rowids only (the IDS shape)');
  ok(/if \(documentsFtsReady\(\)\) return getDb\(\)\.prepare\(`SELECT \* FROM documents WHERE title LIKE \? AND/.test(dbSrc), 'with a built index the fallback is title-only; the body LIKE survives only for a store whose index is not built');

  // ── 3. gatherFragments: the head probe ────────────────────────────────────────────────────────
  console.log('\ngatherFragments (head probe):');
  const pf = require('../lib/paper_finalize');
  const ndir = path.join(tmp, 'notes'); fs.mkdirSync(ndir);
  const big = '# Acme Widgets overview\n' + 'x'.repeat(9000) + '\nfooter';
  fs.writeFileSync(path.join(ndir, 'acme_widgets_overview.md'), big);
  fs.writeFileSync(path.join(ndir, 'late_mention.md'), '# Something else\n' + 'y'.repeat(2000) + '\nacme widgets appear only here, past the 800-char head');
  const fr = pf.gatherFragments({ tokens: ['acme', 'widgets'], dir: ndir });
  ok(fr.length === 1 && fr[0].file === 'acme_widgets_overview.md', 'a head match is returned; a mention past the head is not (the probe window is unchanged)');
  ok(fr.length === 1 && fr[0].text.length === big.length, `the matched file is returned in FULL (${fr[0] && fr[0].text.length} chars), only the probe reads the head`);
  ok(/HEAD_BYTES = 4096/.test(src('lib/paper_finalize.js')) && !/readFileSync\(path\.join\(dir, f\), 'utf8'\);\s*\n\s*const probe/.test(src('lib/paper_finalize.js')), 'the probe reads a 4KB head, never the whole file');

  // ── 4. localdb.inventory: cold estimates now, exact counts from the worker ────────────────────
  console.log('\nlocaldb inventory (worker refresh):');
  const ldb = require('../lib/localdb');
  ldb._reset && ldb._reset();
  const cold = ldb.inventory();
  ok(Array.isArray(cold) && cold.some((t) => t.table === 'documents') && cold.every((t) => typeof t.rows === 'number'), 'a cold call answers at once with numbers (rowid estimates)');
  const exact = await ldb.inventoryAsync();
  const docsExact = exact.find((t) => t.table === 'documents');
  const docsCount = db.getDb().prepare('SELECT COUNT(*) c FROM documents').get().c;
  ok(docsExact && docsExact.rows === docsCount, `the worker walk lands EXACT counts (documents ${docsExact && docsExact.rows} = COUNT(*) ${docsCount})`);
  const warm = ldb.inventory();
  ok(warm.find((t) => t.table === 'documents').rows === docsCount, 'the next synchronous call serves the exact map from the cache');
  ok(ldb.inventory({ maxAgeMs: 0 }).find((t) => t.table === 'documents').rows === docsCount, 'maxAgeMs:0 still forces an exact synchronous walk');

  // ── 5. usage_meter: minute buckets ─────────────────────────────────────────────────────────────
  console.log('\nusage_meter (minute buckets):');
  const um = require('../lib/usage_meter');
  um.reset();
  const T = 1_700_000_000_000;
  for (let i = 0; i < 5; i++) um.record('gemma4:12b', 100 + i, T + i * 4000, 'research');
  ok(um._size() === 1, '5 calls of one model+lane inside a minute are ONE ring entry');
  const s1 = um.summary({ now: T + 60_000 });
  ok(s1.total === 100 + 101 + 102 + 103 + 104 && s1.calls === 5, `the summary keeps the token sum (${s1.total}) and the call count (${s1.calls})`);
  um.record('gemma4:12b', 7, T + 10_000, 'directed');
  ok(um._size() === 2, 'a different lane is its own entry (the pace split stays exact)');
  um.record('gemma4:12b', 9, T + 71_000, 'directed');   // 61s past the directed bucket's first call
  ok(um._size() === 3, 'a call a minute after the tail bucket opened starts a new bucket');
  ok(um.byModelSince(T - 1, T + 120_000)['gemma4:12b'] === 510 + 7 + 9, 'byModelSince sums every bucket');
  let persisted = null;
  um.persist(T + 200_000, { setMeta: (k, v) => { persisted = v; }, force: true });
  um.reset();
  um.restore(T + 200_000, { getMeta: () => persisted });
  ok(um._size() === 3 && um.summary({ now: T + 200_000 }).calls === 7, 'persist → restore carries the buckets and their call counts');

  // ── 6. echo_spend_bridge: the two doors fold identically ───────────────────────────────────────
  console.log('\necho_spend_bridge (worker door):');
  const esb = require('../lib/echo_spend_bridge');
  const Database = require('better-sqlite3');
  const sagaPath = path.join(tmp, 'saga.db');
  const saga = new Database(sagaPath);
  saga.exec('CREATE TABLE agent_trajectory (id INTEGER PRIMARY KEY, asserted_at INTEGER, llm_model_name TEXT, llm_token_count_total INTEGER, llm_token_count_prompt INTEGER, llm_token_count_completion INTEGER)');
  const nowS = Math.floor(Date.now() / 1000);
  const ins = saga.prepare('INSERT INTO agent_trajectory (id, asserted_at, llm_model_name, llm_token_count_total) VALUES (?, ?, ?, ?)');
  for (let i = 1; i <= 6; i++) ins.run(i, nowS - i * 60, 'gpt-oss:120b', 1000 * i);
  saga.close();
  const mk = () => { const calls = []; let meta = {}; return { calls, meter: { record: (m, t, ts) => calls.push([m, t]) }, getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; }, meta: () => meta }; };
  const A = mk(), B = mk();
  const rSync = esb.foldOnce({ dbPath: sagaPath, meter: A.meter, getMeta: A.getMeta, setMeta: A.setMeta });
  const rAsync = await esb.foldOnceAsync({ dbPath: sagaPath, meter: B.meter, getMeta: B.getMeta, setMeta: B.setMeta,
    query: (sql, params) => { const c = new Database(sagaPath, { readonly: true }); try { return Promise.resolve(c.prepare(sql).all(...params)); } finally { c.close(); } } });
  ok(rSync.folded === 6 && rAsync.folded === 6 && rSync.watermark === rAsync.watermark, `foldOnce and foldOnceAsync fold the same rows to the same watermark (${rSync.folded}/${rAsync.folded}, wm ${rSync.watermark})`);
  ok(JSON.stringify(A.calls) === JSON.stringify(B.calls), 'the meter receives identical (model, tokens) records from both doors');
  const C = mk();
  const rWorker = await esb.foldOnceAsync({ dbPath: sagaPath, meter: C.meter, getMeta: C.getMeta, setMeta: C.setMeta });
  ok(rWorker.folded === 6, `the default door (lib/db_worker) folds the same 6 (got ${rWorker.folded}${rWorker.why ? ' — ' + rWorker.why : ''})`);
  ok(/foldOnceAsync\(\)\.then/.test(src('main.js')) && !/echo_spend_bridge'\)\.foldOnce\(\)/.test(src('main.js')), 'the 60s meter tick uses the worker door');

  // ── 7. db_health: the retention sweep counts in the worker ────────────────────────────────────
  console.log('\ndb_health retention (worker counts):');
  const dh = require('../lib/db_health');
  const viaInjected = await dh.retentionSweepAsync({ deps: { db }, nowMs: Date.now(), registry: [] });
  ok(viaInjected && Array.isArray(viaInjected.report) && viaInjected.report.length === 0, 'an injected store delegates to the synchronous sweep (the smokes\' contract)');
  db.setMeta('retention.last_sweep', '');
  const live = await dh.retentionSweepAsync({ nowMs: Date.now(), registry: [{ table: 'documents', kind: 'age', tsCol: 'created_ts', maxAgeMs: -1e15 }] });
  ok(live && live.armed === false && live.report.length === 1 && /documents: WOULD prune 4 \(dry-run\)/.test(live.report[0]), `the live door counts in the worker and stays a dry-run (${live && live.report[0]})`);
  ok(/retentionSweepAsync\(\{ deps, nowMs \}\)/.test(src('lib/db_health.js')), 'the 10-min tick calls the async sweep');

  // ── 8. web.js: the profile sweep is spawned, awaited, never execSync ──────────────────────────
  console.log('\nweb.js (spawned profile sweep, warmed driver):');
  const webSrc = src('lib/web.js');
  ok(/function killStaleProfileChrome\(\) \{[\s\S]*?spawn\('powershell'/.test(webSrc) && !/execSync\(\s*"powershell -NoProfile -Command \\"Get-CimInstance/.test(webSrc), 'killStaleProfileChrome spawns PowerShell (no execSync)');
  ok(/await killStaleProfileChrome\(\);/.test(webSrc), 'ensure() awaits the sweep');
  ok(/require\('patchright'\); console\.log\(`\[web\] browser driver warmed/.test(src('main.js')), 'the driver is warmed at boot idle (ZOE_WEB_WARM)');

  // ── 9. puller: the snapshot in the worker, flags identical to the synchronous draw ────────────
  console.log('\npuller snapshot (worker door):');
  const pdb = require('../lib/puller_db');
  const pconn = pdb.init();
  const now = Date.now();
  const insT = pconn.prepare("INSERT INTO targets (id, kind, name, company, domain, status, crm_id, created_at, last_accessed_at) VALUES (?, 'person', ?, ?, ?, ?, ?, ?, ?)");
  insT.run(1, 'Ann Crm', 'Acme', 'acme.com', 'adhoc', 'crm-1', now, now - 1000);       // value tier, has an email belief
  insT.run(2, 'Bob Doc', 'Beta', 'beta.org', 'adhoc', null, now, now - 2000);         // tail, grounded by a doc observation
  insT.run(3, 'Cy Nodomain', 'Gamma', null, 'adhoc', null, now, now - 3000);          // tail, no domain → never grounded
  insT.run(4, 'Di Social', 'Delta', 'delta.io', 'adhoc', null, now, now - 4000);      // tail, has a social observation
  pconn.prepare("INSERT INTO beliefs (target_id, type, value, status, updated_at) VALUES (1, 'email', 'ann@acme.com', 'active', ?)").run(now);
  pconn.prepare("INSERT INTO observations (target_id, attr, value, kind, source_url, captured_at) VALUES (2, 'role', 'x', 'doc', 'docstore:12', ?)").run(now);
  pconn.prepare("INSERT INTO observations (target_id, attr, value, kind, source_url, captured_at) VALUES (4, 'social', 'x', 'maigret', null, ?)").run(now);
  const snap = await pdb.valueScopedSnapshotAsync({ limit: 10 });
  const by = new Map(snap.map((r) => [r.id, r]));
  ok(snap.length === 4 && by.get(1) && snap[0].id === 1, `the value tier leads, then the recency tail (${snap.map((r) => r.id).join(',')})`);
  ok(by.get(1).hasEmail === true && by.get(1).grounded === false, 'an email belief → hasEmail, never grounded');
  ok(by.get(2).hasEmail === false && by.get(2).grounded === true, 'a doc observation on a domain target → grounded');
  ok(by.get(3).grounded === false && by.get(3).hasEmail === false, 'no domain → not grounded');
  ok(by.get(4).hasDeep === true && by.get(4).grounded === false, 'a social observation → hasDeep; a maigret row is not grounding');
  const monoSrc = src('lib/monologue.js');
  ok(/snapshot = await _pullerCandidateSnapshot\(\)/.test(monoSrc) && /valueScopedSnapshotAsync\(\{ limit \}\)/.test(monoSrc), 'the pipeline tick awaits the worker snapshot, the synchronous draw is the fallback');

  // ── 10. decompose_sweep: an existing pool is refreshed off the main thread ─────────────────────
  console.log('\ndecompose_sweep (pool refresh in the worker):');
  const ds = require('../lib/decompose_sweep');
  db.setMeta(ds.POOL_KEY, JSON.stringify({ at: Date.now() - 2 * ds.POOL_FULL_TTL_MS, maxId: 0, full: false, rows: [{ id: 999, title: 'stale', source: 'smoke', origin_host: null, chars: 5 }] }));
  const first = ds.candidatePool(db, { now: Date.now() });
  ok(first.mode === 'stale' && first.rows.length === 1 && first.rows[0].id === 999, `an expired pool is served as it stands while the worker walks (mode ${first.mode})`);
  const p = ds.poolRefreshPromise();
  ok(!!p && typeof p.then === 'function', 'a refresh is in flight');
  await p;
  const after = JSON.parse(db.getMeta(ds.POOL_KEY));
  ok(Array.isArray(after.rows) && !after.rows.some((r) => r.id === 999) && after.rows.length === 4 && after.maxId === idOf(d4), `the landed pool holds the store's truth (${after.rows.length} candidates, maxId ${after.maxId})`);
  const second = ds.candidatePool(db, { now: Date.now() });
  ok(second.mode === 'incremental' && second.rows.length === 4, 'the next tick is incremental over the landed pool');
  ok(!/findUndecomposed\(db, \{ limit, chars: false \}\)/.test(src('lib/decompose_sweep.js')) || /_poolWalkAsync\(db, pool, \{ limit \}\)/.test(src('lib/decompose_sweep.js')), 'the full walk path goes through _poolWalkAsync first');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { pdb.close && pdb.close(); } catch {}
  try { db.getDb().close(); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('smoke crashed:', e && e.stack || e); process.exit(1); });
