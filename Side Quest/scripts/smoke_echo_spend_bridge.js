/* smoke_echo_spend_bridge.js — F19 slice 2: the Echo→app spend bridge (built 2026-08-20).
 *
 * The proven gap: usage_meter's only writers were the app's own ollama.js sites, so every cloud
 * call from the Python processes (Echo server + Skuld) was invisible to spentSince/spentLastHour —
 * audited live: agent_trajectory's token columns held ZERO rows in 7d while the dashboard metered a
 * heavy Echo share. The bridge replays trajectory token rows into the meter by id-watermark.
 *
 * Fully injected deps: a temp saga.db (minimal agent_trajectory schema), a capturing fake meter,
 * and an in-memory meta store — no live DB, no live meter. The wiring grep pins the main.js tick.
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const bridge = require('../lib/echo_spend_bridge');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── fixture: temp saga.db with the columns the bridge reads ─────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_spendbridge_'));
const dbPath = path.join(dir, 'saga.db');
const Database = require('better-sqlite3');
const conn = new Database(dbPath);
conn.exec(`CREATE TABLE agent_trajectory (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_idx INTEGER, asserted_at INTEGER,
  action_type TEXT, action_name TEXT, agent_kind TEXT,
  llm_model_name TEXT, llm_token_count_prompt INTEGER, llm_token_count_completion INTEGER,
  llm_token_count_total INTEGER)`);
const NOW = 1787300000000;                       // fixed clock — determinism, and never Date.now()
const secs = (ms) => Math.floor(ms / 1000);
const ins = conn.prepare(`INSERT INTO agent_trajectory
  (session_id, turn_idx, asserted_at, action_type, agent_kind, llm_model_name,
   llm_token_count_prompt, llm_token_count_completion, llm_token_count_total)
  VALUES ('s', 0, ?, 'message', 'llm_spend', ?, ?, ?, ?)`);
ins.run(secs(NOW - 3600e3), 'gemma4:31b', 1200, 300, 1500);          // #1 fresh, total present
ins.run(secs(NOW - 40 * 3600e3), 'gpt-oss:120b', 900, 100, 1000);    // #2 OLDER than the 26h ring → skipped
ins.run(secs(NOW - 60e3), 'kimi-k2.6', 700, 50, null);               // #3 fresh, total NULL → prompt+completion
conn.prepare(`INSERT INTO agent_trajectory (session_id, turn_idx, asserted_at, action_type, agent_kind)
  VALUES ('s', 1, ?, 'api', 'other')`).run(secs(NOW - 30e3));        // #4 non-LLM row — never selected

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────
const recorded = [];
const meter = { record: (model, tokens, ts) => recorded.push({ model, tokens, ts }) };
const meta = {};
const deps = { now: NOW, dbPath, meter, getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; } };

// ── fold 1: fresh rows fold, the stale row is skipped, the watermark advances past everything ──
const r1 = bridge.foldOnce(deps);
ok(r1.folded === 2, `first fold folds the 2 fresh token rows (got ${r1.folded}${r1.why ? ` — ${r1.why}` : ''})`);
ok(recorded.length === 2 && recorded[0].model === 'gemma4:31b' && recorded[0].tokens === 1500,
   'row #1 replays with its stored total (1500)');
ok(recorded[1].model === 'kimi-k2.6' && recorded[1].tokens === 750,
   'row #3 (NULL total) replays prompt+completion (750)');
ok(recorded.every((r) => r.ts <= NOW && r.ts >= NOW - bridge.MAX_AGE_MS),
   'replayed timestamps are within the ring window and never in the future');
ok(recorded.every((r) => r.model !== 'gpt-oss:120b'), 'the >26h row is NOT replayed (ring-order protection)');
ok(meta[bridge.META_KEY] === '3', `watermark advances to the last LLM row id (got ${meta[bridge.META_KEY]})`);

// ── fold 2: idempotent — nothing new, nothing double-counted ────────────────────────────────────
const r2 = bridge.foldOnce(deps);
ok(r2.folded === 0 && recorded.length === 2, 'second fold folds nothing (watermark holds; no double-count)');

// ── new spend after the watermark folds on the next tick ────────────────────────────────────────
ins.run(secs(NOW - 10e3), 'deepseek-v4-flash', 200, 100, 300);
const r3 = bridge.foldOnce(deps);
ok(r3.folded === 1 && recorded[2].model === 'deepseek-v4-flash' && recorded[2].tokens === 300,
   'a row written after the watermark folds on the next tick');

// ── fail-soft: a missing saga.db is a quiet no-op, never a throw ────────────────────────────────
const r4 = bridge.foldOnce({ ...deps, dbPath: path.join(dir, 'nope.db') });
ok(r4.folded === 0 && /not found/.test(r4.why || ''), 'missing saga.db → quiet no-op with a reason');

// ── fast-forward (2026-08-20): a watermark far behind the tip is pre-seam history — jump, never
// crawl (measured live: 3.06M rows, old token rows, ~39h of wasted 1000/tick crawling).
conn.prepare(`INSERT INTO agent_trajectory (id, session_id, turn_idx, asserted_at, action_type, agent_kind, llm_model_name,
  llm_token_count_prompt, llm_token_count_completion, llm_token_count_total)
  VALUES (200010, 's', 2, ?, 'message', 'llm_spend', 'gemma4:31b', 10, 10, 20)`).run(secs(NOW - 5e3));
const r5 = bridge.foldOnce(deps);
ok(r5.folded === 0 && /fast-forwarded/.test(r5.why || '') && meta[bridge.META_KEY] === '200010',
   `a watermark >100k behind the tip fast-forwards without folding (wm=${meta[bridge.META_KEY]})`);
conn.prepare(`INSERT INTO agent_trajectory (id, session_id, turn_idx, asserted_at, action_type, agent_kind, llm_model_name,
  llm_token_count_prompt, llm_token_count_completion, llm_token_count_total)
  VALUES (200011, 's', 3, ?, 'message', 'llm_spend', 'kimi-k2.6', 50, 25, 75)`).run(secs(NOW - 2e3));
const r6 = bridge.foldOnce(deps);
ok(r6.folded === 1 && recorded[recorded.length - 1].tokens === 75, 'post-fast-forward fresh rows fold normally');

// ── wiring grep: the live 60s tick actually calls the bridge ────────────────────────────────────
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/echo_spend_bridge'\)\.foldOnceAsync\(\)\.then/.test(mainSrc), 'main.js 60s meter tick calls foldOnceAsync() (cut 18: the saga.db reads run in the db worker)');
ok(/\[echo-spend\] folded/.test(mainSrc), 'the fold logs its count (observable, never silent)');

conn.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\nsmoke_echo_spend_bridge: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
