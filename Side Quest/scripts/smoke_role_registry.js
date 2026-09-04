/* smoke_role_registry.js — stage 4.5 B (2026-09-04): THE ROLE REGISTRY.
 *
 * One table of every agent and worker kind on both sides (merge map, stage 4.5 contract part 1): the
 * engine's manifests through list_agents (the seed) + the app's own lanes, each row with executor,
 * slot, weight, tools, trigger kinds and the tier it bills under the usage law. Pure rows; the fetch
 * door is exercised with an injected dispatch; the seven ported manifests are read across the repo
 * boundary (collector = P15's tool order, challenger = Alpha's validator, five brand-voice roles = P7).
 */
'use strict';
const fs = require('fs'), path = require('path');
const R = require('../lib/role_registry');
const law = require('../lib/tier_law');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── the app's rows ───────────────────────────────────────────────────────────────────────────────
const meta = { 'model.operator': 'deepseek-v4-flash', 'model.operator_deep': 'kimi-k2.7-code', 'model.replier': 'glm-5.2:cloud' };
const sq = R.sqRows({ getMeta: (k) => meta[k], env: { ZOE_SUBCONSCIOUS_MODEL: 'glm-5.2:cloud' } });
ok(sq.length === R.SQ_ROWS.length && sq.length >= 10, `the app declares its worker kinds (${sq.length} rows)`);
const REQ = ['name', 'purpose', 'executor', 'source', 'weight', 'tools', 'triggers', 'tiers', 'bills'];
ok(sq.every((r) => REQ.every((k) => r[k] !== undefined && r[k] !== null && r[k] !== '')), 'every app row carries name, purpose, executor, source, weight, tools, triggers, tiers, bills');
ok(sq.every((r) => fs.existsSync(path.join(__dirname, '..', r.source))), 'every app row points at a module that exists (the row IS the worker, never a description of one)');
ok(sq.every((r) => r.triggers.every((k) => Object.prototype.hasOwnProperty.call(law.TRIGGER_TIERS, k))), `every app row's trigger kinds are kinds the trigger-to-tier law knows (${Object.keys(law.TRIGGER_TIERS).join(', ')})`);
const by = Object.fromEntries(sq.map((r) => [r.name, r]));
ok(by.operator.model === 'deepseek-v4-flash' && by['operator-deep'].model === 'kimi-k2.7-code' && by.writer.model === 'glm-5.2:cloud', 'models resolve from the same meta slots the lanes read');
ok(by['swarm-worker'].model === 'gemma4:31b-cloud' && by['swarm-worker'].weight === 'cheap', 'the swarm worker falls back to the cost-friendly swarm slot when model.operator_swarm is unset');
ok(by.subconscious.model === 'glm-5.2:cloud', 'the subconscious reads its model from the env slot');
ok(by.pen.bills === 'development' && by['code-review-shard'].bills === 'development', 'pen work bills development (the trigger-to-tier law, kind pen)');
ok(by.subconscious.bills === 'idle' && by['news-lane'].bills === law.tierForTrigger('news') && by['news-lane'].bills === 'idle' && by['curation-burst'].bills === law.tierForTrigger('scheduled'), 'the idle thought and the news lane bill idle (the law names the news kind); scheduled lanes bill what the law says for scheduled');
ok(by['editor-verifier'].executor === 'echo' && by['editor-verifier'].delegates.length === 2 && by['editor-verifier'].bills === law.tierForTrigger('directed'), "his document's verifiers are an echo-executed lane billing the directed tier");
ok(by.operator.tiers.chat === law.tierForTrigger('chat') && by.operator.tiers.scheduled === law.tierForTrigger('scheduled'), 'a row that several trigger kinds start carries a tier per kind');

