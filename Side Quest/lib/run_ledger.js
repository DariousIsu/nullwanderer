'use strict';
/*
 * lib/run_ledger.js — THE RUN LEDGER (stage 4.5 C, 2026-09-04; docs/ZOE_MERGE_MAP §"Stage 4.5",
 * contract part 3): "Side Quest's partition threads become child runs of a parent, in the same shape
 * as Echo's agent_runs with parent_run_id. The ledger is what the status vector, the swarm chip, and
 * the mining organ read." P5's JSON envelope (lib/tier_law.ENVELOPE) is the artifact record a run
 * ends with.
 *
 * ONE shape on both sides: the `runs` table (lib/db.js) mirrors Echo's agent_runs column for column
 * and adds the seam — executor (sq | echo), the usage-law lane the run billed, the partition thread,
 * the engine's run id when the executor is Echo, and the envelope. A swarm is a PARENT run; each
 * partition is a CHILD run keyed on its open_threads id; a chat delegate is a run with executor
 * 'echo' whose echo_run_id is the engine's agent_runs key, finished by the consume watcher when the
 * engine reports a terminal state. Nothing here calls a model or the engine; every function is a
 * SELECT/INSERT over an injected db handle (default: the app's), so the smoke covers it offline.
 */

const STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const PREVIEW = 200;
const OUTPUT_CAP = 20000;

function _db(opts) { return (opts && opts.db) || require('./db').getDb(); }
// run ids come from the crypto source only (the entropy firewall: no ungoverned Math.random in lib/)
function _id() { const c = require('crypto'); try { return c.randomUUID().replace(/-/g, ''); } catch { return c.randomBytes(16).toString('hex'); } }
const _j = (v) => (v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)));
const _p = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };

// P5's envelope as the artifact record: the shape his master skill fixed (lib/tier_law.ENVELOPE).
// A run may end without one (a partition's covered targets are its record); when one is given it is
// checked for the top-level keys and stored as given — never rewritten.
function envelopeOk(env) {
  if (!env || typeof env !== 'object') return { ok: false, missing: ['envelope'] };
  const keys = Object.keys(require('./tier_law').ENVELOPE).filter((k) => k !== '_next');
  const missing = keys.filter((k) => !(k in env));
  return { ok: missing.length === 0, missing };
}

