/**
 * memory_tiers — ONE MEMORY, TWO TIERS: the Side Quest half of the memory map.
 *
 * Stage 3 of the unification (2026-09-02, his order). Lucas's law: the program is one being and the
 * ONLY legitimate partition of its memory is SHORT-TERM vs LONG-TERM — never "her half / his half",
 * never "whose store is this". His 06-30 model: everything NEW lands in the Side Quest Zoe DB
 * (short-term) the moment it arrives; a nightly pass promotes it into Echo (long-term). So every
 * store on this side is SHORT-TERM by doctrine, and what this registry declares is each table's
 * KIND (what shape of memory it is) plus the promotion BRIDGES that carry rows into long-term —
 * with real SQL that measures what is still waiting. Echo's half is echo/memory_map.py (the same
 * shape, the same vocabulary); lib/memory_map.js merges the two into the one map.
 *
 * KIND   record (memory proper) · staging (rows awaiting a gate) · log (history the retention
 *        sweeps prune) · index (derived: FTS shadows) · queue · state · cache · reference · display
 *
 * Read-only on every store. Counts are capped (LIMIT 20000 → "20000+") so a render stays cheap.
 */
'use strict';
const path = require('path');

const SHORT = 'short-term';
const LONG = 'long-term';
const COUNT_CAP = 20000;

const INDEX_RE = /(_fts|_fts_(?:config|data|docsize|idx|content))$/;
const STAGING_SMELL = /(_proposals?$|_candidates?$|_queue$|^inbox$|_pending)/;
const LOG_SMELL = /(_log$|^audit$|_events?$|_traces$|_obs$|_actions$|_visits$|_sweeps$|_scanned$)/;

const d = (tier, kind, note = '') => ({ tier, kind, note });

const SQ_LOGS = ['agent_events', 'cloud_traces', 'obs_events', 'route_obs', 'route_health', 'recent_cards', 'browser_actions',
  'email_log', 'site_visits', 'site_sweeps', 'doc_contacts_scanned', 'parlor_turns'];
const SQ_STATE = ['meta', 'conversation_state', 'permissions', 'resource_locks', 'scheduled_tasks', 'sessions', 'self_model',
  'directives', 'interests', 'artifact_registry', 'site_access', 'site_plans', 'project_datasets', 'deliverable_projects', 'agenda'];

// Each store: its default (tier, kind) and explicit per-table declarations. The doctrine makes every
// Side Quest store short-term; the per-table work is the KIND.
const REGISTRY = {
  sq: {
    default: d(SHORT, 'record', "Zoe's short-term memory — everything new lands here first (Lucas 2026-06-30)"),
    tables: {
      graph_entity_proposals: d(SHORT, 'staging', 'local KG proposals awaiting graph_memory.promoteEntityProposal'),
      graph_relation_proposals: d(SHORT, 'staging'),
      absence: d(SHORT, 'staging', 'absence pursuits awaiting an answer (the absence doctrine)'),
      capability_needs: d(SHORT, 'staging', 'the needs ledger — self-diagnostics awaiting the builder'),
      capability_gaps: d(SHORT, 'staging'),
      code_proposals: d(SHORT, 'staging', "the pen's proposal cards awaiting Lucas's card"),
      recheck_queue: d(SHORT, 'queue'),
      answer_cache: d(SHORT, 'cache'),
      ...Object.fromEntries(SQ_LOGS.map((t) => [t, d(SHORT, 'log')])),
      ...Object.fromEntries(SQ_STATE.map((t) => [t, d(SHORT, 'state')])),
      monologue: d(SHORT, 'record', 'her inner voice'),
      turns: d(SHORT, 'record', 'the conversation'),
      documents: d(SHORT, 'record', 'landed documents — promoted nightly into the Echo vault'),
      knowledge: d(SHORT, 'record', 'the elastic knowledge store (lib/memory.js)'),
      encounters: d(SHORT, 'record', 'claims as ENCOUNTERED (the encounter object model)'),
      kg_observations: d(SHORT, 'record', 'raw KG observations (record ≠ derive)'),
      touchpoints: d(SHORT, 'record'),
      civic_bodies: d(SHORT, 'record', 'the civic roster mirror'),
      civic_memberships: d(SHORT, 'record', 'the civic roster mirror'),
      civic_vacancies: d(SHORT, 'record'),
      graph_entities: d(SHORT, 'record', 'the working subgraph (mirror of Echo objects + new proposals)'),
      graph_relations: d(SHORT, 'record', 'the working subgraph — promoted up via cloud_curator'),
      graph_citations: d(SHORT, 'record'),
      graph_sources: d(SHORT, 'record'),
      inbound_messages: d(SHORT, 'record', 'his mail'),
      meeting_transcript: d(SHORT, 'record'),
    },
  },
  news_bucket: { default: d(SHORT, 'record', 'news intake'), tables: { news_captures: d(SHORT, 'log') } },
  puller: {
    default: d(SHORT, 'record', "the contact puller — the CRM completion engine's working memory"),
    tables: { retest_queue: d(SHORT, 'queue'), corrections: d(SHORT, 'log'), revisions: d(SHORT, 'log') },
  },
  canvas_docs: { default: d(SHORT, 'display', 'the canvas mirror (display ≠ memory)'), tables: {} },
  canvas_layout: { default: d(SHORT, 'display'), tables: {} },
  contracts: { default: d(SHORT, 'state', 'frozen focus contracts'), tables: { wavelog: d(SHORT, 'log'), inbox: d(SHORT, 'queue'), outbox: d(SHORT, 'queue') } },
  api_stream: { default: d(SHORT, 'cache', 'API stream cache'), tables: { api_usage: d(SHORT, 'log'), bulk_records: d(SHORT, 'record'), bulk_sessions: d(SHORT, 'log') } },
  affect_weights: { default: d(SHORT, 'reference', 'affect lexicons (static)'), tables: {} },
  editor: { default: d(SHORT, 'state', 'document pipeline working copies'), tables: { check_runs: d(SHORT, 'log') } },
};