// ── the engine's rows through list_agents ───────────────────────────────────────────────────────
const echoList = [
  { name: 'bill-tracker', purpose: 'monitor pinned bills', description: 'x', model_slot: 'scheduled_background', model: null, triggers: [{ kind: 'cron', schedule: '*/15 * * * *' }, { kind: 'event', topic: 'connector:new-bill' }, { kind: 'manual' }, { kind: 'chat' }], tool_count: 3, tools: ['bill_lookup', 'get_bill', 'web_fetch'], cite_floor: 1 },
  { name: 'challenger', purpose: 'challenge an assembled output', description: 'x', model_slot: 'on_demand_background', model: 'qwen3.5:cloud', triggers: [{ kind: 'chat' }, { kind: 'manual' }], tool_count: 2, tools: ['search_facts', 'cite_pack'], cite_floor: 0, weight: 'mid', role_kind: 'challenger', lineage: 'NX-ALPHA validator', artifact: 'validation_result', family: 'qwen' },
  { name: 'operator', purpose: 'a collision with an app lane name', description: 'x', model_slot: 'on_demand_background', triggers: [{ kind: 'chat' }], tools: [], cite_floor: 0 },
];
const all = R.rows({ echo: echoList, getMeta: (k) => meta[k], env: {} });
const bt = all.find((r) => r.name === 'bill-tracker'), ch = all.find((r) => r.name === 'challenger'), op = all.find((r) => r.name === 'operator');
ok(bt && bt.executor === 'echo' && bt.source === 'data/agents/bill-tracker.toml' && bt.triggers.join(',') === 'cron,event,manual,chat', "an engine manifest is a row with executor 'echo' and its trigger kinds in manifest order");
ok(bt.tiers.cron === law.tierForTrigger('cron') && bt.tiers.chat === law.tierForTrigger('chat') && bt.bills === law.tierForTrigger('cron'), 'an engine row bills the tier of its FIRST trigger kind and carries one tier per kind');
ok(ch && ch.weight === 'mid' && ch.model === 'qwen3.5:cloud' && ch.role_kind === 'challenger' && ch.artifact === 'validation_result' && ch.lineage === 'NX-ALPHA validator', 'the registry columns ride the manifest (weight, model, role_kind, artifact, lineage)');
ok(op && op.executor === 'echo' && Array.isArray(op.aliases) && op.aliases[0].source === 'lib/operator.js' && all.filter((r) => r.name === 'operator').length === 1, 'a name collision keeps the engine row (the manifest is the seed) and notes the app lane as an alias');
ok(all.length === echoList.length + R.SQ_ROWS.length - 1, 'the merged table is every engine row + every app lane, collisions folded');

