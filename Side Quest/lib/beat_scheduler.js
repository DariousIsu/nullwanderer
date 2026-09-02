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

const DEFAULT_SLICE_BUDGET = 3;   // deep dossiers one beat completes before yielding the focus to the rotation
                                  // (each target is a full multi-facet deep-dive now, so a smaller slice keeps
                                  // diversity without cutting depth — depth per target, diversity across states)

// Choose the next beat to run: the not-done beat that was run LEAST RECENTLY (never-run sorts first, so a
// brand-new beat is picked up before an already-cycled one), tie-broken by registry order so the ordering is
// deterministic. `state.beats[id] = { status, lastRun }`. Returns the beat id, or null if every beat is done.
function chooseNext({ beats = [], state = {}, held = null } = {}) {
  const stOf = (id) => (state.beats && state.beats[id]) || {};
  // EXCLUDE held (in-flight-on-a-worker) beats (audit S1): ladderFilter keeps a held beat in the
  // pool as a rung-blocker, so without this the round-robin primary could re-pick a beat a
  // background worker is already driving — two lanes on one thread.
  const heldSet = held instanceof Set ? held : new Set(held || []);
  const candidates = (beats || []).filter((b) => b && b.id && stOf(b.id).status !== 'done' && !heldSet.has(b.id));
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

// LANES (topic/concept beats vs the elected-officials tiers). The elected roster is huge (200+ beats), so in
// a flat least-recently-run rotation the 3 topic beats would each run only ~1/226 of the time. Lanes give the
// topic/concept work fair footing: every `topicEvery`-th slice is drawn from the topic lane, the rest from
// elected. Pure — the caller supplies the running slice index and which lanes are non-empty.
const DEFAULT_TOPIC_EVERY = 3;   // 1 in 3 autonomic slices → topic/concept; 2 in 3 → elected officials
function pickLane({ sliceIndex = 0, topicEvery = DEFAULT_TOPIC_EVERY, hasTopic = true, hasElected = true } = {}) {
  if (!hasTopic) return 'elected';
  if (!hasElected) return 'topic';
  const every = Math.max(2, topicEvery);   // never let topics take EVERY slice
  return (sliceIndex % every === 0) ? 'topic' : 'elected';
}

// ─── PRIORITY ALLOCATION (Slice S1) ───────────────────────────────────────────────────────────
// The evolution of chooseNext: instead of a blind least-recently-run sort, score each not-done beat
// from signals we ALREADY compute and pull the highest. Allocation becomes EMERGENT from the scores
// (grade/staleness/news/yield/fairness) rather than round-robin order — see docs/RESEARCH_ALLOCATION_DESIGN.md.
// This slice ships the HAVE-IT signals only: staleness (cadence-normalized age), news (decaying spike),
// yield (recent new-chars/pass — inert until a cache populates it), and an in-flight penalty (don't pile
// workers on one beat). Grade-gap, user-pin, and object-type fairness are later slices; adding them is a
// new term, not a rewrite. Deliberately DETERMINISTIC — no LLM in the allocation loop (the survey's
// road-less-taken: Swarms' HierarchicalSwarm/MultiAgentRouter assign by LLM; we do not).
//
// PURE: main.js gathers the per-beat signals (news recency, in-flight set) and passes them in; this
// module only scores and ranks, so it stays offline-testable.

const DEFAULT_ALLOC_WEIGHTS = { stale: 1.0, news: 1.5, yield: 0.5, inflight: 2.0, pin: 2.0 };
const YIELD_REF_CHARS = 4000;   // new-chars/pass that maps to yield≈1 (a very productive pass)

function _clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// STALENESS — cadence-normalized age since the beat last ran. Each beat is judged against ITS OWN clock
// (a topic beat's ~3d maintenance vs a roster's ~30d), so "overdue" means overdue for that beat's cadence.
// Never-run (lastRun == null) ⇒ 1 (max urgency), preserving chooseNext's "never-run sorts first". Clamped
// to 1, which is what makes the allocator STARVATION-FREE: any ignored beat climbs to 1 and, with the
// stale weight ≥ the yield weight, eventually outranks any just-run beat regardless of its other signals.
function stalenessTerm({ lastRun = null, now = 0, cadenceMs = DEFAULT_MAINTENANCE_MS } = {}) {
  if (lastRun == null) return 1;
  return _clamp01(Math.max(0, now - lastRun) / Math.max(1, cadenceMs));
}

// YIELD — recent new-chars/pass, normalized. Productive beats float up; exhausted ones sink. Borrowed
// from Swarms' AuctionSwarm bid (the SIGNAL, not the per-item LLM bid). Unknown ⇒ neutral 0.5, which is
// constant across beats so the term is INERT until a rolling cache populates state.beats[id].yieldAvg.
function yieldTerm({ yieldAvg = null } = {}) {
  if (yieldAvg == null) return 0.5;
  return _clamp01(yieldAvg / YIELD_REF_CHARS);
}

// Score one beat. `beatState` = state.beats[id] ({ lastRun, yieldAvg, ... }); `newsScore`/`inFlight`/
// `pinScore` are the caller-supplied live signals. Higher = pull sooner.
//
// PIN (the his-world term, 2026-07-23 — Lucas: "no subc focus, still running counties alphabetically"):
// pinScore ∈ [0,1] = how strongly this beat matches HIS world (active interests, open inquiries). It
// AMPLIFIES staleness rather than adding a constant — direction picks among DUE work, it never
// overrides being due — so the starvation-free property survives by construction: a just-run pinned
// beat (stale≈0) scores ~0 while any ignored bulk beat climbs to stale=1 and gets its turn.
function scoreBeat({ beat = {}, beatState = {}, now = 0, newsScore = 0, inFlight = false, pinScore = 0, weights = {} } = {}) {
  const w = { ...DEFAULT_ALLOC_WEIGHTS, ...weights };
  const cadenceMs = beat.maintenanceMs || DEFAULT_MAINTENANCE_MS;
  const stale = stalenessTerm({ lastRun: beatState.lastRun, now, cadenceMs });
  const yld = yieldTerm({ yieldAvg: beatState.yieldAvg });
  const news = _clamp01(newsScore);
  // PINNED STALENESS FLOOR (2026-07-23, Lucas watching Alaska outrank Louisiana): pin×staleness
  // meant a JUST-RUN his-world beat scored ~0 and the rotation wandered to never-run bulk states.
  // A pinned beat's staleness floors at 0.25×pin, so his-world work re-enters rotation quickly —
  // while a FULLY stale bulk beat (1.0×w.stale) still outranks the floor (0.25×(1+w.pin) = 0.75
  // at defaults), so nothing starves. Direction stays a thumb on the scale, never a monopoly.
  const pin = _clamp01(pinScore);
  const stale2 = pin > 0 ? Math.max(stale, 0.25 * pin) : stale;
  return w.stale * stale2 * (1 + w.pin * pin) + w.news * news + w.yield * yld - w.inflight * (inFlight ? 1 : 0);
}

// Priority twin of chooseNext: pick the highest-scoring not-done beat. `signals(beat) → { newsScore,
// inFlight }` supplies live per-beat signals (default: none). Ties break by registry order, exactly like
// chooseNext, so ordering stays deterministic. Returns the beat id, or null if every beat is done.
function chooseNextByPriority({ beats = [], state = {}, now = 0, signals = () => ({}), weights = {} } = {}) {
  const stOf = (id) => (state.beats && state.beats[id]) || {};
  const candidates = (beats || []).filter((b) => b && b.id && stOf(b.id).status !== 'done');
  if (!candidates.length) return null;
  let bestId = null, bestScore = -Infinity, bestIdx = -1;
  candidates.forEach((b, i) => {
    const sig = signals(b) || {};
    const s = scoreBeat({ beat: b, beatState: stOf(b.id), now, newsScore: sig.newsScore || 0, inFlight: !!sig.inFlight, pinScore: sig.pinScore || 0, weights });
    if (bestId == null || s > bestScore || (s === bestScore && i < bestIdx)) { bestId = b.id; bestScore = s; bestIdx = i; }
  });
  return bestId;
}

// ─── STATE LADDER (leash slice B — Lucas, 2026-07-29) ───────────────────────────────────────────
// "Every state should be mapped from the state government down including capitals and large cities."
// Each state-scoped beat carries a ladderRung (1 state legislature → 2 capital+major cities →
// 3 counties → 4 remaining municipalities → 5 towns/townships → 6 school boards). A state's beat is
// eligible only while NO lower not-done rung exists for that state in the pool — so the sweep walks
// each state top-down instead of walking one tier through every state in the country. IN-FLIGHT beats
// (held by the primary or a worker) still BLOCK their state's lower rungs: working rung N does not
// unlock rung N+1, converging it does — which also spreads parallel workers across states, strict
// ladder within each. Unrunged beats (federal, topics) pass through; a state missing a rung entirely
// (no data → dropped from the schedulable pool) is skipped naturally: the min is taken over what is
// actually schedulable. Pure; the caller supplies pool + scheduler state + the held set.
function ladderFilter(pool = [], state = {}, held = null) {
  const heldSet = held instanceof Set ? held : new Set(held || []);
  const stOf = (id) => (state.beats && state.beats[id]) || {};
  const minRung = new Map();   // stateCode → lowest rung still not converged
  for (const b of pool) {
    if (!b || !b.stateCode || !b.ladderRung) continue;
    if (stOf(b.id).status === 'done' && !heldSet.has(b.id)) continue;   // converged → no longer blocks
    const cur = minRung.get(b.stateCode);
    if (cur == null || b.ladderRung < cur) minRung.set(b.stateCode, b.ladderRung);
  }
  return pool.filter((b) => {
    if (!b || !b.stateCode || !b.ladderRung) return true;
    const min = minRung.get(b.stateCode);
    return min == null || b.ladderRung <= min;
  });
}

// ─── BEAT-ORIGIN IDLE TIER (Lucas, 2026-07-29) ──────────────────────────────────────────────────
// A beat-seeded focus (the government-coverage sweep) shares the directed driver's MECHANICS by
// design — but it must never share its PRIORITY. Measured harm: the sweep ran a pass every 45s,
// resuming 30s after his last keystroke, at his-order rank, owning the browser — direct requests
// and long research (inquiries, idea exploration, test iterations) queued behind an endless
// township walk. The sweep is an IDLE task: it passes only after real user idle, never while her
// reasoned work is in flight, and at idle cadence. User-origin foci are untouched — his real
// orders keep full cadence. Pure decision: main.js supplies the clock and flags.
const DEFAULT_BEAT_IDLE_MS = 10 * 60 * 1000;      // user quiet this long before a sweep pass may start
const DEFAULT_BEAT_CADENCE_MS = 5 * 60 * 1000;    // min gap between sweep passes (his orders run at 45s)
function beatPassGate({ origin, now, lastUserTurnTs = 0, lastBeatPassTs = 0, autonomyInFlight = false, idleMs = DEFAULT_BEAT_IDLE_MS, cadenceMs = DEFAULT_BEAT_CADENCE_MS } = {}) {
  if (origin !== 'beat') return { ok: true, reason: 'user-origin' };
  if (autonomyInFlight) return { ok: false, reason: 'her-work-in-flight' };
  if (now - lastUserTurnTs < idleMs) return { ok: false, reason: 'not-idle' };
  if (now - lastBeatPassTs < cadenceMs) return { ok: false, reason: 'idle-cadence' };
  return { ok: true, reason: 'idle' };
}

module.exports = { DEFAULT_SLICE_BUDGET, DEFAULT_MAINTENANCE_MS, DEFAULT_TOPIC_EVERY, DEFAULT_ALLOC_WEIGHTS, YIELD_REF_CHARS, DEFAULT_BEAT_IDLE_MS, DEFAULT_BEAT_CADENCE_MS, chooseNext, shouldRotate, allDone, dueForMaintenance, pickLane, stalenessTerm, yieldTerm, scoreBeat, chooseNextByPriority, beatPassGate, ladderFilter };
