'use strict';
/*
 * lib/role_registry.js — THE ROLE REGISTRY (stage 4.5 B, 2026-09-04; docs/ZOE_MERGE_MAP §"Stage 4.5",
 * contract part 1): "Every agent and every worker kind on both sides is a row: name, purpose, executor
 * (Echo agent or Side Quest worker), model slot, weight class, tools, trigger kinds, and the tier it
 * bills under the usage law. Echo's manifests are the seed; Side Quest's worker kinds join as rows."
 *
 * ONE registry, two sources, never two copies:
 *   - ECHO rows come from the engine's own manifests (data/agents/*.toml) through its `list_agents`
 *     door, fetched at attach and cached (10 min) — the manifest IS the row; nothing is retyped here.
 *     The seven roles ported this day ride there as data: the collector (P15's mandatory tool order),
 *     the challenger (Alpha's validator), and P7's five brand-voice agents.
 *   - SIDE QUEST rows are this program's worker kinds, each pointing at the module that IS the worker.
 *     Their model comes from the same meta slots the lanes read (never a second literal).
 * Every row's TIER comes from the trigger-to-tier law (lib/tier_law), per trigger kind; `bills` is the
 * tier the role's first trigger kind maps to. The table is served at GET /roles on the control port
 * beside /tiers and /quota, so Echo's planner and the app's swarm read the same rows.
 *
 * Pure-testable: rows({ echo }) is a function of its inputs; refresh(deps) is the only door that talks
 * to the engine, and it takes `dispatch` + `getMeta`/`setMeta` injected. Smoke: scripts/smoke_role_registry.js.
 */

const VERSION = 1;
const ECHO_CACHE_KEY = 'roles.echo_cache';
const ECHO_CACHE_TTL_MS = 10 * 60 * 1000;
const WEIGHTS = ['cheap', 'mid', 'premium'];

// THE APP'S OWN WORKER KINDS — each row names the module that is the worker (source), the meta slot
// its model comes from (modelMeta) or the literal the lane itself falls back to, and the trigger kinds
// that start it. executor 'sq' = runs in this process; 'echo' = this lane dispatches to Echo agents
// (named in `delegates`) and is a row here because the LANE is the unit the swarm plans with.
const SQ_ROWS = [
  { name: 'operator', purpose: 'the cloud operator: a tool-calling agent loop over the web, the engine catalog, her browser, memory and files that drives one research pass', executor: 'sq', source: 'lib/operator.js', slot: 'operator', weight: 'mid', modelMeta: 'model.operator', modelDefault: 'deepseek-v4-flash', tools: ['web', 'echo', 'browser', 'memory', 'files'], triggers: ['chat', 'directed', 'scheduled'], artifact: 'dossier' },
  { name: 'operator-deep', purpose: 'the explicit "deep dive on <X>" verb: one bounded single-target focus dug till dry on the premium code/agentic model', executor: 'sq', source: 'lib/operator.js', slot: 'operator', weight: 'premium', modelMeta: 'model.operator_deep', modelDefault: 'kimi-k2.7-code', tools: ['web', 'echo', 'browser', 'memory', 'files'], triggers: ['chat'], artifact: 'dossier' },
  { name: 'swarm-worker', purpose: 'a partition worker: one of K background workers converging a roster partition (ROSTER) or one facet of a target (DEEP) for a bounded burst', executor: 'sq', source: 'lib/swarm.js', slot: 'swarm', weight: 'cheap', modelMeta: 'model.operator_swarm', modelDefault: 'gemma4:31b-cloud', tools: ['web', 'echo', 'browser', 'memory'], triggers: ['chat', 'directed', 'scheduled'], artifact: 'covered_targets' },
  { name: 'writer', purpose: 'the document road: assembles a deliverable (paper, list, brief) from held fragments and the dossier, on the replier-class model', executor: 'sq', source: 'lib/document_road.js', slot: 'replier', weight: 'premium', modelMeta: 'model.replier', modelDefault: 'glm-5.2:cloud', tools: ['memory', 'files', 'echo'], triggers: ['chat', 'directed'], artifact: 'document' },
  { name: 'editor-verifier', purpose: "his document's verification: fires the engine's citation verifier and fact checker on a verification session and lands their findings", executor: 'echo', delegates: ['rainey-citation-verifier', 'rainey-fact-checker'], source: 'lib/editor_checks.js', slot: 'on_demand_background', weight: 'mid', tools: ['delegate_to_rainey_citation_verifier', 'delegate_to_rainey_fact_checker'], triggers: ['directed'], artifact: 'verification_report' },
  { name: 'pen', purpose: 'the code pen: proposes, gates and lands her own program changes under the self-build laws', executor: 'sq', source: 'lib/code_pen.js', slot: 'code', weight: 'premium', modelMeta: 'model.operator_deep', modelDefault: 'kimi-k2.7-code', tools: ['files', 'gate', 'git'], triggers: ['pen'], artifact: 'code_change' },
  { name: 'code-review-shard', purpose: "a wide self-review sharded across the engine's code-reviewer delegates, compiled back into one report", executor: 'echo', delegates: ['code-reviewer'], source: 'lib/review_fanout.js', slot: 'on_demand_background', weight: 'mid', tools: ['spawn_agent_async'], triggers: ['pen'], artifact: 'review_report' },
  { name: 'grounding-flare', purpose: 'after an answer from the model, one or two cluster specialists chase its claims; the harvest posts one follow-up (enrichment or correction)', executor: 'echo', delegates: ['fact-checker', 'historical-researcher', 'legislative-analyst'], source: 'lib/grounding_flare.js', slot: 'on_demand_background', weight: 'cheap', tools: ['spawn_agent_async'], triggers: ['chat'], artifact: 'followup' },
  { name: 'curation-burst', purpose: "a paced burst of the engine's curators over seed rows the app selects (owners, people, civic, documents)", executor: 'echo', delegates: ['owner-curator', 'people-curator', 'civic-curator', 'document-curator'], source: 'lib/curation_burst.js', slot: 'on_demand_background', weight: 'cheap', tools: ['spawn_agent_async'], triggers: ['scheduled'], artifact: 'curated_rows' },
  { name: 'subconscious', purpose: 'the between-turn thought: reads what landed, decides what to pursue, never writes the reply', executor: 'sq', source: 'lib/subconscious.js', slot: 'subconscious', weight: 'premium', modelEnv: 'ZOE_SUBCONSCIOUS_MODEL', modelDefault: 'glm-5.2:cloud', tools: ['memory', 'echo'], triggers: ['idle'], artifact: 'thought' },
  { name: 'news-lane', purpose: 'the hourly news lane: polls feeds, ranks, compresses and files headlines as encounters', executor: 'sq', source: 'lib/news_lane.js', slot: 'extraction', weight: 'cheap', modelDefault: 'gemma4:31b-cloud', tools: ['feeds', 'memory'], triggers: ['news'], artifact: 'encounters' },
];

