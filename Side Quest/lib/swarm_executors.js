'use strict';
/*
 * lib/swarm_executors.js — the RUNTIME half of partitions-as-executors (stage 4.5 D/E, 2026-09-04):
 * dispatching a partition to an engine role, closing engine runs the ledger holds open, and folding a
 * finished engine partition back where this side's partitions land (covered targets on the parent).
 *
 * Every door takes its collaborators injected (dispatch, the ledger, the meta store, the clock), so the
 * smoke drives all three offline. main.js supplies the live ones: the echo suit's dispatch, lib/run_ledger,
 * db meta. Nothing here calls a model.
 */

const rf = require('./review_fanout');
const { brief } = require('./executor_pick');
const { foldResult } = require('./partition_fold');

// Pull a specific id key out of an engine reply ("team_run_id"/"thread_id"), tolerant of JSON/prose.
function _parseKey(text, key) {
  const m = new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']([\\w.-]+)["']`).exec(String(text || ''));
  return m ? m[1] : null;
}
// The workflow's result text: its final_state, else its output — for the fold.
function _workflowOutput(text) {
  const s = String(text || '');
  let m = /"final_state"\s*:\s*("(?:[^"\\]|\\.)*"|\{[\s\S]*?\}|\[[\s\S]*?\])/.exec(s);
  if (m) { try { return typeof JSON.parse(m[1]) === 'string' ? JSON.parse(m[1]) : m[1]; } catch { return m[1]; } }
  return rf.parseRunOutput(s) || s;
}

/**
 * Dispatch ONE partition to an engine EXECUTOR (stage 4.5): mode 'agent' → spawn_agent_async (a single
 * role, polled to done); mode 'team' → team_spawn (Echo's star supervisor — its parent row lives in
 * agent_runs under team_run_id, so the SAME agent_status/get_agent_output poll closes it); mode
 * 'workflow' → spawn_workflow (a named graph — BLOCKING, returns final_state inline, so its ledger run
 * opens and closes in this call). Every mode carries the partition's lane + parent run + beat, opens a
 * ledger run keyed on the engine's id, and folds onto the parent — the team/workflow are executors OF
 * the one primitive, never a second swarm. Returns the part record, or {ok:false, why} to fall back.
 */
async function dispatchEchoPartition({ role, mode = 'agent', members = null, validator = null, workflow = null, goal, targets, index, of, facets = null, lane, parentRunId = null, beatId = null, trigger_kind = 'scheduled', autonomous = true,
                                       deps = {} } = {}) {
  const { dispatch, ledger, now = Date.now } = deps;
  if (typeof dispatch !== 'function' || !ledger) return { ok: false, why: 'no dispatch / ledger' };
  const prompt = brief({ goal, targets, index, of, facets, markers: mode !== 'workflow' });
  const meta = { beatId, partition: index, of, autonomous, via: 'swarm-executor', mode };
  const cap = `${beatId || 'swarm'} partition ${index}/${of} → ${mode}:${role} (${targets.length} targets)`;
  let r = null;
  try {
    if (mode === 'team') {
      r = await dispatch({ kind: 'do', name: 'team_spawn', args: { task: prompt, members: members || [], validator: validator || undefined, lane } }, { autonomous });
    } else if (mode === 'workflow') {
      r = await dispatch({ kind: 'do', name: 'spawn_workflow', args: { name: workflow, input: { prompt }, lane } }, { autonomous });
    } else {
      r = await dispatch({ kind: 'do', name: 'spawn_agent_async', args: { name: role, prompt, lane, canvas_tab: beatId ? `swarm-${String(beatId).slice(0, 24)}-${index}` : undefined } }, { autonomous });
    }
  } catch (e) { return { ok: false, why: `dispatch threw: ${(e && e.message) || e}` }; }
  if (!r || r.ok === false || r.isError) return { ok: false, why: `engine refused: ${String((r && r.text) || '').slice(0, 160)}` };

  if (mode === 'workflow') {
    // BLOCKING: the workflow already ran; open + close the ledger run inline and mark the part done so
    // the maintainer folds it on the next tick (no poll — spawn_workflow returned the final state).
    const tid = _parseKey(r.text, 'thread_id') || `wf_${index}`;
    const state = (rf.parseRunState(r.text) === 'failed') ? 'failed' : 'succeeded';
    const output = _workflowOutput(r.text);
    let runId = null;
    try { runId = ledger.start({ role: `workflow:${workflow}`, executor: 'echo', trigger_kind, trigger_meta: { ...meta, workflow }, lane, parent_run_id: parentRunId, echo_run_id: tid, state: 'running', input_preview: cap, now: now() }); if (runId) ledger.finish(runId, { state, output, now: now() }); } catch {}
    // done:false though it already ran — the ledger run is TERMINAL, so the maintainer folds it (onto the
    // parent's covered list) on the next tick through the same engine-part path as a team/agent, then marks it done.
    return { ok: true, part: { executor: 'echo', mode, role: `workflow:${workflow}`, workflow, echo_run_id: tid, run_id: runId, n: targets.length, targets: targets.slice(), done: false, startedAt: now() } };
  }

  const echoRunId = mode === 'team' ? _parseKey(r.text, 'team_run_id') : rf.parseRunId(r && r.text);
  if (!echoRunId) return { ok: false, why: `no ${mode === 'team' ? 'team_run_id' : 'run_id'} in the engine's reply: ${String((r && r.text) || '').slice(0, 120)}` };
  const ledgerRole = mode === 'team' ? `team:${(members || []).join('+')}` : role;
  let runId = null;
  try {
    runId = ledger.start({ role: ledgerRole, executor: 'echo', trigger_kind, trigger_meta: { ...meta, ...(members ? { members } : {}) }, lane, parent_run_id: parentRunId, echo_run_id: echoRunId, state: 'queued', input_preview: cap, now: now() });
  } catch {}
  return { ok: true, part: { executor: 'echo', mode, role: ledgerRole, members: members || undefined, echo_run_id: echoRunId, run_id: runId, n: targets.length, targets: targets.slice(), done: false, startedAt: now() } };
}

