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

/**
 * Dispatch ONE partition to an engine role: spawn_agent_async(name=role, prompt=brief, lane=the parent's
 * tier) and open the child run in the ledger keyed on the engine's run id. Returns the part record the
 * swarm state keeps, or {ok:false, why}.
 */
async function dispatchEchoPartition({ role, goal, targets, index, of, facets = null, lane, parentRunId = null, beatId = null, trigger_kind = 'scheduled', autonomous = true,
                                       deps = {} } = {}) {
  const { dispatch, ledger, now = Date.now } = deps;
  if (typeof dispatch !== 'function' || !ledger) return { ok: false, why: 'no dispatch / ledger' };
  const prompt = brief({ goal, targets, index, of, facets });
  let r = null;
  try { r = await dispatch({ kind: 'do', name: 'spawn_agent_async', args: { name: role, prompt, lane, canvas_tab: beatId ? `swarm-${String(beatId).slice(0, 24)}-${index}` : undefined } }, { autonomous }); }
  catch (e) { return { ok: false, why: `dispatch threw: ${(e && e.message) || e}` }; }
  if (!r || r.ok === false || r.isError) return { ok: false, why: `engine refused: ${String((r && r.text) || '').slice(0, 160)}` };
  const echoRunId = rf.parseRunId(r && r.text);
  if (!echoRunId) return { ok: false, why: `no run_id in the engine's reply: ${String((r && r.text) || '').slice(0, 120)}` };
  let runId = null;
  try {
    runId = ledger.start({ role, executor: 'echo', trigger_kind, trigger_meta: { beatId, partition: index, of, autonomous, via: 'swarm-executor' }, lane, parent_run_id: parentRunId, echo_run_id: echoRunId, state: 'queued', input_preview: `${beatId || 'swarm'} partition ${index}/${of} → ${role} (${targets.length} targets)`, now: now() });
  } catch {}
  return { ok: true, part: { executor: 'echo', role, echo_run_id: echoRunId, run_id: runId, n: targets.length, targets: targets.slice(), done: false, startedAt: now() } };
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