// Promotion bridges: rows that leave short-term through a named gate. pendingSql measures the backlog;
// a bridge whose backlog is not a backlog (the puller's ad-hoc targets are dossier subjects, not queued
// rows) carries measureSql + a note instead — an honest "not measurable as pending".
const BRIDGES = [
  { from: ['sq', 'documents'], to: 'echo.tenant.documents (the vault)', gate: 'promoteDocumentsPass (main.js) / lib/promote.js — nightly',
    pendingSql: 'SELECT COUNT(*) FROM documents WHERE COALESCE(promoted, 0) = 0' },
  { from: ['sq', 'graph_relations'], to: 'echo.civic_graph.relations', gate: 'cloud_curator.promoteLocalEdgesUp → propose_relation',
    pendingSql: 'SELECT COUNT(*) FROM graph_relations WHERE COALESCE(promoted_up, 0) = 0 AND COALESCE(deleted, 0) = 0' },
  { from: ['sq', 'graph_entity_proposals'], to: 'sq.graph_entities', gate: 'graph_memory.promoteEntityProposal',
    pendingSql: "SELECT COUNT(*) FROM graph_entity_proposals WHERE status = 'pending'" },
  { from: ['puller', 'targets'], to: 'echo.electoral.contact', gate: 'crm_upsert / roster_refresh (status adhoc→promoted, crm_id)',
    pendingSql: null, measureSql: "SELECT COUNT(*) FROM targets WHERE status = 'promoted'",
    note: 'ad-hoc targets are dossier subjects, not a backlog; the measure is how many are CRM-linked' },
];

function storePaths(dataDir) {
  const p = (f) => path.join(dataDir, f);
  return {
    sq: { path: process.env.SQ_DB_PATH || p('sq.db'), registry: 'sq', optional: false, live: true },
    news_bucket: { path: p('news_bucket.db'), registry: 'news_bucket', optional: true },
    puller: { path: p('puller.db'), registry: 'puller', optional: true },
    canvas_docs: { path: p('canvas_docs.db'), registry: 'canvas_docs', optional: true },
    canvas_layout: { path: p('canvas_layout.db'), registry: 'canvas_layout', optional: true },
    contracts: { path: p('contracts.db'), registry: 'contracts', optional: true },
    api_stream: { path: p('api_stream.db'), registry: 'api_stream', optional: true },
    affect_weights: { path: p('affect_weights.db'), registry: 'affect_weights', optional: true },
    editor: { path: p('editor.db'), registry: 'editor', optional: true },
  };
}

// The tier + kind of one table and HOW it was decided (explicit | shape | default); `smell` names a
// staging/log shape that resolved by default — the drift signal (a warning only inside a long-term
// store; every store here is short-term, so on this side a smell is information, not a warning).
function classify(registryKey, table, sqlType = 'table') {
  const reg = REGISTRY[registryKey];
  if (!reg) throw new Error(`memory_tiers: unknown registry ${registryKey}`);
  const exp = reg.tables[table];
  if (exp) return { ...exp, declared: 'explicit', smell: null };
  const def = reg.default;
  if (sqlType === 'view') return { tier: def.tier, kind: 'index', note: 'view', declared: 'shape', smell: null };
  if (INDEX_RE.test(table)) return { tier: def.tier, kind: 'index', note: '', declared: 'shape', smell: null };
  const smell = STAGING_SMELL.test(table) ? 'staging' : (LOG_SMELL.test(table) ? 'log' : null);
  return { tier: def.tier, kind: def.kind, note: '', declared: 'default', smell };
}

