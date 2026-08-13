'use strict';
/**
 * lib/work_hold.js — the WORK-HOLD control order (2026-08-13, turn #11783).
 *
 * Lucas: "let's put all work projects and tasks on hold until 0630 … and you take this time to go
 * build yourself" — and the reply committed to MORE Applied Digital work, twice, verbatim. The reply
 * writer answered from the mid-flight work roadmap because nothing about the ORDER changed any
 * engine state: there was nothing for the reply to ground in but the roadmap.
 *
 * A hold/resume order is a CONTROL MESSAGE, not conversation. The cure is sequencing: chat:send
 * detects the order and CHANGES STATE FIRST (meta `work_hold_until`), then the reply grounds in the
 * state that now exists. The directed engine seams consult active():
 *   - runDirectedResearchPass (the ONE dispatcher for every directed pass kind) → pass held
 *   - _fillBackgroundWorkers → fleet parked
 *   - _surfaceSteeringNote → work notes stay off chat
 * The free lanes (curiosity, boredom, monologue, memory building) are deliberately NOT gated —
 * "go build yourself" is exactly what those lanes are for.
 *
 * Pure parsing + one meta key; fail-soft everywhere. Detection is conservative: it requires the
 * word "work" inside a hold/pause construction — an over-eager match would park the engine on an
 * innocent sentence, which is worse than missing a phrasing (the directive can be repeated;
 * a phantom hold is invisible).
 */
const db = require('./db');

const KEY = 'work_hold_until';
const DEFAULT_HOLD_MS = 3 * 60 * 60 * 1000;   // no time named → "a few hours" (his live order was ~3h)
const MAX_HOLD_MS = 24 * 60 * 60 * 1000;      // a hold survives at most a day without being renewed

// "put/place (all) (the) work (projects/tasks/projects and tasks) on hold" · "pause/hold/park (all) work"
// · "all work (projects and tasks) on hold" · "work goes on hold"
const HOLD_RE = /\b(?:put|place|putting|placing)\s+(?:all\s+)?(?:the\s+)?work(?:\s+(?:projects?|tasks?)(?:\s+and\s+(?:projects?|tasks?))?)?\s+on\s+hold\b|\b(?:pause|hold|park)\s+(?:all\s+)?(?:the\s+)?work(?:\s+(?:projects?|tasks?))?\b|\ball\s+work(?:\s+(?:projects?|tasks?)(?:\s+and\s+(?:projects?|tasks?))?)?\s+on\s+hold\b/i;

