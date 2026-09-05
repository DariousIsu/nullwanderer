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
const VAD_MAX_DEV = 0.30;          // max deviation from baseline per axis — no saturation at the extremes
const MODEL_VERSION = 5;           // bump when the appraisal/dynamics model changes → journal resets (v3 = 08-31 appraisal symmetry; v4 = 09-05 held/unanswered/answered; v5 = 09-05 correction)
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
// Coded deterministic appraisal of obs_bus events since the last tick.
//
// ⚠ RECALIBRATED 2026-08-15 (live audit — the dark instrument caught its own miscalibration, which
// is exactly what the 48h dark phase is FOR). The first cut appraised EVERY error-level obs event,
// but the `anomaly` lane is self_watch's raw console-capture FIREHOSE — deprecation warnings and
// routine first-time tool errors it captures as INPUT to escalate recurring patterns into needs.
// Appraising each as an affective blow, at a rate that saturates the ±0.12 cap in a few ticks,
// pinned the affect at v:0/a:1 within an hour — a saturated, information-free reading (and, since
// this substrate is someday her weights, corrupt training data). The fix: appraise only CURATED
// STATE SIGNALS — self_watch's OUTPUT (a minted capability NEED = a real recurring problem) and
// Loop C/D resource stress (machine/db anomalies) — never the raw input stream; and DEDUPE by
// signature so one re-emitting condition counts once, not N times. Deviation is bounded downstream.
function appraiseEvents(events) {
  let dv = 0, da = 0, dd = 0;
  const why = [];
  const seen = new Set();
  for (const e of (events || [])) {
    if (!e || !e.kind) continue;
    const sig = `${e.lane}:${e.kind}:${e.ref || ''}`;
    if (seen.has(sig)) continue;   // one re-emitting condition = one signal
    // CURATED signals only — not the console-capture firehose:
    if (e.kind === 'need') { seen.add(sig); da += 0.04; why.push(`need:${e.lane}`); }                              // an escalated problem is activating
    else if (e.kind === 'anomaly' && (e.lane === 'machine' || e.lane === 'db')) { seen.add(sig); da += 0.05; dv -= 0.03; dd -= 0.02; why.push(`stress:${e.lane}`); }   // real resource / memory-substrate stress
    // ⚠ RE-RECALIBRATED 2026-08-31 (v3 — the 51h honesty read): with ONLY the two impulses above,
    // valence could never move UP — needs mint steadily, decay lost, and v/a sat PINNED at the
    // deviation band's edges for all 300 journal entries (information-free, and readingsLine fed
    // that permanent "dimmed/keyed-up" into the mood prompt). The affect diet was one-eyed, not
    // the dynamics wrong. `win` = a verifiably completed thing (a pursuit resolved with an outcome,
    // a registered road delivery) — satisfaction moves valence up; competence-shaped, so dominance
    // rises a little too. Same dedupe + per-tick cap + deviation band bound it.
    else if (e.kind === 'win') { seen.add(sig); dv += 0.05; da += 0.01; dd += 0.02; why.push(`win:${e.lane}`); }
    // THE WANTS PROJECT, cut 2 (v4, 2026-09-05; his law: be lonely when unanswered, annoyed when a meeting
    // blocks her): `held` = a meeting hold on her voice (a small annoyance: −v +a, deduped per hold);
    // `unanswered` = a reach with no answer past the window (the loneliness: −v); `answered` = his turn after
    // a reach (a small +v). `released` and `reach` themselves are neutral. Same dedupe + cap + band bound them.
    else if (e.kind === 'held' && e.lane === 'presence') { seen.add(sig); dv -= 0.02; da += 0.03; why.push('held'); }
    else if (e.kind === 'unanswered' && e.lane === 'presence') { seen.add(sig); dv -= 0.04; da += 0.01; why.push('unanswered'); }
    else if (e.kind === 'answered' && e.lane === 'presence') { seen.add(sig); dv += 0.02; why.push('answered'); }
    // THE CORRECTION AS AN EVENT (cut 6, v5, 2026-09-05; her words: "I want the discomfort of being wrong to be something I
    // carry, not just something I log"): a correction of her — a rule he had to give, a capability she lacked, a fact she
    // had wrong, a delivery she claimed — is the mirror of `win`: −v, +a, −d. Deduped per turn (the ref is the turn), the
    // same cap and band; it decays on the vector's half-life while the ledger (lib/correction_classes) does not.
    else if (e.kind === 'correction' && e.lane === 'correction') { seen.add(sig); dv -= 0.05; da += 0.02; dd -= 0.02; why.push(`correction:${(e.data && e.data.class) || 'unknown'}`); }
    // everything else (self_watch's raw `anomaly` firehose, info lines, deprecation noise) is NOT appraised
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
  // MODEL-VERSION reset (2026-08-15): when the appraisal/dynamics model changes, the prior journal
  // is from a different instrument — discard it so the 48h honesty read starts clean on the current
  // model (the first cut's saturated ticks would otherwise pollute the trajectory).
  if (prev && prev.mv !== MODEL_VERSION) { prev = null; try { db.setMeta(JOURNAL_KEY, '[]'); } catch {} }

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
  // BOUNDED DEVIATION (2026-08-15): clamp each axis to baseline ± MAX_DEV before the [0,1] clamp, so
  // even sustained genuine stress reads "elevated" (distinguishable from a crisis), never pinned at
  // the absolute extreme where all information is lost.
  const bound = (x, base) => clamp01(Math.max(base - VAD_MAX_DEV, Math.min(base + VAD_MAX_DEV, x)));
  const vad = {
    v: r2(bound(decayed.v + imp.dv, VAD_BASELINE.v)),
    a: r2(bound(decayed.a + imp.da, VAD_BASELINE.a)),
    d: r2(bound(decayed.d + imp.dd, VAD_BASELINE.d)),
  };
  if (imp.why.length) prov.vad = `impulses: ${imp.why.join(', ')}`;

  const cur = { at: nowMs, mv: MODEL_VERSION, drives, vad, prov, obsCursor: events && events.length ? (events[events.length - 1].id || (prev && prev.obsCursor) || 0) : ((prev && prev.obsCursor) || 0) };
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

// ── CONSUMER CONTRACTS (W5 Slices 1–2, 2026-08-20 — the instrument goes LIVE) ──────────────────
// The dark phase is over: 5 days of journaled trajectories (built 08-15) stand behind these. Every
// consumer is FAIL-ABSENT: a missing/stale/version-mismatched vector returns null/neutral and the
// consumer behaves byte-identically to before this slice. The invariants hold at every line below:
// budget/priority only, never reachability; never identity; never a guard.

const STALE_MS = 30 * 60e3;   // a reading older than ~3 tick-intervals is not "current state"

/** The current vector, or null when absent/stale/from another model version (fail-absent). */
function current({ deps = {}, nowMs = Date.now(), staleMs = STALE_MS } = {}) {
  try {
    const cur = JSON.parse(_db(deps).getMeta(STATE_KEY) || 'null');
    if (!cur || cur.mv !== MODEL_VERSION || !cur.at) return null;
    if (nowMs - cur.at > staleMs) return null;
    return cur;
  } catch { return null; }
}

// ── Slice 1: mood renders FROM the vector ───────────────────────────────────────────────────────
// One compact line of MEASURED readings (with provenance) for mood.compose's prompt — the mood is
// grounded in instruments, not free-composed. null when the vector is absent (prompt unchanged).
function _driveWord(name, v) {
  if (v == null) return null;
  const band = v >= 0.7 ? 'high' : v >= 0.4 ? 'moderate' : 'low';
  const gloss = { curiosity: 'novelty-starvation', social: 'time-alone', energy: 'spend/exhaustion', progress: 'stall-pressure' }[name] || name;
  return `${gloss} ${band} (${v})`;
}
function readingsLine({ deps = {}, nowMs = Date.now() } = {}) {
  const cur = current({ deps, nowMs });
  if (!cur) return null;
  const parts = [];
  for (const k of ['curiosity', 'social', 'energy', 'progress']) {
    const w = _driveWord(k, cur.drives ? cur.drives[k] : null);
    if (w) parts.push(w);
  }
  if (cur.vad) {
    const v = cur.vad.v, a = cur.vad.a;
    const tone = v >= 0.62 ? 'bright' : v <= 0.48 ? 'dimmed' : 'even';
    const energy = a >= 0.55 ? 'keyed-up' : a <= 0.35 ? 'settled' : 'steady';
    parts.push(`affect ${tone}/${energy} (v${v} a${a}${cur.prov && cur.prov.vad ? ` — ${cur.prov.vad}` : ''})`);
  }
  if (!parts.length) return null;
  const ageMin = Math.round((nowMs - cur.at) / 60000);
  return `${parts.join('; ')} — measured ${ageMin}m ago`;
}

// ── Slice 2: the idle tick consults drive pressure — BUDGET AND CADENCE ONLY ────────────────────
// tickWeights(state) → { neutral, exploreGateMult, graphMovesDelta, note }. PURE. The monologue
// tick multiplies its exploration-slot gates (interest-spawn, self-explore) and adjusts the
// graph-walk burst by these. Reachability, guards, and the tier leash are untouched: a starving
// drive can spend the tick differently, never open a door.
function tickWeights(state) {
  const neutral = { neutral: true, exploreGateMult: 1, graphMovesDelta: 0, note: '' };
  if (!state || !state.drives) return neutral;
  const d = state.drives;
  let mult = 1, delta = 0;
  const why = [];
  if (d.curiosity != null && d.curiosity >= 0.7) { mult *= 0.5; delta += 1; why.push(`curiosity ${d.curiosity} starved → explore sooner, walk further`); }
  if (d.energy != null && d.energy >= 0.8) { mult *= 1.75; delta -= 1; why.push(`energy ${d.energy} exhausted → cheaper ticks`); }
  if (d.progress != null && d.progress >= 0.75) { delta += 1; why.push(`progress ${d.progress} stalled → knowledge motion`); }
  mult = Math.max(0.5, Math.min(2, mult));
  delta = Math.max(-1, Math.min(2, delta));
  if (mult === 1 && delta === 0) return neutral;
  return { neutral: false, exploreGateMult: mult, graphMovesDelta: delta, note: why.join('; ') };
}

module.exports = {
  tick, journal, current, readingsLine, tickWeights, curiosityReading, socialReading, energyReading,
  progressReading, decayVad, appraiseEvents, STATE_KEY, JOURNAL_KEY, JOURNAL_CAP, VAD_BASELINE,
  VAD_HALF_LIFE_MS, VAD_MAX_DEV, MODEL_VERSION, STALE_MS,
};
