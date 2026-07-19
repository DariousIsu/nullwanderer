/* lib/route_obs.js — MEMORY PATH MAPPING, slice P0: the route OBSERVATION LOG.
 *
 * Records WHAT WE ASKED and WHETHER IT LANDED at the one place every Echo call funnels through
 * (EchoLive.dispatch). This is deliberately DUMB: it observes, it does not interpret. Routes are
 * DERIVED from this log by a later offline pass (P1), so a wrong derivation is re-runnable instead
 * of corrupting anything. See docs/MEMORY_PATH_MAPPING_DESIGN.md §4 (invariant #2).
 *
 * WHY HERE AND NOT AT relatedEntities: an audit (2026-07-19) falsified the assumption that
 * relatedEntities was the traversal chokepoint — there are FIVE mechanisms (relatedEntities,
 * idle_anchors' own raw 1+2-hop JOINs, kg_neighborhood, get_entity.relations, query_graph).
 * Instrumenting it would have caught ~1/3 of traversal and silently missed the rest. dispatch
 * catches all of them, plus any future one, for free.
 *
 * PRIVACY INVARIANT: we record SHAPES, never VALUES. `{name:"Jane Doe"}` logs as `name:str`;
 * a SQL string logs as the TABLES it touched, never its literals. The log must never become a
 * side-channel for personal data or key values. Everything below is built to preserve that.
 *
 * Pure functions (argShape/resultShape/classify/buildObs) are exported for the smokes; the only
 * impure bits are enabled()/record(), which read meta + append a row.
 */
'use strict';

const FLAG = 'route.obs';            // meta: '1' = on. DEFAULT OFF — P0 ships inert.
const MAX_SHAPE = 200;               // hard cap so a pathological arg can't bloat the log

// ── SQL → the tables it touched. This is the ROUTE signal in a db_query (which table did she reach
// into?), and it's value-free by construction: we match identifier-shaped tokens after FROM/JOIN
// only, so literals, names and ids can never leak through.
function sqlTables(sql) {
  const out = [];
  const re = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(String(sql || '')))) {
    const t = m[1].toLowerCase();
    if (!out.includes(t)) out.push(t);
  }
  return out.sort();
}

// ── args → a value-free shape string. `{entity_id:5, top_k:8}` → "entity_id:int,top_k:int".
// SQL gets special handling (tables, not shape) because that IS the interesting part.
function argShape(args) {
  if (args == null) return '';
  if (typeof args !== 'object' || Array.isArray(args)) return typeof args;
  const parts = [];
  for (const k of Object.keys(args).sort()) {
    const v = args[k];
    let t;
    if (v == null) t = 'null';
    else if (/^sql$/i.test(k) && typeof v === 'string') {
      const tb = sqlTables(v);
      t = tb.length ? `tables(${tb.join('|')})` : 'sql';
    } else if (Array.isArray(v)) t = `arr[${v.length}]`;
    else if (typeof v === 'number') t = Number.isInteger(v) ? 'int' : 'num';
    else if (typeof v === 'boolean') t = 'bool';
    else if (typeof v === 'string') t = 'str';
    else if (typeof v === 'object') t = 'obj';
    else t = typeof v;
    parts.push(`${k}:${t}`);
  }
  return parts.join(',').slice(0, MAX_SHAPE);
}

// ── result → a shape. Row-bearing payloads report their COUNT, because "came back empty" vs
// "came back with 12" is the whole hit/miss signal we're here to capture.
function resultShape(res) {
  if (!res) return 'none';
  if (res.isError) return 'error';
  const text = typeof res.text === 'string' ? res.text : '';
  if (!text) return 'empty';
  let j = null;
  try { j = JSON.parse(text); } catch { return `text:${text.length}`; }
  if (j == null) return 'empty';
  if (Array.isArray(j)) return `rows:${j.length}`;
  if (typeof j === 'object') {
    // the common Echo payload shapes, in the order they actually appear
    for (const k of ['rows', 'results', 'neighbors', 'entities', 'items', 'matches']) {
      if (Array.isArray(j[k])) return `${k}:${j[k].length}`;
    }
    if (j.ok === false) return 'notok';
    const n = Object.keys(j).length;
    return n ? `obj:${n}` : 'empty';
  }
  return `text:${text.length}`;
}

// ── outcome. A MISS is not an error: it's a well-formed answer of "nothing here", and it is the
// single most valuable thing in this log — misses are what §6's absence model and the gap detector
// are built on. Keeping them distinct from 'error' matters; conflating them would let a transport
// failure read as evidence of absence.
function classify(res) {
  if (!res) return 'error';
  if (res.isError || res.blocked) return 'error';
  if (res.ok === false) return 'error';
  const shape = resultShape(res);
  // `notok` is a PAYLOAD-level failure (run_recipe reports a bad name/missing arg as {ok:false}
  // inside an otherwise-successful transport). That is a failure to ASK, not an answer of "nothing
  // here" — classing it as a miss would let a malformed call read as evidence of absence, which is
  // exactly what the absence model forbids. Error.
  if (shape === 'notok') return 'error';
  if (shape === 'empty' || shape === 'none') return 'miss';
  const m = /^(?:rows|results|neighbors|entities|items|matches):(\d+)$/.exec(shape);
  if (m) return Number(m[1]) > 0 ? 'hit' : 'miss';
  return 'hit';
}

