/**
 * lib/beat_scheduler.js — AUTONOMIC BEAT SCHEDULER: the pure rotation brain (Slice 2c).
 *
 * Decides WHICH beat runs next so autonomic research is DIVERSE across beats yet DEEP within each. The fix
 * for the two failures Lucas named: fixation (one cluster looped forever) and no-diversity/slowness ("if she
 * bounces to something new every heartbeat, how will she do long-run structured research?"). The answer is
 * interleaving at the BEAT/SLICE level, not the tick level: one focus runs at a time (the engine constraint),
 * a beat runs a SLICE — it covers up to `sliceBudget` new targets — then YIELDS the focus to the least-
 * recently-run unfinished beat. Depth comes from a slice being several covered targets deep; diversity comes
 * from the round-robin across beats. A converged completeness beat drops out until maintenance re-activates it.
 *
 * This module is the PURE decision half (offline-testable). All I/O — reading focus state, pausing via
 * focus.clear(), resuming via focus.setCurrent(sameThread), seeding via seedBeatRun — lives in main.js
 * (autonomicSchedulerTick), because pause/resume relies on the thread-scoped focus meta persisting.
 */
'use strict';

const DEFAULT_SLICE_BUDGET = 6;   // new targets one beat covers before yielding the focus to the rotation

// Choose the next beat to run: the not-done beat that was run LEAST RECENTLY (never-run sorts first, so a
// brand-new beat is picked up before an already-cycled one), tie-broken by registry order so the ordering is
// deterministic. `state.beats[id] = { status, lastRun }`. Returns the beat id, or null if every beat is done.
function chooseNext({ beats = [], state = {} } = {}) {
  const stOf = (id) => (state.beats && state.beats[id]) || {};
  const candidates = (beats || []).filter((b) => b && b.id && stOf(b.id).status !== 'done');
  if (!candidates.length) return null;
  let bestId = null, bestLast = null, bestIdx = -1;
  candidates.forEach((b, i) => {
    const lr = stOf(b.id).lastRun;
    const last = (lr == null) ? -Infinity : lr;   // never-run = highest priority
    if (bestId == null || last < bestLast || (last === bestLast && i < bestIdx)) {
      bestId = b.id; bestLast = last; bestIdx = i;
    }
  });
  return bestId;
}

// Should the active beat yield the focus now? Yes when it has converged (done) or it has covered its slice
// budget of new targets this slice. A slice deep enough to matter, short enough to keep the rotation diverse.
function shouldRotate({ sliceCovered = 0, sliceBudget = DEFAULT_SLICE_BUDGET, done = false } = {}) {
  if (done) return true;
  return sliceCovered >= Math.max(1, sliceBudget);
}

// Are all beats converged (nothing left for the scheduler to run)? Used to quiet the loop when the whole
// worklist is exhausted — maintenance re-activates beats when they go stale or news says something changed.
function allDone({ beats = [], state = {} } = {}) {
  const stOf = (id) => (state.beats && state.beats[id]) || {};
  return (beats || []).length > 0 && (beats || []).every((b) => stOf(b.id).status === 'done');
}

// MAINTENANCE (Slice 2d) — a completeness beat is never "done forever": rosters change (elections,
// resignations, appointments). A converged beat becomes due for a freshness re-verify once it has been done
// longer than `intervalMs` (official sites update slowly, so a slow clock; news anchors the fast path
// separately). `doneAt` is when it converged. Returns true → re-activate for a re-verification sweep.
const DEFAULT_MAINTENANCE_MS = 30 * 24 * 60 * 60 * 1000;   // ~monthly freshness sweep of a converged roster
function dueForMaintenance({ status = '', doneAt = null, now = 0, intervalMs = DEFAULT_MAINTENANCE_MS } = {}) {
  if (status !== 'done') return false;
  if (doneAt == null) return false;
  return (now - doneAt) >= Math.max(0, intervalMs);
}

module.exports = { DEFAULT_SLICE_BUDGET, DEFAULT_MAINTENANCE_MS, chooseNext, shouldRotate, allDone, dueForMaintenance };