// "resume/restart/unpause (the) work" · "back to work" · "work's back on" · "lift/end the hold"
const RESUME_RE = /\b(?:resume|restart|unpause)\s+(?:all\s+)?(?:the\s+)?work\b|\bback\s+to\s+work\b|\bwork(?:'s| is)?\s+back\s+on\b|\b(?:lift|end)\s+the\s+hold\b/i;

// ── time parsing ─────────────────────────────────────────────────────────────────────────────────
// "until 0630" / "until 6:30" / "until 6(am|pm)" → the NEXT occurrence of that wall-clock time.
// "for 3 hours" / "for 90 minutes" → now + duration. "until morning" → next 08:00.
function parseUntil(text, now = Date.now()) {
  const t = String(text || '');
  let m = t.match(/\bfor\s+(?:the\s+next\s+)?(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b/i);
  if (m) {
    const n = parseFloat(m[1]);
    const ms = /min/i.test(m[2]) ? n * 60000 : n * 3600000;
    return now + Math.min(Math.max(ms, 60000), MAX_HOLD_MS);
  }
  m = t.match(/\buntil\s+(?:about\s+|around\s+)?(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i);
  if (m) {
    let hh = parseInt(m[1], 10);
    let mm = m[2] ? parseInt(m[2], 10) : 0;
    // Military shorthand "0630": the match gives hh=06 mm=30 via the \d{1,2}:?\d{2} branch; a bare
    // 3-4 digit clump like "630" parses as hh=6 mm=30 the same way.
    const ap = (m[3] || '').toLowerCase();
    if (ap.startsWith('p') && hh < 12) hh += 12;
    if (ap.startsWith('a') && hh === 12) hh = 0;
    if (hh > 23 || mm > 59) return now + DEFAULT_HOLD_MS;
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);   // that wall-clock already passed → tomorrow
    return Math.min(d.getTime(), now + MAX_HOLD_MS);
  }
  if (/\buntil\s+(?:the\s+)?morning\b/i.test(t)) {
    const d = new Date(now);
    d.setHours(8, 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return now + DEFAULT_HOLD_MS;
}

// A resume phrase that names a FUTURE time is a DEFERRED resume — i.e. a HOLD until that time.
// Live incident (04:31 ET 08-13): "take the next couple hours to yourself, get back to work
// around 630" RE-CONFIRMED the 06:30 hold, but the bare RESUME_RE match cleared it and the
// engine roared back one minute later. "back to work" only means NOW when no time rides with it.
const RESUME_TIME_RE = /\b(?:back\s+to\s+work|resume|restart)\b[^.!?]{0,40}?\b(?:around|at|by|after)\s+(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i;

// REPORTED-SPEECH GUARD (2026-08-13 ~10:00 live incident): Lucas COMPLAINING about the overnight
// hold — "you were supposed to get back to work on that paper at 0630" / "I said put all work on
// hold until 0630" — re-matched the hold shapes, and "0630" being past rolled the hold to
// TOMORROW: the engine refused the very work he was demanding. A hold/resume ORDER is present
// tense; a sentence that frames the phrase as PAST or QUOTED speech is a reference, never an order.
const REPORTED_RE = /\b(?:was|were)\s+supposed\s+to\b|\bI\s+(?:said|told|asked)\b|\blast\s+night\b|\byesterday\b|\bhours?\s+ago\b|\bthis\s+morning\s+you\b|\bwhy\s+(?:is|are|was|were|didn'?t|haven'?t)\b|\bstill\s+not\s+done\b/i;

/** detect(text) → { hold: true, untilTs } | { resume: true } | null. Resume wins on a tie
 *  ("back to work — lift the hold" must not re-arm); a TIMED resume is a hold until that time;
 *  reported/past speech about a hold is never an order. */
function detect(text, now = Date.now()) {
  const t = String(text || '');
  if (!t.trim()) return null;
  if (REPORTED_RE.test(t)) return null;
  const timed = t.match(RESUME_TIME_RE);
  if (timed) {
    let hh = parseInt(timed[1], 10);
    let mm = timed[2] ? parseInt(timed[2], 10) : 0;
    // "around 630" → the \d{1,2}:?\d{2} split gives hh=6 mm=30; bare "around 6" gives hh=6 mm=0.
    const ap = (timed[3] || '').toLowerCase();
    if (ap.startsWith('p') && hh < 12) hh += 12;
    if (ap.startsWith('a') && hh === 12) hh = 0;
    if (hh <= 23 && mm <= 59) {
      const d = new Date(now);
      d.setHours(hh, mm, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return { hold: true, untilTs: Math.min(d.getTime(), now + MAX_HOLD_MS) };
    }
  }
  if (RESUME_RE.test(t)) return { resume: true };
  if (HOLD_RE.test(t)) return { hold: true, untilTs: parseUntil(t, now) };
  return null;
}

// ── state (one meta key; absent/past = no hold) ──────────────────────────────────────────────────
function set(untilTs) { try { db.setMeta(KEY, String(untilTs)); } catch {} }
function clear() { try { db.setMeta(KEY, ''); } catch {} }
function until() {
  try { const v = parseInt(db.getMeta(KEY) || '0', 10) || 0; return v > Date.now() ? v : 0; } catch { return 0; }
}
function active() { return until() > 0; }
function describe() {
  const v = until();
  if (!v) return 'no hold';
  try { return new Date(v).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }) + ' ET'; }
  catch { return new Date(v).toISOString(); }
}

module.exports = { detect, parseUntil, set, clear, active, until, describe, HOLD_RE, RESUME_RE };