/** Open a run. Returns the run_id. `state` defaults to running; pass 'queued' for a delegate the engine has not started. */
function start({ role, executor = 'sq', trigger_kind, trigger_meta = null, lane = null, model = null, input_preview = null,
                 parent_run_id = null, thread_id = null, echo_run_id = null, run_id = null, state = 'running', now = Date.now() } = {}, opts) {
  const db = _db(opts);
  const id = run_id || _id();
  const st = STATES.includes(state) ? state : 'running';
  db.prepare(`INSERT OR REPLACE INTO runs (run_id, role, executor, trigger_kind, trigger_meta, lane, state, started_at, model, input_preview, parent_run_id, thread_id, echo_run_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, String(role || 'unknown'), executor === 'echo' ? 'echo' : 'sq', String(trigger_kind || 'manual'), _j(trigger_meta), lane ? String(lane) : null,
         st, Math.floor(now), model ? String(model) : null, input_preview ? String(input_preview).slice(0, PREVIEW) : null,
         parent_run_id || null, Number.isFinite(thread_id) ? thread_id : null, echo_run_id || null);
  return id;
}

/** Close (or advance) a run. A terminal state stamps ended_at; a non-terminal one (running) only patches. */
function finish(run_id, { state = 'succeeded', output = null, error = null, envelope = null, tokens_in = null, tokens_out = null, tool_calls = null, model = null, now = Date.now() } = {}, opts) {
  const db = _db(opts);
  const st = STATES.includes(state) ? state : 'succeeded';
  const row = db.prepare('SELECT run_id, state FROM runs WHERE run_id = ?').get(run_id);
  if (!row) return { ok: false, why: 'unknown run' };
  if (TERMINAL.has(row.state) && !TERMINAL.has(st)) return { ok: false, why: 'already terminal' };
  const env = envelope ? envelopeOk(envelope) : null;
  // ended_at is stamped ONCE (the first terminal close); a late patch (tokens, an envelope) keeps it.
  db.prepare(`UPDATE runs SET state = ?, ended_at = COALESCE(ended_at, ?), output = COALESCE(?, output), error = COALESCE(?, error),
              envelope = COALESCE(?, envelope), tokens_in = COALESCE(?, tokens_in), tokens_out = COALESCE(?, tokens_out),
              tool_calls = COALESCE(?, tool_calls), model = COALESCE(?, model) WHERE run_id = ?`)
    .run(st, TERMINAL.has(st) ? Math.floor(now) : null, output == null ? null : String(output).slice(0, OUTPUT_CAP), error == null ? null : String(error).slice(0, 2000),
         envelope ? _j(envelope) : null, Number.isFinite(tokens_in) ? tokens_in : null, Number.isFinite(tokens_out) ? tokens_out : null,
         tool_calls == null ? null : _j(tool_calls), model ? String(model) : null, run_id);
  return { ok: true, state: st, envelope: env };
}

/** The engine side's key: finish the run that carries this echo_run_id (a delegate the consume watcher just resolved). */
function finishByEcho(echo_run_id, patch, opts) {
  const db = _db(opts);
  const row = db.prepare('SELECT run_id FROM runs WHERE echo_run_id = ? ORDER BY started_at DESC LIMIT 1').get(echo_run_id);
  if (!row) return { ok: false, why: 'no run for that echo_run_id' };
  return finish(row.run_id, patch, opts);
}
function linkEcho(run_id, echo_run_id, opts) { _db(opts).prepare('UPDATE runs SET echo_run_id = ? WHERE run_id = ?').run(echo_run_id, run_id); }

function get(run_id, opts) { return _hydrate(_db(opts).prepare('SELECT * FROM runs WHERE run_id = ?').get(run_id)); }
function byThread(thread_id, opts) { return _hydrate(_db(opts).prepare('SELECT * FROM runs WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1').get(thread_id)); }
function children(parent_run_id, opts) { return _db(opts).prepare('SELECT * FROM runs WHERE parent_run_id = ? ORDER BY started_at').all(parent_run_id).map(_hydrate); }
function live(opts) { return _db(opts).prepare("SELECT * FROM runs WHERE state IN ('queued','running') ORDER BY started_at").all().map(_hydrate); }
function recent({ limit = 20 } = {}, opts) { return _db(opts).prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(Math.max(1, limit | 0)).map(_hydrate); }

/** A run with its children nested (one level is what a swarm needs; deeper trees recurse). */
function tree(run_id, opts, depth = 0) {
  const root = get(run_id, opts);
  if (!root) return null;
  root.children = depth < 4 ? children(run_id, opts).map((c) => tree(c.run_id, opts, depth + 1)) : [];
  return root;
}

/** What the status vector reads: live counts and the last finished run — SELECTed, never computed from vibes. */
function summary({ now = Date.now() } = {}, opts) {
  const db = _db(opts);
  const hour = Math.floor(now - 3600e3);
  const lv = db.prepare("SELECT COUNT(*) n, SUM(parent_run_id IS NULL) parents, SUM(executor = 'echo') echo FROM runs WHERE state IN ('queued','running')").get() || {};
  const fin = db.prepare("SELECT SUM(state = 'succeeded') ok, SUM(state = 'failed') failed, SUM(state = 'cancelled') cancelled FROM runs WHERE ended_at >= ?").get(hour) || {};
  const last = db.prepare("SELECT run_id, role, executor, state, lane, ended_at FROM runs WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1").get() || null;
  const lanes = {};
  for (const r of db.prepare("SELECT COALESCE(lane, '?') lane, COUNT(*) n FROM runs WHERE state IN ('queued','running') GROUP BY 1").all()) lanes[r.lane] = r.n;
  return { live: lv.n || 0, live_parents: lv.parents || 0, live_children: (lv.n || 0) - (lv.parents || 0), live_echo: lv.echo || 0, lanes,
           last_hour: { succeeded: fin.ok || 0, failed: fin.failed || 0, cancelled: fin.cancelled || 0 }, last };
}

function _hydrate(r) {
  if (!r) return null;
  return { ...r, trigger_meta: _p(r.trigger_meta), envelope: _p(r.envelope), tool_calls: _p(r.tool_calls) };
}

module.exports = { STATES, TERMINAL, PREVIEW, envelopeOk, start, finish, finishByEcho, linkEcho, get, byThread, children, live, recent, tree, summary };