function _tierLaw() { return require('./tier_law'); }

// One row shape for both sources.
function _shape(r) {
  const law = _tierLaw();
  const kinds = Array.isArray(r.triggers) ? r.triggers.map((k) => String(k || '').toLowerCase()).filter(Boolean) : [];
  const tiers = {};
  for (const k of kinds) tiers[k] = law.tierForTrigger(k);
  const first = kinds[0];
  return {
    name: String(r.name || ''),
    purpose: String(r.purpose || ''),
    executor: r.executor === 'echo' || r.executor === 'sq' ? r.executor : 'echo',
    source: r.source || null,
    delegates: Array.isArray(r.delegates) ? r.delegates.slice() : undefined,
    slot: r.slot || null,
    weight: WEIGHTS.includes(r.weight) ? r.weight : null,
    model: r.model || null,
    tools: Array.isArray(r.tools) ? r.tools.slice() : [],
    triggers: kinds,
    tiers,
    bills: first ? tiers[first] : law.DEFAULT_TIER,
    cite_floor: Number.isFinite(r.cite_floor) ? r.cite_floor : undefined,
    artifact: r.artifact || null,
    lineage: r.lineage || null,
    role_kind: r.role_kind || null,
  };
}

// The app's rows, with the model resolved from the same meta slot the lane reads (getMeta injected).
function sqRows({ getMeta = () => null, env = process.env } = {}) {
  return SQ_ROWS.map((r) => {
    let model = null;
    try { if (r.modelMeta) model = String(getMeta(r.modelMeta) || '').trim() || null; } catch { model = null; }
    if (!model && r.modelEnv) model = String((env && env[r.modelEnv]) || '').trim() || null;
    if (!model) model = r.modelDefault || null;
    return _shape({ ...r, model });
  });
}