function _count(conn, table, cap) {
  try {
    const n = conn.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM "${table}" LIMIT ${cap | 0})`).get().n;
    return n < cap ? n : `${cap}+`;
  } catch (e) { return `? (${String(e.message || e).slice(0, 40)})`; }
}

// Open a store read-only. The live sq.db rides the app's own handle (one connection on the WAL'd
// file; every query here is a read); a sibling opens its own readonly handle and closes it after.
function _defaultOpen(spec) {
  if (spec.live) { const h = require('./db').getDb(); return { conn: h, close() {} }; }
  const Database = require('better-sqlite3');
  const h = new Database(spec.path, { readonly: true, fileMustExist: true });
  return { conn: h, close() { try { h.close(); } catch {} } };
}

function renderStore(alias, spec, { counts = true, cap = COUNT_CAP, openFn = _defaultOpen, fs = require('fs') } = {}) {
  const reg = REGISTRY[spec.registry];
  const out = { path: spec.path, registry: spec.registry, optional: !!spec.optional, reachable: false, size_mb: null, default: reg.default, tables: {}, bridges: [], warnings: [] };
  let st = null;
  try { st = fs.statSync(spec.path); } catch {}
  if (!st) { if (!spec.optional) out.warnings.push(`${alias}: store missing at ${spec.path}`); return out; }
  out.size_mb = Math.round(st.size / 1e5) / 10;
  let h = null;
  try { h = openFn(spec); } catch (e) { out.warnings.push(`${alias}: cannot open read-only: ${e.message}`); return out; }
  try {
    out.reachable = true;
    const rows = h.conn.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const present = new Set();
    for (const { name, type } of rows) {
      present.add(name);
      const c = classify(spec.registry, name, type);
      const entry = { tier: c.tier, kind: c.kind, declared: c.declared, type };
      if (c.note) entry.note = c.note;
      if (c.smell) entry.smell = c.smell;
      if (counts && type === 'table' && c.kind !== 'index') entry.rows = _count(h.conn, name, cap);
      out.tables[name] = entry;
    }
    for (const name of Object.keys(reg.tables)) if (!present.has(name)) out.warnings.push(`${alias}.${name}: declared but no longer exists (drift)`);
    for (const b of BRIDGES) {
      if (b.from[0] !== spec.registry || !present.has(b.from[1])) continue;
      const entry = { from: `${alias}.${b.from[1]}`, to: b.to, gate: b.gate, pending: null };
      if (b.note) entry.note = b.note;
      try {
        if (b.pendingSql) entry.pending = h.conn.prepare(b.pendingSql).get()[Object.keys(h.conn.prepare(b.pendingSql).get())[0]];
        else if (b.measureSql) entry.measure = h.conn.prepare(b.measureSql).get()[Object.keys(h.conn.prepare(b.measureSql).get())[0]];
      } catch (e) { out.warnings.push(`${alias}.${b.from[1]}: bridge backlog unmeasurable (${String(e.message || e).slice(0, 60)})`); }
      out.bridges.push(entry);
    }
  } finally { h.close(); }
  return out;
}

function render({ dataDir = null, counts = true, cap = COUNT_CAP, openFn = _defaultOpen, paths = null, nowMs = Date.now(), fs = require('fs') } = {}) {
  const specs = paths || storePaths(dataDir || path.join(__dirname, '..', 'data'));
  const stores = {};
  for (const [alias, spec] of Object.entries(specs)) stores[alias] = renderStore(alias, spec, { counts, cap, openFn, fs });
  const tiers = { [SHORT]: { tables: 0, kinds: {}, stores: new Set() }, [LONG]: { tables: 0, kinds: {}, stores: new Set() } };
  const warnings = [], bridges = [];
  for (const [alias, s] of Object.entries(stores)) {
    warnings.push(...s.warnings); bridges.push(...s.bridges);
    for (const t of Object.values(s.tables)) { const tt = tiers[t.tier]; tt.tables++; tt.kinds[t.kind] = (tt.kinds[t.kind] || 0) + 1; tt.stores.add(alias); }
  }
  for (const t of Object.values(tiers)) t.stores = [...t.stores].sort();
  const backlog = bridges.reduce((n, b) => n + (Number.isInteger(b.pending) ? b.pending : 0), 0);
  return { memory_map_version: 1, side: 'sq', at: nowMs, tiers, stores, bridges, backlog, cross_file_staging: [], warnings };
}

module.exports = { render, renderStore, classify, storePaths, REGISTRY, BRIDGES, SHORT, LONG, COUNT_CAP };