// ── the tool identity for a tag (dispatch handles several tag kinds, not just 'do').
function tagTool(tag) {
  if (!tag || !tag.kind) return null;
  if (tag.kind === 'do') return tag.name || null;
  if (tag.kind === 'recipe') return `recipe:${tag.name || '?'}`;
  if (tag.kind === 'propose') return `propose_${tag.proposeKind || '?'}`;
  if (tag.kind === 'delegate') return 'spawn_agent_async';
  if (tag.kind === 'find') return 'find';
  if (tag.kind === 'guide') return 'guide';
  return tag.kind;
}

function tagArgs(tag) {
  if (!tag) return null;
  if (tag.kind === 'do') return tag.args || {};
  if (tag.kind === 'recipe') return { arg: tag.arg == null ? null : String(tag.arg) };
  if (tag.kind === 'find') return { query: tag.query == null ? null : String(tag.query) };
  return null;
}

// ── pure: assemble the row. Callers pass ts/latency so this stays deterministic under test.
function buildObs(tag, res, { ts, latencyMs = null, focusId = null, autonomous = false } = {}) {
  const tool = tagTool(tag);
  if (!tool) return null;
  return {
    ts,
    focus_id: focusId || null,
    tool,
    arg_shape: argShape(tagArgs(tag)),
    result_shape: resultShape(res),
    outcome: classify(res),
    latency_ms: latencyMs == null ? null : Math.max(0, Math.round(latencyMs)),
    autonomous: autonomous ? 1 : 0,
  };
}

// ── impure edge ────────────────────────────────────────────────────────────────────────────────
let _db = null;
function db() { if (!_db) _db = require('./db'); return _db; }

function enabled() {
  try { return db().getMeta(FLAG) === '1'; } catch { return false; }
}

// AMBIENT focus, rather than plumbed. The first live run recorded 1,097 observations with
// focus_id null on every one — nothing in the codebase passes opts.focusId to dispatch, and
// threading it through dozens of call sites would be a large diff for a field only the derivation
// pass reads. Reading the active focus here gets the same signal for free and cannot drift out of
// sync with callers. Fail-soft: no focus (or no db) is a legitimate null, meaning UI/ambient work.
function currentFocusId() {
  try {
    const t = require('./focus').getCurrent();
    return t && t.id != null ? String(t.id) : null;
  } catch { return null; }
}

// Fail-soft by design: observation must NEVER break a research call. Any throw here is swallowed —
// a lost log row is nothing, a broken dispatch is everything.
function record(tag, res, meta = {}) {
  try {
    if (!enabled()) return null;
    const focusId = meta.focusId || currentFocusId();
    const row = buildObs(tag, res, { ts: Date.now(), ...meta, focusId });
    if (!row) return null;
    db().getDb().prepare(
      `INSERT INTO route_obs (ts, focus_id, tool, arg_shape, result_shape, outcome, latency_ms, autonomous)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(row.ts, row.focus_id, row.tool, row.arg_shape, row.result_shape, row.outcome, row.latency_ms, row.autonomous);
    return row;
  } catch { return null; }
}

// Rolling summary for the inspector — what did we actually capture?
function summary({ sinceMs = 24 * 3600 * 1000 } = {}) {
  try {
    const since = Date.now() - sinceMs;
    const rows = db().getDb().prepare(
      `SELECT tool, outcome, COUNT(*) n, AVG(latency_ms) avg_ms FROM route_obs
       WHERE ts > ? GROUP BY tool, outcome ORDER BY n DESC`).all(since) || [];
    const total = rows.reduce((a, r) => a + r.n, 0);
    const hits = rows.filter(r => r.outcome === 'hit').reduce((a, r) => a + r.n, 0);
    const misses = rows.filter(r => r.outcome === 'miss').reduce((a, r) => a + r.n, 0);
    return { enabled: enabled(), total, hits, misses, hitRate: total ? +(hits / total).toFixed(3) : null, byTool: rows.slice(0, 25) };
  } catch (e) { return { enabled: false, error: e.message }; }
}

function prune({ keepDays = 30 } = {}) {
  try {
    const cut = Date.now() - keepDays * 86400 * 1000;
    const d = db().getDb();
    const before = d.prepare(`SELECT COUNT(*) n FROM route_obs`).get().n;
    d.prepare(`DELETE FROM route_obs WHERE ts < ?`).run(cut);
    const after = d.prepare(`SELECT COUNT(*) n FROM route_obs`).get().n;
    return { pruned: before - after, remaining: after };
  } catch (e) { return { pruned: 0, error: e.message }; }
}

module.exports = {
  FLAG, sqlTables, argShape, resultShape, classify, tagTool, tagArgs, buildObs,
  enabled, record, summary, prune, currentFocusId,
};
