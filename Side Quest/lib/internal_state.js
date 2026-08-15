/**
 * lib/internal_state.js — SLICE 0 of the internal-state vector: THE DARK INSTRUMENT.
 * (PROPOSAL_INTERNAL_STATE_VECTOR_2026-08-14.md; built 2026-08-15 on Lucas's "clear to continue"
 * — the standing queue it was placed behind is done, and the consciousness-allocation ruling
 * funds it. Extends EMOTIONAL_MATRIX_DESIGN.md's affect half with the drive half.)
 *
 * GOVERNING RULE — MEASURED NEVER ASSERTED: every scalar is a READING computed from exhaust the
 * organs already emit, carrying its provenance. Nothing here writes prompt prose, and NOTHING
 * READS THIS YET: Slice 0 has ZERO consumers by design (the built-dark-on-purpose pattern —
 * measure first, wire consumers only after ~48h of journaled trajectories prove the readings
 * honest by hand). Even lib/status_vector's waiting `drives` seam (meta drive_gauge) stays
 * unwritten until that proof — the state door must not render an unproven instrument.
 *
 * THE STATE — one object, two families:
 *   drives (computed FRESH each tick, direct formulas, no dynamics): PRESSURE 0..1, high = need.
 *     curiosity — 1 − intake diversity (distinct queries + distinct content-heads over the last
 *                 ~40 readings/thoughts). Repetitive circling → starved → pressure rises.
 *                 (Upgrade path: the tick's live 1−cosine novelty, once it is persisted exhaust.)
 *     social    — shaped elapsed time since Lucas's last real turn (half-rise ~5h, saturates ~24h).
 *     energy    — EXHAUSTION = the quota pool's usedPct (rested when the pool is fresh). ABSENT
 *                 (not defaulted) when no quota is configured — fail-absent, never a guess.
 *     progress  — 1 − worklist motion (share of open threads touched in 48h). Stalls itch.
 *   vad (impulse + decay dynamics, memo §5: state = baseline + decay(prev−baseline, Δt) + impulses):
 *     valence/arousal/dominance, moved ONLY by CODED deterministic appraisals of obs_bus events
 *     (errors ↓v ↑a; warn-anomalies ↑a; minted needs ↑a; rotations/info neutral). The model-based
 *     appraisal ensemble is Slice 3+; until then affect moves only on what verifiably happened.
 *
 * NO drive_autonomy — refused in the review; her "no" stays epistemic, never motivational.
 * Persistence: meta internal_state (current) + internal_state.journal (ring ~300 ≈ 50h at the
 * 10-min tick). Deterministic: identical injected inputs replay an identical trajectory (smoked).
 */
'use strict';

const STATE_KEY = 'internal_state';
const JOURNAL_KEY = 'internal_state.journal';
const JOURNAL_CAP = 300;
const VAD_BASELINE = { v: 0.55, a: 0.45, d: 0.50 };
const VAD_HALF_LIFE_MS = 4 * 3600e3;
const SOCIAL_HALF_RISE_MS = 5 * 3600e3;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const r2 = (x) => Math.round(x * 100) / 100;

function _db(deps) { return (deps && deps.db) || require('./db'); }

// ── drive readings (each: exhaust in → {value, prov} out; pure given inputs) ────────────────────
function curiosityReading(rows) {
  if (!Array.isArray(rows) || rows.length < 8) return null;   // too little intake to measure
  const qs = new Set(), heads = new Set();
  for (const r of rows) {
    if (r && r.query) qs.add(String(r.query).toLowerCase().slice(0, 40));
    if (r && r.content) heads.add(String(r.content).toLowerCase().replace(/\s+/g, ' ').slice(0, 60));
  }
  const diversity = clamp01(((qs.size ? qs.size / rows.length : 0) + heads.size / rows.length) / (qs.size ? 2 : 1));
  return { value: r2(1 - diversity), prov: `1 − intake diversity over ${rows.length} recent readings (${heads.size} distinct heads, ${qs.size} distinct queries)` };
}
function socialReading(lastUserTurnTs, nowMs) {
  if (!lastUserTurnTs) return null;
  const gap = Math.max(0, nowMs - lastUserTurnTs);
  const p = 1 - Math.exp(-gap / (SOCIAL_HALF_RISE_MS / Math.LN2));   // half-rise at ~5h, →1 by ~a day
  return { value: r2(clamp01(p)), prov: `${Math.round(gap / 60000)}m since Lucas's last turn (half-rise 5h)` };
}
function energyReading(quotaState) {
  if (!quotaState || !quotaState.known) return null;   // no quota configured → ABSENT, never guessed
  return { value: r2(clamp01(quotaState.usedPct)), prov: `quota pool ${Math.round(quotaState.usedPct * 100)}% used, ${quotaState.hoursLeft != null ? quotaState.hoursLeft.toFixed(1) : '?'}h to reset (exhaustion = spend)` };
}
function progressReading(threads, nowMs) {
  if (!Array.isArray(threads) || !threads.length) return null;
  const touched = threads.filter((t) => t && (nowMs - (t.last_touched_ts || t.created_ts || 0)) < 48 * 3600e3).length;
  return { value: r2(1 - touched / threads.length), prov: `${touched}/${threads.length} open threads moved in 48h (stall = pressure)` };
}

