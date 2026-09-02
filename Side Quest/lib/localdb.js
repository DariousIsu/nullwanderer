/**
 * lib/localdb.js — first-class READ access to her OWN short-term store (the local sq.db) for the cloud.
 *
 * "Zoe IS the memory": her local store is her. The cloud cognition should be able to query the WHOLE of
 * it — not just a k=5 RAG slice — as a first-class data source, exactly as it queries Echo's DBs via
 * db_query. This is the local counterpart: a read-only SELECT surface over sq.db, plus an inventory so
 * the cloud knows what tables exist.
 *
 * SAFETY: read-only by construction. better-sqlite3's `stmt.readonly` is true ONLY for non-writing
 * statements, and prepare() accepts a SINGLE statement — so a non-SELECT or a multi-statement string is
 * rejected before anything executes. A keyword pre-check gives a clear message first. Row-capped + her
 * own data. PURE-ish: only reads through lib/db's handle. Never throws — returns { ok, ... }.
 */
'use strict';

const path = require('path');
const dbLib = require('./db');
const MAX_ROWS = 200;
const WRITE_KW_RE = /\b(insert|update|delete|replace|drop|alter|create|attach|detach|pragma|vacuum|reindex|truncate)\b/i;

// ── THE OTHER FIVE DATABASES ─────────────────────────────────────────────────────────────────
//
// Until now this surface reached sq.db and nothing else — it binds to dbLib.getDb(). The awareness
// audit (docs/DATA_INVENTORY_AND_AWARENESS.md, 2026-07-20) probed that boundary directly:
//
//   REACHABLE  sq.db route_obs             -> 661693
//   BLIND      puller.db targets           -> no such table: targets
//   BLIND      news_bucket news_items      -> no such table: news_items
//   BLIND      api_stream api_usage        -> no such table: api_usage
//   BLIND      editor pipeline_documents   -> no such table: pipeline_documents
//
// So FIVE of six local databases could not be queried at all. The cost is concentrated: puller.db
// alone holds 942,190 rows — her largest body of SELF-GATHERED research — and its only read path was
// gatherHeldContacts(), which fires solely when the turn router classifies a message as 'contacts'.
// Ask about a person any other way and none of it existed; "how many of my targets have emails?" had
// no path at all.
//
// WHY A SEPARATE READ-ONLY CONNECTION, not ATTACH onto the app's handle: those files have their own
// live writers (news_store, puller_db, api_store, editor_registry). Attaching them to the main
// read-WRITE handle would put a second connection into their WAL for no reason and invites lock
// contention on a 180MB bucket being written by the feed poller. A dedicated readonly connection is
// also defence in depth — the existing stmt.readonly check stays, but now the connection itself
// cannot write even if that check were ever wrong.
//
// Paths honour the same env overrides the owning modules use, so an isolated smoke run attaches its
// temp files rather than the real ones.
const ATTACHED = [
  { alias: 'news', env: 'NEWS_DB_PATH', file: 'news_bucket.db', note: 'news bucket — items, stories, layers' },
  { alias: 'puller', env: 'PULLER_DB_PATH', file: 'puller.db', note: 'Puller — targets, beliefs, observations' },
  { alias: 'api', env: 'API_DB_PATH', file: 'api_stream.db', note: 'API stream — usage, cache, bulk records' },
  { alias: 'editor', env: 'EDITOR_DB_PATH', file: 'editor.db', note: 'editor pipeline — documents, checks, certificates' },
];
// canvas_layout.db is deliberately NOT attached: it holds UI geometry (where a card sits on the
// canvas), which is not knowledge and would only add noise to the inventory.

let _conn = null;         // the readonly connection (null until first use, or after a failed open)
let _connTried = false;   // so a failed open is not retried on every query
let _attached = [];       // aliases that actually attached

function _dataPath(file) { return path.join(__dirname, '..', 'data', file); }

// The read-only connection with the other databases attached. Returns null if it cannot be opened —
// callers then fall back to the app handle, so this is never WORSE than the sq.db-only behaviour.
function _readerConn() {
  if (_connTried) return _conn;
  _connTried = true;
  try {
    const Database = require('better-sqlite3');
    _conn = new Database(dbLib.DB_PATH, { readonly: true });
    for (const a of ATTACHED) {
      const p = process.env[a.env] || _dataPath(a.file);
      try {
        if (!require('fs').existsSync(p)) continue;      // absent file is not an error, just unavailable
        _conn.prepare(`ATTACH DATABASE ? AS ${a.alias}`).run(p);
        _attached.push(a.alias);
      } catch (e) { console.error(`[localdb] could not attach ${a.alias}:`, e.message); }
    }
  } catch (e) {
    console.error('[localdb] readonly connection unavailable, falling back to sq.db only:', e.message);
    _conn = null;
  }
  return _conn;
}

