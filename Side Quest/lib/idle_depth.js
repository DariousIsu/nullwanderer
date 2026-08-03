/**
 * lib/idle_depth.js — the idle-depth LADDER (anticipatory-subconscious, Slice 1 foundation).
 *
 * Lucas's design (2026-08-03): the warm-keeper heartbeat is a CLOCK. The longer she's been left alone
 * since the last user turn, the deeper the anticipatory work she earns the budget to do. But — the
 * non-negotiable constraint — this ladder gates ONLY the BUDGET/DEPTH of an idle tick, never WHICH data
 * or tools she may touch. The idle reasoner (lib/autonomy) always has her whole state as a manifest and
 * the full tool surface; this just says how far it may go THIS tick. "Meeting-prep", "news-digest",
 * "have-vs-need" are never hardcoded lanes here — they are what the reasoner CHOOSES when, given a deep
 * budget and full visibility, it surveys what's coming vs. what exists. Tier = budget; access = total.
 *
 * PURE: tier(idleMs) → { tier, name, budgetMult, ... }. No I/O, fully unit-testable. Thresholds are
 * overridable from meta so the cadence can be tuned live without a reboot (pass them in from the caller).
 */
'use strict';

// Default tier edges in MINUTES of idle (time since the last user turn). A tick inside T0 is "warm" —
// Lucas is effectively here — and most idle machinery already defers there anyway; the real ladder is
// T1→T3. Deeper tiers earn a larger budget multiplier (scales operator steps / output tokens downstream).
const DEFAULT_TIERS = [
  { tier: 0, name: 'warm',       maxMin: 3,        budgetMult: 0.0, label: 'just chatted — stay responsive, spend nothing' },
  { tier: 1, name: 'hygiene',    maxMin: 15,       budgetMult: 1.0, label: 'light upkeep + shallow survey' },
  { tier: 2, name: 'digest',     maxMin: 45,       budgetMult: 1.6, label: 'reconcile news/threads against active work' },
  { tier: 3, name: 'anticipate', maxMin: Infinity, budgetMult: 2.6, label: 'deep prep — what is coming vs. what we hold' },
];

// Resolve the tier for an idle duration. `edges` (optional) overrides the minute cutoffs [t1,t2,t3];
// anything ≥ the last edge is the deepest tier. Never throws; a bad input → tier 0.
function tier(idleMs, { edges = null, mult = null } = {}) {
  const mins = Number(idleMs) > 0 ? Number(idleMs) / 60000 : 0;
  let tiers = DEFAULT_TIERS;
  if (Array.isArray(edges) && edges.length === 3 && edges.every((e) => Number.isFinite(e) && e > 0)) {
    tiers = [
      { ...DEFAULT_TIERS[0], maxMin: edges[0] },
      { ...DEFAULT_TIERS[1], maxMin: edges[1] },
      { ...DEFAULT_TIERS[2], maxMin: edges[2] },
      { ...DEFAULT_TIERS[3] },
    ];
  }
  if (mult && typeof mult === 'object') tiers = tiers.map((t) => (Number.isFinite(mult[t.tier]) ? { ...t, budgetMult: mult[t.tier] } : t));
  const chosen = tiers.find((t) => mins < t.maxMin) || tiers[tiers.length - 1];
  return { ...chosen, idleMin: Math.round(mins), idleMs: Math.max(0, Number(idleMs) || 0) };
}

// A one-line log tag for a tick: "[idle-depth] tier=2 digest idle=27m budget=×1.6".
function describe(t) {
  if (!t) return '[idle-depth] (none)';
  return `[idle-depth] tier=${t.tier} ${t.name} idle=${t.idleMin}m budget=×${t.budgetMult} — ${t.label}`;
}

// Read tuned edges/mults from a meta getter, if present (all optional). Returns { edges, mult } for tier().
// meta idle_depth.edges = "3,15,45" ; idle_depth.mult = JSON {"1":1,"2":1.6,"3":2.6}.
function optsFromMeta(getMeta) {
  const out = {};
  try {
    const e = String(getMeta && getMeta('idle_depth.edges') || '').trim();
    if (e) { const a = e.split(',').map((x) => parseFloat(x)); if (a.length === 3 && a.every((n) => Number.isFinite(n) && n > 0)) out.edges = a; }
  } catch {}
  try { const m = getMeta && getMeta('idle_depth.mult'); if (m) { const o = JSON.parse(m); if (o && typeof o === 'object') out.mult = o; } } catch {}
  return out;
}

module.exports = { tier, describe, optsFromMeta, DEFAULT_TIERS };