/**
 * Close engine runs the ledger holds open that no chat watcher owns: poll agent_status (≤max per tick,
 * only runs older than minAgeMs), fetch the output on success, finish the ledger row. Returns counts.
 */
async function closeEchoRuns({ deps = {} } = {}) {
  const { dispatch, ledger, pendingIds = new Set(), now = Date.now(), max = 3, minAgeMs = 15000, log = () => {} } = deps;
  if (typeof dispatch !== 'function' || !ledger) return { checked: 0, closed: 0 };
  let checked = 0, closed = 0;
  const live = (ledger.live() || []).filter((r) => r && r.executor === 'echo' && r.echo_run_id && !pendingIds.has(r.echo_run_id) && now - (r.started_at || 0) >= minAgeMs);
  for (const r of live) {
    if (checked >= max) break;
    checked++;
    let state = null;
    try { const s = await dispatch({ kind: 'do', name: 'agent_status', args: { run_id: r.echo_run_id } }, { autonomous: true }); state = rf.parseRunState(s && s.text); } catch {}
    if (!state || !rf.isTerminal(state)) continue;
    if (state !== 'succeeded') { ledger.finishByEcho(r.echo_run_id, { state: state === 'cancelled' ? 'cancelled' : 'failed', error: `engine reported ${state}`, now }); closed++; log(`[swarm-executor] engine run ${r.echo_run_id} (${r.role}) ended ${state}`); continue; }
    let output = '';
    try { const o = await dispatch({ kind: 'do', name: 'get_agent_output', args: { run_id: r.echo_run_id } }, { autonomous: true }); output = rf.parseRunOutput(o && o.text); } catch {}
    ledger.finishByEcho(r.echo_run_id, { state: 'succeeded', output: output || null, now });
    closed++;
    log(`[swarm-executor] engine run ${r.echo_run_id} (${r.role}) succeeded — ${(output || '').length} chars folded into the ledger`);
  }
  return { checked, closed };
}

/**
 * Fold a FINISHED engine partition where this side's partitions land: the targets its FOUND lines
 * established join the parent's covered list (coveredKey), matched by the coverage rule. Returns what
 * was folded; the caller marks the part done.
 */
function foldEchoPartition({ part, run, coveredKey, getMeta, setMeta, log = () => {} } = {}) {
  if (!part || !run) return { ok: false, why: 'no part/run' };
  if (run.state !== 'succeeded') return { ok: true, covered: 0, state: run.state };
  // THE MARKER CONTRACT (stage 4.5): foldResult unions FOUND-line coverage with `target:` markers and
  // pulls the ADDRESS markers (document/entity/url/…) the partition stored — the assembler reads those
  // by address, never the raw text. The addresses ride the part record for the assembler to resolve.
  const f = foldResult({ output: run.output || '', targets: part.targets || [] });
  if (part && f.addressMarkers.length) part.markers = f.addressMarkers;
  let added = 0;
  if (coveredKey && f.covered.length) {
    let covered = [];
    try { covered = JSON.parse(getMeta(coveredKey) || '[]') || []; } catch { covered = []; }
    const seen = new Set(covered.map((c) => String(c).toLowerCase()));
    for (const t of f.covered) if (!seen.has(String(t).toLowerCase())) { covered.push(t); seen.add(String(t).toLowerCase()); added++; }
    if (added) { try { setMeta(coveredKey, JSON.stringify(covered)); } catch {} }
  }
  log(`[swarm-executor] partition ${part.role} folded: ${f.covered.length} of ${(part.targets || []).length} target(s) established (${added} newly covered), ${f.addressMarkers.length} marker(s), ${f.notFound.length} not found, ${f.sources.length} source(s)`);
  return { ok: true, covered: f.covered.length, added, markers: f.addressMarkers.length, notFound: f.notFound.length, sources: f.sources.length, unmatched: f.unmatched.length };
}

module.exports = { dispatchEchoPartition, closeEchoRuns, foldEchoPartition };