// ── affect dynamics (pure) ──────────────────────────────────────────────────────────────────────
function decayVad(prev, dtMs) {
  const k = Math.pow(0.5, Math.max(0, dtMs) / VAD_HALF_LIFE_MS);
  const out = {};
  for (const ax of ['v', 'a', 'd']) out[ax] = VAD_BASELINE[ax] + ((prev && prev[ax] != null ? prev[ax] : VAD_BASELINE[ax]) - VAD_BASELINE[ax]) * k;
  return out;
}
// Coded deterministic appraisal of obs_bus events since the last tick. Small, documented map;
// per-tick impulse capped so a flood can't slam the state (the memo's lurch bound).
function appraiseEvents(events) {
  let dv = 0, da = 0, dd = 0;
  const why = [];
  for (const e of (events || [])) {
    if (!e || !e.level) continue;
    if (e.level === 'error') { dv -= 0.04; da += 0.03; dd -= 0.02; why.push(`error:${e.lane}`); }
    else if (e.level === 'warn' && e.kind === 'anomaly') { da += 0.03; dd -= 0.01; why.push(`anomaly:${e.lane}`); }
    else if (e.kind === 'need') { da += 0.02; why.push('need-minted'); }
  }
  return {
    dv: Math.max(-0.12, Math.min(0.12, dv)),
    da: Math.max(-0.12, Math.min(0.12, da)),
    dd: Math.max(-0.12, Math.min(0.12, dd)),
    why: why.slice(0, 6),
  };
}

/**
 * One tick: read exhaust → drives; decay + appraise → vad; persist current + journal. All inputs
 * injectable (deps: db, monologueRows, openThreads, quotaState, lastUserTurnTs, events) — the live
 * defaults read the real stores; identical inputs replay identically.
 */
function tick({ deps = {}, nowMs = Date.now() } = {}) {
  const db = _db(deps);
  let prev = null;
  try { prev = JSON.parse(db.getMeta(STATE_KEY) || 'null'); } catch {}

  // exhaust in (live defaults, every one fail-soft → an absent reading, never a default)
  const rows = deps.monologueRows !== undefined ? deps.monologueRows
    : (() => { try { return db.getDb().prepare("SELECT content, query FROM monologue WHERE type IN ('reading','thought') ORDER BY id DESC LIMIT 40").all(); } catch { return null; } })();
  const threads = deps.openThreads !== undefined ? deps.openThreads
    : (() => { try { return db.getActiveOpenThreads(200) || []; } catch { return null; } })();
  const qs = deps.quotaState !== undefined ? deps.quotaState
    : (() => { try { return require('./quota_gate').state(nowMs); } catch { return null; } })();
  const events = deps.events !== undefined ? deps.events
    : (() => { try { return require('./obs_bus').recent({ sinceId: (prev && prev.obsCursor) || 0, limit: 200 }); } catch { return []; } })();

  const drives = {}, prov = {};
  for (const [name, r] of [
    ['curiosity', curiosityReading(rows)],
    ['social', socialReading(deps.lastUserTurnTs, nowMs)],
    ['energy', energyReading(qs)],
    ['progress', progressReading(threads, nowMs)],
  ]) { if (r) { drives[name] = r.value; prov[name] = r.prov; } }

  const dt = prev && prev.at ? nowMs - prev.at : 0;
  const decayed = decayVad(prev && prev.vad, dt);
  const imp = appraiseEvents(events);
  const vad = { v: r2(clamp01(decayed.v + imp.dv)), a: r2(clamp01(decayed.a + imp.da)), d: r2(clamp01(decayed.d + imp.dd)) };
  if (imp.why.length) prov.vad = `impulses: ${imp.why.join(', ')}`;

  const cur = { at: nowMs, drives, vad, prov, obsCursor: events && events.length ? (events[events.length - 1].id || (prev && prev.obsCursor) || 0) : ((prev && prev.obsCursor) || 0) };
  try { db.setMeta(STATE_KEY, JSON.stringify(cur)); } catch {}
  try {
    const j = (() => { try { return JSON.parse(db.getMeta(JOURNAL_KEY) || '[]') || []; } catch { return []; } })();
    j.push({ at: nowMs, d: drives, vad });
    db.setMeta(JOURNAL_KEY, JSON.stringify(j.slice(-JOURNAL_CAP)));
  } catch {}
  return cur;
}

/** The 48h hand-verification readout (scripts/read_internal_state.js renders it). */
function journal({ deps = {} } = {}) {
  try { return JSON.parse(_db(deps).getMeta(JOURNAL_KEY) || '[]') || []; } catch { return []; }
}

module.exports = {
  tick, journal, curiosityReading, socialReading, energyReading, progressReading,
  decayVad, appraiseEvents, STATE_KEY, JOURNAL_KEY, JOURNAL_CAP, VAD_BASELINE, VAD_HALF_LIFE_MS,
};