// Test seam + a way to pick up a newly-created DB file without a restart.
function _reset() { try { if (_conn) _conn.close(); } catch {} _conn = null; _connTried = false; _attached = []; }

// Run a read-only SELECT against her local store. Returns { ok, rows, count, truncated } or { ok:false, error }.
// Cross-database queries use the attached aliases: `SELECT * FROM puller.targets`, `news.news_items`.
function query(sql, params = []) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!s) return { ok: false, error: 'empty query' };
  if (WRITE_KW_RE.test(s)) return { ok: false, error: 'only read-only SELECT queries are allowed' };
  // live-observed perf guard: a LEADING-wildcard `body LIKE '%term%'` on the documents table is
  // unindexable and full-scans the growing table on the synchronous MAIN thread (measured 13-22s
  // blocks). documents_fts exists for exactly this. Refuse the scan and hand back the fast query —
  // only the anti-pattern is blocked (a trailing-wildcard `LIKE 'prefix%'` still runs).
  if (/\bfrom\s+documents\b/i.test(s) && /\bbody\s+like\s+'%/i.test(s)) {
    return { ok: false, error: "slow full-scan refused: `body LIKE '%term%'` on documents is unindexable (leading wildcard blocks any index) and blocks the main thread. Use full-text search: SELECT d.* FROM documents_fts f JOIN documents d ON d.id = f.rowid WHERE documents_fts MATCH 'term' ORDER BY bm25(documents_fts) LIMIT 20" };
  }
  const conn = _readerConn() || dbLib.getDb();
  let stmt;
  try { stmt = conn.prepare(s); }
  catch (e) { return { ok: false, error: 'invalid SQL: ' + e.message }; }   // also catches multi-statement
  if (!stmt.readonly) return { ok: false, error: 'only read-only SELECT queries are allowed' };
  try {
    const rows = stmt.all(...(Array.isArray(params) ? params : []));
    return { ok: true, rows: rows.slice(0, MAX_ROWS), count: rows.length, truncated: rows.length > MAX_ROWS };
  } catch (e) { return { ok: false, error: e.message }; }
}

