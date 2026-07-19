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

// ── ARG HASH — equality detection WITHOUT storing values.
//
// The shapes-only rule (above) is right for privacy but it makes the log unable to answer the one
// question route memoization exists to answer: WAS THIS ASKED BEFORE? An audit of 8,145 real
// observations proved it — get_entity(name:str) appeared 1,587 times and nothing in the log could
// say how many were the same name. Without that, P2's utility gate is unmeasurable.
//
// A salted one-way digest restores equality (same args ⇒ same hash) while keeping the log free of
// readable content. The salt is generated once and kept in meta.
//
// HONEST LIMIT — this is not anonymity. Anyone holding this DB already holds the salt, and could
// confirm a GUESSED value by hashing it (the candidate space for names is small). It defeats
// casual reading and stops the log becoming a queryable corpus of personal data; it is not a
// defence against someone with the file and a wordlist. Since sq.db is local and already holds far
// more sensitive content in plain text, that trade is sound here — but do not export this column
// anywhere the raw DB wouldn't go, and do not describe it as anonymized.
function _salt() {
  try {
    let s = db().getMeta('route.obs.salt');
    if (!s) { s = require('crypto').randomBytes(16).toString('hex'); db().setMeta('route.obs.salt', s); }
    return s;
  } catch { return ''; }
}