// An Echo `list_agents` row → a registry row. Trigger kinds come from the manifest's [[trigger]] list.
function echoRow(a) {
  if (!a || !a.name) return null;
  const kinds = Array.isArray(a.triggers) ? a.triggers.map((t) => (t && t.kind) || t).filter(Boolean) : [];
  return _shape({
    name: a.name, purpose: a.purpose || a.description || '', executor: 'echo', source: `data/agents/${a.name}.toml`,
    slot: a.model_slot || null, weight: a.weight || null, model: a.model || null,
    tools: Array.isArray(a.tools) ? a.tools : [], triggers: kinds,
    cite_floor: Number.isFinite(a.cite_floor) ? a.cite_floor : undefined,
    artifact: a.artifact || null, lineage: a.lineage || null, role_kind: a.role_kind || null,
  });
}

// THE ONE TABLE. `echo` = the list_agents rows (live or cached); a name collision keeps the engine's
// row (the manifest is the seed) and notes the app row under `aliases`.
function rows({ echo = [], getMeta, env } = {}) {
  const out = [];
  const seen = new Map();
  for (const a of echo || []) { const r = echoRow(a); if (!r) continue; seen.set(r.name, r); out.push(r); }
  for (const r of sqRows({ getMeta, env })) {
    if (seen.has(r.name)) { const e = seen.get(r.name); e.aliases = [...(e.aliases || []), { executor: 'sq', source: r.source }]; continue; }
    out.push(r);
  }
  return out;
}

function _readCache(getMeta) {
  try { const raw = getMeta(ECHO_CACHE_KEY); const c = raw ? JSON.parse(raw) : null; return c && Array.isArray(c.rows) ? c : null; } catch { return null; }
}

// Fetch the engine's rows through its list_agents door (via the suit's dispatch) and cache them.
// Fail-soft: a dead engine leaves the last cache in place; nothing here can break an attach.
async function refresh({ dispatch, getMeta, setMeta, now = Date.now(), force = false } = {}) {
  const gm = getMeta || ((k) => require('./db').getMeta(k));
  const sm = setMeta || ((k, v) => require('./db').setMeta(k, v));
  const cached = _readCache(gm);
  if (!force && cached && now - (cached.at || 0) < ECHO_CACHE_TTL_MS) return { ok: true, cached: true, n: cached.rows.length };
  try {
    const r = await dispatch({ kind: 'do', name: 'list_agents', args: {} });
    const list = _parseList(r);
    if (!list) return { ok: false, why: `list_agents returned no rows: ${String((r && r.text) || '').slice(0, 120)}` };
    sm(ECHO_CACHE_KEY, JSON.stringify({ at: now, rows: list }));
    console.log(`[roles] registry refreshed — ${list.length} engine role(s) + ${SQ_ROWS.length} app lane(s)`);
    return { ok: true, cached: false, n: list.length };
  } catch (e) { return { ok: false, why: String((e && e.message) || e) }; }
}
function _parseList(r) {
  if (!r) return null;
  if (Array.isArray(r)) return r;
  if (Array.isArray(r.data)) return r.data;
  if (Array.isArray(r.json)) return r.json;
  const txt = typeof r === 'string' ? r : (r.text || '');
  try { const j = JSON.parse(txt); if (Array.isArray(j)) return j; if (j && Array.isArray(j.result)) return j.result; } catch {}
  try { const m = /\[[\s\S]*\]/.exec(txt); if (m) { const j = JSON.parse(m[0]); if (Array.isArray(j)) return j; } } catch {}
  return null;
}

// The read door (GET /roles): the merged table from the cache + the app's rows.
function table({ getMeta, env, now = Date.now() } = {}) {
  const gm = getMeta || ((k) => require('./db').getMeta(k));
  const cached = _readCache(gm);
  const all = rows({ echo: cached ? cached.rows : [], getMeta: gm, env });
  return { version: VERSION, rows: all, echo_rows: cached ? cached.rows.length : 0, echo_cached_at: cached ? cached.at : null, echo_stale: !cached || now - (cached.at || 0) > ECHO_CACHE_TTL_MS, app_rows: SQ_ROWS.length };
}
function byName(name, opts) { const n = String(name || '').toLowerCase(); return table(opts).rows.find((r) => r.name.toLowerCase() === n) || null; }

module.exports = { VERSION, WEIGHTS, SQ_ROWS, ECHO_CACHE_KEY, ECHO_CACHE_TTL_MS, sqRows, echoRow, rows, refresh, table, byName, _parseList };