// The map of her local store: every table + its row count, across sq.db AND the attached databases.
// Attached tables are reported qualified (`puller.targets`) — which is exactly how they must be
// queried, so the map doubles as the syntax hint.
function inventory() {
  const out = [];
  const conn = _readerConn() || dbLib.getDb();
  const schemas = ['main'].concat(_attached);
  for (const sch of schemas) {
    let tables = [];
    try {
      tables = conn.prepare(`SELECT name FROM ${sch}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all().map(r => r.name);
    } catch { continue; }
    for (const t of tables) {
      const qualified = sch === 'main' ? t : `${sch}.${t}`;
      let rows = 0;
      try { rows = conn.prepare(`SELECT COUNT(*) AS c FROM ${sch}."${t}"`).get().c; } catch {}
      out.push({ table: qualified, rows, db: sch });
    }
  }
  return out;
}

// ── WHAT THE MANIFEST SHOULD ACTUALLY LIST ────────────────────────────────────────────────────
//
// The manifest used to take the 14 biggest tables. Measured 2026-07-31 and every one of the 14 was
// EXHAUST — puller.observations (969k), kg_observations (684k), encounters (332k), recent_cards,
// agent_events, cloud_traces. Meanwhile the stores built specifically to ANSWER something ranked
// #34, #44, #55 and #65, and so were invisible:
//
//     absence 1,315 · civic_memberships 337 · cardinality 134 · civic_bodies 24
//
// The cost of that is not abstract. She needed county board data 21 times in one day, did not know
// `civic_bodies` existed, invented a plausible name — `county_election_boards` — and the query
// failed every time. A store she cannot see is a store she does not have, and ranking by row count
// guarantees the curated ones lose to the firehoses. (This is the measured form of the standing
// "awareness is INVERTED vs volume" problem.)
//
// So: answer-bearing tables are PINNED and carry the question they answer, the remaining slots go
// to the largest of the rest, and pure exhaust is excluded — nobody ever needed to be told that
// route_obs has 2.6 million rows.
const CURATED = [
  ['civic_bodies', 'governing bodies she has RESEARCHED — level, function, official url'],
  ['civic_memberships', 'who holds their seats, with the source each name came from'],
  ['cardinality', 'how many seats a body HAS — the denominator for completeness'],
  ['absence', 'what she looked for and did NOT find (so it is not re-hunted)'],
  ['capability_needs', 'tools/skills her own runs named as missing'],
  ['directives', "Lucas's standing instructions"],
  ['skills', 'her proven procedures — pull a body with skill_pull'],
  ['open_threads', 'live work: research threads and their status'],
  ['self_model', 'her own stated preferences, opinions and identity'],
  ['knowledge', 'facts she has kept, with provenance'],
  // Answer-bearing stores added 2026-08-03 (manifest-coverage audit): each ranked below the puller/
  // news firehoses and so lost its fill slot, leaving the cloud unable to db_query her own documents,
  // commitments, or procedures — it hallucinated table names (rehearsals/urls/promote_thresholds) instead.
  ['documents', 'documents she has INGESTED — the full text of what she read/fetched (query by id or title)'],
  ['doc_contacts', 'people EXTRACTED from those documents'],
  ['commitments', 'what she has COMMITTED to do, with status'],
  ['procedures', 'step-by-step how-tos she has recorded'],
  ['workstreams', 'her active workstreams and their state'],
  ['reflections', 'her notes-to-self between turns'],
  ['known_incorrect', 'claims she has learned are WRONG — check here before asserting'],
  ['news.news_items', 'the news she has collected — current-events lookups'],
  // M2.5.2 un-blacklist: obs_events IS answer-bearing when the question is about HERSELF —
  // "why did I go quiet / what did self-watch flag" is answered from this stream and nowhere else.
  // Label fixed 2026-08-27 (adversarial H-KIND, three rounds): "her self-watch stream" made a
  // "what did self-watch flag" question query this table UNFILTERED and present research-lane
  // [cite] exhaust as watch findings — the model rightly trusted the store over three prompt
  // rails; the LABEL was the defect. obs_events is the omnibus bus; the watch organ = lane 'watch'.
  ['obs_events', "the OMNIBUS organ event bus — EVERY lane's events (research cites, harvest, transport, anomalies). Self-watch findings = lane='watch' rows ONLY (+ capability_needs); research [cite] rows are citation exhaust, never watch findings"],
  // 2026-08-27 (census C5): the route drain distills 2.6M route_obs rows into this small per-tool
  // health table — and its reader count was ZERO; it competed for fill slots by row count and lost.
  // Pinned: "which of my tools keep failing/missing" is answered here and nowhere else.
  ['route_health', 'per-Echo-tool health — calls, errors, misses, latency (distilled from the raw route exhaust)'],
];
// Accumulating logs. Real data, but nothing a question is ever answered FROM — listing them spends
// the manifest's scarcest bytes telling her about her own exhaust. (obs_events left this list
// 2026-08-06 — self-investigation questions ARE answered from it; see CURATED.)
const EXHAUST_RE = /^(?:route_obs|cloud_traces|agent_events|recent_cards|encounters|kg_observations|puller\.observations|.*_log|.*_audit)$/i;

/**
 * The manifest's table list: pinned answer-bearing stores first (each with what it is FOR), then
 * the biggest of whatever else has rows. A pinned table that is EMPTY is dropped like any other —
 * offering an empty shelf invites a wasted hop.
 */
function manifestTables(limit = 16, rows = null) {
  const all = (rows || inventory()).filter((t) => t && t.rows > 0);
  const by = new Map(all.map((t) => [t.table, t]));
  const out = [];
  for (const [name, label] of CURATED) {
    const t = by.get(name);
    if (t) { out.push({ table: t.table, rows: t.rows, purpose: label }); by.delete(name); }
  }
  const rest = [...by.values()].filter((t) => !EXHAUST_RE.test(t.table)).sort((a, b) => b.rows - a.rows);
  for (const t of rest) { if (out.length >= limit) break; out.push({ table: t.table, rows: t.rows, purpose: '' }); }
  return out.slice(0, Math.max(limit, CURATED.length));
}

// Column schema for one table (name + type). Accepts a qualified `alias.table`; both halves sanitized.
function schema(table) {
  const raw = String(table || '');
  const [a, b] = raw.includes('.') ? raw.split('.', 2) : [null, raw];
  const sch = a ? a.replace(/[^a-zA-Z0-9_]/g, '') : 'main';
  const t = String(b || '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!t) return [];
  const conn = _readerConn() || dbLib.getDb();
  try { return conn.prepare(`PRAGMA ${sch}.table_info("${t}")`).all().map(c => ({ name: c.name, type: c.type })); }
  catch { return []; }
}

// Which of the other databases are actually live right now (for the tool description / diagnostics).
function attachedDbs() { _readerConn(); return _attached.slice(); }

module.exports = { query, inventory, manifestTables, schema, attachedDbs, ATTACHED, CURATED, EXHAUST_RE, _reset, MAX_ROWS, WRITE_KW_RE };