// Canonical JSON: key order must not change the hash, or the same call logs as two questions.
function canonicalize(v) {
  if (v == null || typeof v !== 'object') return JSON.stringify(v == null ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`;
}

function argHash(args, salt) {
  try {
    if (args == null) return null;
    const s = salt == null ? _salt() : salt;
    return require('crypto').createHash('sha256').update(`${s}|${canonicalize(args)}`).digest('hex').slice(0, 16);
  } catch { return null; }
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
function buildObs(tag, res, { ts, latencyMs = null, focusId = null, autonomous = false, salt = null } = {}) {
  const tool = tagTool(tag);
  if (!tool) return null;
  const args = tagArgs(tag);
  return {
    ts,
    focus_id: focusId || null,
    tool,
    arg_shape: argShape(args),
    arg_hash: argHash(args, salt),
    result_shape: resultShape(res),
    outcome: classify(res),
    latency_ms: latencyMs == null ? null : Math.max(0, Math.round(latencyMs)),
    autonomous: autonomous ? 1 : 0,
  };
}

// ── LINKAGE: which prior call FED this one ───────────────────────────────────────────────────────
//
// A route is not "which questions repeat" (arg_hash answers that) — it is the ORDERED CHAIN where
// one call's OUTPUT becomes the next call's INPUT (search_entities → take an id → kg_neighborhood
// on that id). The log could not see that linkage, so P1 could only derive co-occurrence, not
// causal chaining. This closes that gap.
//
// The signal is detectable at record time WITHOUT storing any value: extract the identifying tokens
// from a call's args (its inputs) and from recent results (their outputs), and if an input matches a
// recent output, THAT result's row is this call's parent. We persist only the parent row id and a
// per-focus sequence number — never a token. The token Sets live in a bounded in-memory buffer and
// are never written anywhere.

const _MIN_TOK = 3;          // shorter tokens ("the", ids < 100) link by coincidence — ignore them
const _MAX_OUT_TOK = 48;     // cap tokens pulled from one result so a 150-row payload can't blow up

// INPUT tokens = the identifying scalar VALUES a call was given. Numbers → their string form; strings
// → lowercased. SQL is skipped (its literals are noisy and already reduced to table names elsewhere).
function extractInputs(args) {
  const out = new Set();
  if (!args || typeof args !== 'object') return out;
  for (const [k, v] of Object.entries(args)) {
    if (/^sql$/i.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) { const s = String(v); if (s.length >= _MIN_TOK) out.add(s); }
    else if (typeof v === 'string') { const s = v.trim().toLowerCase(); if (s.length >= _MIN_TOK) out.add(s); }
  }
  return out;
}

// OUTPUT tokens = the identifying values a result CARRIED: row ids and names, from the common Echo
// payload shapes. Bounded. These are what a later call's inputs get matched against.
function extractOutputs(res) {
  const out = new Set();
  const text = res && typeof res.text === 'string' ? res.text : '';
  if (!text) return out;
  let j = null; try { j = JSON.parse(text); } catch { return out; }
  const rows = !j ? [] : (Array.isArray(j) ? j
    : j.rows || j.results || j.neighbors || j.entities || j.items || j.matches
    || (j.result ? [j.result] : []));
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (out.size >= _MAX_OUT_TOK) break;
    if (r == null) continue;
    if (typeof r === 'object') {
      for (const key of ['id', 'entity_id', 'name', 'title', 'label']) {
        const v = r[key];
        if (v == null) continue;
        const s = String(v).trim().toLowerCase();
        if (s.length >= _MIN_TOK) out.add(s);
      }
    } else {
      const s = String(r).trim().toLowerCase();
      if (s.length >= _MIN_TOK) out.add(s);
    }
  }
  return out;
}

// Does an INPUT token trace to an OUTPUT token? Exact for ids; for names, allow containment either
// way (a query "orange county" feeds a result named "orange county [wd:Q…]", and vice versa) but
// only on tokens long enough that the overlap is not coincidence.
function _tokenLinks(inp, outs) {
  if (outs.has(inp)) return true;
  if (inp.length < 4) return false;                    // ids already matched exactly above
  for (const o of outs) {
    if (o.length < 4) continue;
    if (o.includes(inp) || inp.includes(o)) return true;
  }
  return false;
}

// Given this call's inputs and a buffer of recent { obsId, outs } (most-recent LAST), return the id
// of the most recent buffered call whose outputs fed these inputs, or null. Pure.
function linkParent(inputs, buffer) {
  if (!inputs || !inputs.size || !Array.isArray(buffer)) return null;
  for (let i = buffer.length - 1; i >= 0; i--) {
    const b = buffer[i];
    if (!b || !b.outs || !b.outs.size) continue;
    for (const inp of inputs) if (_tokenLinks(inp, b.outs)) return b.obsId;
  }
  return null;
}

// ── impure edge ────────────────────────────────────────────────────────────────────────────────
let _db = null;
function db() { if (!_db) _db = require('./db'); return _db; }

// Per-focus ring of recent { obsId, seq, outs } — the ONLY place result tokens live, in memory,
// bounded, never persisted. Two caps: BUF_DEPTH recent calls per focus, FOCUS_CAP live focuses.
const _focusBuf = new Map();
const _BUF_DEPTH = 24;
const _FOCUS_CAP = 12;
function _pushBuf(focusId, entry) {
  const key = focusId || '_none';
  let arr = _focusBuf.get(key);
  if (!arr) {
    if (_focusBuf.size >= _FOCUS_CAP) { const first = _focusBuf.keys().next().value; _focusBuf.delete(first); }
    arr = []; _focusBuf.set(key, arr);
  }
  arr.push(entry);
  while (arr.length > _BUF_DEPTH) arr.shift();
}
function _bufFor(focusId) { return _focusBuf.get(focusId || '_none') || []; }
function _resetBuf() { _focusBuf.clear(); }

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

// ── ERROR SURFACING ────────────────────────────────────────────────────────────────────────────
// The root cause of the resolvePlaces bug wasn't the wrong arg — it was that NOBODY EVER SAW the
// error. dispatch already puts Echo's validation message in r.text, and then ~40 call sites do
// `if (!r || !r.ok) return` and throw that diagnostic away. 628 consecutive failures produced zero
// output.
//
// Rather than patch every call site (large diff, easy to miss one, easy to regress), surface it
// HERE — the one place all of them funnel through. De-duplicated per (tool, arg_shape) per process
// so a persistently-broken caller prints once, not 628 times: the point is to make a NEW breakage
// visible, not to flood the log with a known one.
//
// Console only — never the DB. Echo's validation text can echo input values back ("input_value=…"),
// and the route_obs table's shapes-never-values invariant must hold absolutely. Truncated hard.
const _loggedErrors = new Set();
const ERR_TEXT_CAP = 240;
function surfaceError(row, res) {
  try {
    if (!row || row.outcome !== 'error') return;
    const key = `${row.tool}|${row.arg_shape}`;
    if (_loggedErrors.has(key)) return;
    _loggedErrors.add(key);
    const txt = String((res && res.text) || '').replace(/\s+/g, ' ').slice(0, ERR_TEXT_CAP);
    console.error(`[route-obs] FIRST ERROR for ${row.tool}(${row.arg_shape}) → ${txt || '(no message)'}`);
  } catch { /* surfacing must never break anything either */ }
}

// Fail-soft by design: observation must NEVER break a research call. Any throw here is swallowed —
// a lost log row is nothing, a broken dispatch is everything.
function record(tag, res, meta = {}) {
  try {
    if (!enabled()) return null;
    const focusId = meta.focusId || currentFocusId();
    const row = buildObs(tag, res, { ts: Date.now(), ...meta, focusId });
    if (!row) return null;

    // LINKAGE — sequence within the focus, and the id of the prior call whose RESULT fed this call's
    // ARGS. Computed here from in-memory buffers; only the two integers are persisted, never a token.
    const args = tagArgs(tag);
    const buf = _bufFor(focusId);
    const seq = buf.length ? (buf[buf.length - 1].seq + 1) : 0;
    const parentId = linkParent(extractInputs(args), buf);
    row.seq = seq;
    row.parent_id = parentId;

    const info = db().getDb().prepare(
      `INSERT INTO route_obs (ts, focus_id, tool, arg_shape, arg_hash, result_shape, outcome, latency_ms, autonomous, seq, parent_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(row.ts, row.focus_id, row.tool, row.arg_shape, row.arg_hash, row.result_shape, row.outcome, row.latency_ms, row.autonomous, seq, parentId);

    // buffer THIS call's outputs so later calls in the focus can link to it. Result tokens live only
    // here, in memory, bounded — they are never written to the DB.
    _pushBuf(focusId, { obsId: Number(info.lastInsertRowid) || null, seq, outs: extractOutputs(res) });

    surfaceError(row, res);
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
  enabled, record, summary, prune, currentFocusId, surfaceError, _loggedErrors,
  canonicalize, argHash, extractInputs, extractOutputs, linkParent, _resetBuf, _pushBuf, _bufFor,
};
