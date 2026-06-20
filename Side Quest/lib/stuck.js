/**
 * StuckDetector — a pure, deterministic, NO-LLM guard against idle-loop spirals.
 *
 * Ported from OpenHands' controller/stuck.py (tag 0.39.0). The small-model
 * literature is explicit that a ~24B agent left to run an idle loop WILL repeat
 * itself ("same action, same args, 3+ consecutive turns = stuck") unless the
 * scaffolding forbids it. This is that scaffolding: it reads the blackboard and
 * pattern-matches recent events for repetition. No model call, so it can run
 * every tick for free.
 *
 * It operates over the blackboard's "interactive slice" — events since the last
 * user message — so a fresh instruction always resets the detector and is never
 * read as part of a spiral. When a focusId is given it scopes to that focus's own
 * working set instead.
 *
 * Event-kind mapping (Side Quest → OpenHands):
 *   thought / utterance      → MessageAction (the agent "talking", to self or user)
 *   reading / observation    → Observation (a result from the world)
 *   action / focus_advance   → Action (the agent "doing")
 *
 * Three scenarios are ported (2 and 5 were Jupyter/context-window specific):
 *   1. action+observation repeat — last 4 actions identical AND last 4 obs identical
 *   3. monologue loop           — last 3 contiguous messages identical, none acted on
 *   4. alternating oscillation  — A,B,A,B,A,B over the last 6 message/action events
 * Scenario 3 is the one that matches Side Quest's real pain (a thought repeating
 * forever), so it's checked first.
 */

const db = require('./db');

const MSG_KINDS = new Set(['thought', 'utterance']);
const OBS_KINDS = new Set(['reading', 'observation']);
const ACT_KINDS = new Set(['action', 'focus_advance']);

// Keep only signal-bearing events, oldest→newest: drop user messages (they're the
// reset boundary, already excluded by the slice) and anything with no signature
// (blank/trivial — a string of empty thoughts is not a "loop" worth breaking).
function _filter(events) {
  return (events || []).filter(e => e && e.source !== 'user' && e.signature);
}

function _allEqual(arr) {
  return arr.length > 0 && arr.every(x => x.signature === arr[0].signature);
}

// Last n events of the given kinds, newest-first.
function _lastN(events, kinds, n) {
  const out = [];
  for (let i = events.length - 1; i >= 0 && out.length < n; i--) {
    if (kinds.has(events[i].kind)) out.push(events[i]);
  }
  return out;
}

// Trailing run of CONTIGUOUS message-like events (stops at the first observation
// or action). newest-first. This enforces OpenHands' "no observation between
// them" condition for the monologue scenario for free.
function _trailingMessages(events) {
  const out = [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (MSG_KINDS.has(events[i].kind)) out.push(events[i]);
    else break;
  }
  return out;
}

// Scenario 3 — the monologue loop: 3+ identical thoughts/utterances in a row with
// nothing acted on between them. (OpenHands: 3 identical MessageActions, no Obs.)
function _stuckMonologue(events) {
  const msgs = _trailingMessages(events);
  if (msgs.length < 3) return false;
  return _allEqual(msgs.slice(0, 3));
}

// Scenario 1 — repeating action+observation: last 4 actions identical AND last 4
// observations identical (the agent re-runs the same thing, gets the same result).
function _stuckActionObsRepeat(events) {
  const acts = _lastN(events, ACT_KINDS, 4);
  const obs = _lastN(events, OBS_KINDS, 4);
  if (acts.length < 4 || obs.length < 4) return false;
  return _allEqual(acts) && _allEqual(obs);
}

// Scenario 4 — alternating oscillation: over the last 6 message/action events the
// pattern is A,B,A,B,A,B (with A≠B). Catches "try X, try Y, X, Y, X, Y" thrash
// that scenario 1/3 (which need straight repeats) miss.
function _stuckAlternating(events) {
  const seq = events.filter(e => MSG_KINDS.has(e.kind) || ACT_KINDS.has(e.kind)).slice(-6);
  if (seq.length < 6) return false;
  const s = seq.map(e => e.signature);
  return s[0] === s[2] && s[2] === s[4] &&
         s[1] === s[3] && s[3] === s[5] &&
         s[0] !== s[1];
}

/**
 * Check whether the agent is stuck.
 *   opts.focusId — scope to one focus's working set (Phase B). Default: the
 *                  interactive slice (events since the last user message).
 *   opts.limit   — how many trailing events to consider (default 40).
 * Returns { stuck: bool, scenario?, reason? }.
 */
function check({ focusId = null, limit = 40 } = {}) {
  let events = focusId != null
    ? db.getAgentEventsForFocus(focusId, limit)
    : db.getAgentEventsSinceLastUser(limit);
  events = _filter(events);
  if (events.length < 3) return { stuck: false };

  if (_stuckMonologue(events)) {
    return { stuck: true, scenario: 'monologue-repeat', reason: '3+ identical thoughts with nothing acted on between them' };
  }
  if (_stuckActionObsRepeat(events)) {
    return { stuck: true, scenario: 'action-observation-repeat', reason: '4 identical action+observation pairs' };
  }
  if (_stuckAlternating(events)) {
    return { stuck: true, scenario: 'alternating', reason: 'A,B,A,B,A,B oscillation over the last 6 steps' };
  }
  return { stuck: false };
}

module.exports = { check };
