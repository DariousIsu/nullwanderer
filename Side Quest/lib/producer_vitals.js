'use strict';
/**
 * lib/producer_vitals.js — Wave 1 of the pre-hard-testing scope (docs/PRE_HARD_TESTING_SCOPE_2026-08-18.md):
 * INTEROCEPTION for the machine's ORGANS. The sibling of machine_vitals, one domain over — that one
 * senses hardware (CPU/RAM/disk/GPU); this one senses whether the machine's own PRODUCER LANES are
 * still writing.
 *
 * WHY. The entire outstanding backlog traces to producers that failed SILENTLY: the subconscious
 * synthesis lane went dark ~48 days with NO error thrown, sources stopped fetching ~54 days ago, and
 * nobody noticed until an audit counted the piles. Nothing watched whether a lane that SHOULD keep
 * writing still was. This is that watchdog — the one move that would have caught every silent failure
 * the day it happened instead of two months later.
 *
 * Same doctrine as machine_vitals: zero LLM, deterministic sampling, fail-absent, persist to meta
 * (`producer_vitals`) which lib/status_vector surfaces in her cognition beats, and escalate a STALL
 * through obs_bus (lane 'producer') so self_watch's repair loop gets organ-level senses. Anomalies
 * are rate-limited so a long stall can't renag every tick.
 *
 * BOOT-GRACE: nothing is sampled until the app has been up past a short grace, so a lane that simply
 * hasn't ticked yet this boot is never mistaken for a stall. A genuinely old last-write (from before
 * the reboot) still flags immediately — a 48-day-dark lane is dark whether we just booted or not.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const BOOT_GRACE_MS = 5 * 60e3;          // let post-boot lanes tick once before judging silence
const ANOMALY_COOLDOWN_MS = 6 * HOUR;    // a stall is slow-moving — surface it, don't strobe it

// module state (per-process; a restart re-primes)
const _lastAnomalyAt = {};               // producer name → ts of last emitted anomaly

// The watched producers. Each is a lane that should keep writing; `read(deps)` returns its last-write
// epoch-ms (or null = never/unknown → fail-absent), `maxAgeMs` is how long quiet before it's a stall,
// `note` is the human phrase. LOCAL (sq.db) reads only — Echo-side producers (sources / enrichment /
// passes) are the next increment, added here with an async read at a slow cadence.
function _lastTs(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const last = rows[rows.length - 1];    // getRecentMonologue* return oldest→newest
  const t = last && Number(last.ts);
  return Number.isFinite(t) && t > 0 ? t : null;
}

function defaultProducers(db) {
  return [
    { name: 'synthesis', maxAgeMs: 1 * DAY, note: 'the subconscious synthesis lane (type=synthesis)',
      read: () => _lastTs(db.getRecentMonologueByType('synthesis', 1)) },
    { name: 'subconscious', maxAgeMs: 6 * HOUR, note: 'the idle monologue loop',
      read: () => _lastTs(db.getRecentMonologue(1)) },
  ];
}

/**
 * PURE — fold the raw readings into a stall verdict. Exported for the smoke.
 * @param {Array<{name,lastTs,maxAgeMs,note?}>} readings
 * @param {{nowMs:number, uptimeMs:number, bootGraceMs?:number}} ctx
 * @returns {{skipped:string|null, producers:Array<{name,lastTs,ageMs,maxAgeMs,stalled,reason,note}>}}
 */
function evaluate(readings, { nowMs, uptimeMs, bootGraceMs = BOOT_GRACE_MS } = {}) {
  if (!(uptimeMs >= bootGraceMs)) return { skipped: 'boot-grace', producers: [] };
  const producers = (readings || []).map((r) => {
    const lastTs = (r.lastTs == null) ? null : Number(r.lastTs);
    const ageMs = lastTs == null ? null : Math.max(0, nowMs - lastTs);
    // A non-null but OLD last-write is a stall regardless of uptime (pre-boot silence counts). A null
    // last-write (never written) is only a stall once the app has been up longer than the lane's window
    // — before that we can't tell "new" from "broken".
    const stalled = lastTs == null ? (uptimeMs > r.maxAgeMs) : (ageMs > r.maxAgeMs);
    const reason = !stalled ? null : (lastTs == null ? 'silent' : 'stale');
    return { name: r.name, lastTs, ageMs, maxAgeMs: r.maxAgeMs, stalled, reason, note: r.note || '' };
  });
  return { skipped: null, producers };
}

// Human age like "48d" / "6h" / "12m" — for the anomaly text + the status line.
function humanAge(ms) {
  if (ms == null) return 'never';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function _emitStall(p, { deps = {}, nowMs }) {
  if (nowMs - (_lastAnomalyAt[p.name] || 0) < ANOMALY_COOLDOWN_MS) return;
  _lastAnomalyAt[p.name] = nowMs;
  const age = p.reason === 'silent' ? `nothing since boot` : `last wrote ${humanAge(p.ageMs)} ago`;
  try {
    ((deps.obsBus) || require('./obs_bus')).emit(
      { lane: 'producer', kind: 'stall', level: 'warn',
        text: `The ${p.name} lane has gone quiet — ${age} (${p.note}). A producer that should be writing isn't.`,
        ref: p.name },
      { deps, nowMs }
    );
  } catch {}
}

/**
 * Take one sample: read each producer's last write, judge stalls, emit anomalies (rate-limited),
 * persist to meta `producer_vitals`. Fail-soft. Returns the summary.
 */
function sample({ deps = {}, nowMs = Date.now(), uptimeMs = null } = {}) {
  const db = deps.db || require('./db');
  const up = uptimeMs == null ? (((deps.uptime || (() => process.uptime()))()) * 1000) : uptimeMs;
  const producers = deps.producers || defaultProducers(db);
  // fail-absent: a lane we cannot READ (a db hiccup, a throwing accessor) is UNKNOWN, not stalled —
  // skip it rather than assert a stall we never observed. A clean null (no rows) IS a real signal and
  // still flows through (silent-after-window).
  const readings = [];
  for (const p of producers) {
    let lastTs = null;
    try { lastTs = p.read(deps); } catch { continue; }   // unreadable → skip (unknown, not a stall)
    readings.push({ name: p.name, lastTs, maxAgeMs: p.maxAgeMs, note: p.note });
  }
  const { skipped, producers: judged } = evaluate(readings, { nowMs, uptimeMs: up });
  const out = { at: nowMs, skipped: skipped || undefined, stalledCount: 0, producers: judged };
  if (!skipped) {
    for (const p of judged) if (p.stalled) { out.stalledCount++; _emitStall(p, { deps, nowMs }); }
  }
  try { (db.setMeta)('producer_vitals', JSON.stringify(out)); } catch {}
  return out;
}

// One compact phrase for the status vector's line — ONLY when something is stalled (fail-absent: a
// healthy set of producers adds no noise to her beat). Null when all is well or nothing sampled.
function describe(v) {
  if (!v || !v.at || !Array.isArray(v.producers)) return null;
  const stalled = v.producers.filter((p) => p.stalled);
  if (!stalled.length) return null;
  return `producers quiet: ${stalled.map((p) => `${p.name} ${p.reason === 'silent' ? '(silent)' : humanAge(p.ageMs)}`).join(', ')} ⚠`;
}

module.exports = { sample, evaluate, describe, humanAge, defaultProducers, BOOT_GRACE_MS, ANOMALY_COOLDOWN_MS };