// ── the fetch door with an injected dispatch + meta store ───────────────────────────────────────
(async () => {
  const store = {};
  const gm = (k) => store[k], sm = (k, v) => { store[k] = v; };
  let calls = 0;
  const dispatch = async (tag) => { calls++; return { ok: true, kind: 'do', name: tag.name, text: JSON.stringify(echoList) }; };
  const r1 = await R.refresh({ dispatch, getMeta: gm, setMeta: sm, now: 1000 });
  ok(r1.ok && !r1.cached && r1.n === 3 && calls === 1, 'refresh pulls list_agents through the injected dispatch and caches the rows');
  const r2 = await R.refresh({ dispatch, getMeta: gm, setMeta: sm, now: 2000 });
  ok(r2.ok && r2.cached && calls === 1, 'a second refresh inside the TTL serves the cache (no engine call)');
  const r3 = await R.refresh({ dispatch, getMeta: gm, setMeta: sm, now: 1000 + R.ECHO_CACHE_TTL_MS + 1 });
  ok(r3.ok && !r3.cached && calls === 2, 'past the TTL it asks the engine again');
  const dead = await R.refresh({ dispatch: async () => { throw new Error('engine down'); }, getMeta: gm, setMeta: sm, now: 1e9, force: true });
  ok(!dead.ok && /engine down/.test(dead.why) && JSON.parse(store[R.ECHO_CACHE_KEY]).rows.length === 3, 'a dead engine fails soft and keeps the last cache');
  const t = R.table({ getMeta: gm, env: {}, now: 3000 });
  ok(t.version === R.VERSION && t.echo_rows === 3 && t.app_rows === R.SQ_ROWS.length && t.rows.length === 3 + R.SQ_ROWS.length - 1 && t.echo_stale === false, 'table() serves the merged rows with the cache age');
  ok(R.byName('CHALLENGER', { getMeta: gm, env: {} }).model === 'qwen3.5:cloud', 'byName is case-insensitive');
  ok(R._parseList({ text: 'Result: [{"name":"x","triggers":[]}] trailing' }).length === 1 && R._parseList({ text: 'nope' }) === null, 'the list parser tolerates a wrapped JSON body and refuses a non-list');

  // ── the doors: the control port serves /roles; the attach refreshes the registry ──────────────
  const port = fs.readFileSync(path.join(__dirname, '..', 'lib', 'test_port.js'), 'utf8');
  ok(/req\.url\.startsWith\('\/roles'\)/.test(port) && /require\('\.\/role_registry'\)\.table\(\)/.test(port), 'GET /roles on the control port serves the table (beside /tiers and /quota)');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/require\('\.\/lib\/role_registry'\)\.refresh\(\{ dispatch: \(t\) => echoSuit\.dispatch\(t, \{ autonomous: true \}\) \}\)/.test(main), 'the echo attach refreshes the registry through the suit (read tool, autonomous-safe)');

  // ── the seven ported manifests, read across the repo boundary ───────────────────────────────────
  const ECHO = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
  const dir = path.join(ECHO, 'data', 'agents');
  const seven = ['collector', 'challenger', 'brand-content-generation', 'brand-conversation-analysis', 'brand-discover', 'brand-document-analysis', 'brand-quality-assurance'];
  if (fs.existsSync(dir)) {
    const txt = Object.fromEntries(seven.map((n) => [n, fs.existsSync(path.join(dir, `${n}.toml`)) ? fs.readFileSync(path.join(dir, `${n}.toml`), 'utf8') : '']));
    ok(seven.every((n) => /schema_version = 1/.test(txt[n]) && new RegExp(`name\\s*=\\s*"${n}"`).test(txt[n]) && /\[\[trigger\]\]\s*\r?\nkind = "chat"/.test(txt[n])), 'the seven ported roles exist as engine manifests (schema 1, named, chat-triggered)');
    ok(seven.every((n) => /weight\s*=\s*"(cheap|mid|premium)"/.test(txt[n]) && /role_kind\s*=/.test(txt[n]) && /lineage\s*=/.test(txt[n]) && /artifact\s*=/.test(txt[n])), 'every ported manifest carries the registry columns (weight, role_kind, lineage, artifact)');
    ok(/1\. FIRST: the local database\. Always\. No exceptions\./.test(txt.collector) && /2\. SECOND: the connected APIs/.test(txt.collector) && /3\. THIRD: web_search/.test(txt.collector) && /FORBIDDEN: Do not call an API or the web before first querying the local database\./.test(txt.collector) && /"confidence": 0\.85, "missing_variables": \[\], "summary"/.test(txt.collector), "the collector carries P15's mandatory tool order and pipeline output contract verbatim");
    ok(/model\s*=\s*"qwen3\.5:cloud"/.test(txt.challenger) && /avoid_families = \["gemma", "deepseek", "glm"\]/.test(txt.challenger) && /max_iterations = 3/.test(txt.challenger) && /"verdict": "approved" \| "revision_needed", "score": 0\.0-1\.0, "correction_notes"/.test(txt.challenger), "the challenger is a different family from every producer, capped at three iterations, on Alpha's verdict schema");
    ok(['brand-content-generation', 'brand-conversation-analysis', 'brand-discover', 'brand-document-analysis'].every((n) => /weight\s*=\s*"mid"/.test(txt[n])) && /weight\s*=\s*"cheap"/.test(txt['brand-quality-assurance']), 'P7 model slots map to the fleet classes: sonnet → mid, haiku → cheap');
  } else console.log('  (engine tree not readable here — manifest pins skipped)');

  console.log(`\nsmoke_role_registry: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
