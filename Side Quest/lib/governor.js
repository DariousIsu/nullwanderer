/**
 * Cadence governor — evens out Zoe's AUTONOMOUS activity so it doesn't come in
 * bursts (three things at once) or long dead patches. All the idle loops
 * (monologue, heartbeat) route their would-be actions through here.
 *
 * Three levers:
 *   • MIN GAP   — no two paced actions closer than minGap (anti-burst). Within a
 *                 single tick this also means roughly one action per tick, not four.
 *   • BUDGET    — a rolling-hour weighted cap (token-bucket). Thoughts are cheap,
 *                 utterances/tools cost more, emails/DMs most. Runaway-proofs the
 *                 autonomous channels without touching her judgement on any one act.
 *   • GAP-FILL  — when she's been quiet past quietFill, shouldFillGap() goes true;
 *                 the monologue then relaxes its similarity/silence drop-filters so
 *                 SOMETHING surfaces and the silence gets filled.
 *
 * Bypass: user-driven chat never routes through here, and callers can pass
 * {priority:true} for things that must fire regardless (a due reminder, an
 * inbound chat-bot reply).
 *
 * Tunable via .env (GOVERNOR_*); sane defaults otherwise.
 */

const config = require('./config');

const ACTIONS_PER_HOUR = config.getInt('GOVERNOR_ACTIONS_PER_HOUR', 50);
const MIN_GAP_MS = config.getInt('GOVERNOR_MIN_GAP_SEC', 25) * 1000;
const QUIET_FILL_MS = config.getInt('GOVERNOR_QUIET_FILL_SEC', 240) * 1000;
const WINDOW_MS = 60 * 60 * 1000;

// Weighted cost per action kind (consumed from the hourly budget).
const WEIGHTS = { thought: 1, subconscious: 1, utterance: 2, tool: 2, email: 3, dm: 3, default: 1 };

let actionLog = [];   // [{ ts, kind, weight }]
let lastActionTs = 0;

function weightOf(kind) { return WEIGHTS[kind] != null ? WEIGHTS[kind] : WEIGHTS.default; }

function prune(now) {
  const cutoff = now - WINDOW_MS;
  while (actionLog.length && actionLog[0].ts < cutoff) actionLog.shift();
}

function spentInWindow(now) {
  prune(now);
  let s = 0;
  for (const a of actionLog) s += a.weight;
  return s;
}

// Ask whether a paced action may fire now. Does NOT consume budget — call
// record() after the action actually happens.
function requestAction(kind = 'default', { priority = false } = {}) {
  const now = Date.now();
  if (priority) return { allow: true, reason: 'priority' };
  if (now - lastActionTs < MIN_GAP_MS) {
    return { allow: false, reason: 'min-gap' };
  }
  const weight = weightOf(kind);
  if (spentInWindow(now) + weight > ACTIONS_PER_HOUR) {
    return { allow: false, reason: 'hourly-budget' };
  }
  return { allow: true, reason: 'ok' };
}

function record(kind = 'default') {
  const now = Date.now();
  actionLog.push({ ts: now, kind, weight: weightOf(kind) });
  lastActionTs = now;
}

// True when it's been quiet long enough that the monologue should lower its bar
// and surface something to fill the gap.
function shouldFillGap() {
  return (Date.now() - lastActionTs) > QUIET_FILL_MS;
}

function snapshot() {
  const now = Date.now();
  return {
    spent: spentInWindow(now),
    capacity: ACTIONS_PER_HOUR,
    lastActionAgoSec: lastActionTs ? Math.round((now - lastActionTs) / 1000) : null,
    minGapSec: Math.round(MIN_GAP_MS / 1000),
    quietFillSec: Math.round(QUIET_FILL_MS / 1000),
    fillingGap: shouldFillGap()
  };
}

module.exports = {
  requestAction, record, shouldFillGap, snapshot,
  ACTIONS_PER_HOUR, MIN_GAP_MS, QUIET_FILL_MS
};
