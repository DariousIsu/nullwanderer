/**
 * Focus — Side Quest's working memory: ONE intention carried across idle ticks.
 *
 * The continuity gap this closes: a monologue tick used to be a blank slate. She
 * could think "I want to write better emails" and by the next tick the variety
 * guidance had pushed her somewhere else — the intention died at birth. A focus is
 * a short-lived, persistent objective that survives across ticks until it's done,
 * stalled, or displaced. While a focus is active the monologue SERVES it (works the
 * next concrete step) instead of free-associating.
 *
 * Storage: a focus IS an open_threads row (it already has the status lifecycle
 * pending→active→stalled/resolved). The "currently-served" focus is a pointer in
 * meta (current_focus_id); per-run counters (ticks/strikes/startedTs) live in a
 * single meta JSON blob so no schema change is needed.
 *
 * Loop safety (the whole reason this is careful) is layered:
 *   • visibility — each tick is shown the focus's OWN working set (blackboard.
 *     forFocus), so it can't propose a step it already did. Loops come from amnesia.
 *   • strikes   — a tick that produces no NOVEL artifact is a no-progress strike;
 *     MAX_STRIKES in a row → the focus stalls (it does not retry forever).
 *   • hard caps — MAX_TICKS and MAX_WALLCLOCK_MS terminate any focus regardless.
 *   • stuck     — the StuckDetector, scoped to this focus, can abort it on
 *     exact-repeat / oscillation that slips past the strike counter.
 * Borrowed shape: OpenHands' iteration/stuck guards + Hermes' "archive, don't loop".
 *
 * First-cut boundary: a focus drives THINKING and READING only. Real-world actions
 * (email/browser writes) stay gated exactly as they are today; we widen in Phase E.
 */

const db = require('./db');
const blackboard = require('./blackboard');
const stuck = require('./stuck');
const memoryLib = require('./memory');

const MAX_TICKS = 8;                       // a focus gets at most this many ticks
const MAX_STRIKES = 3;                     // consecutive no-progress ticks → stall
const MAX_WALLCLOCK_MS = 10 * 60 * 1000;   // and at most ten minutes of wall-clock
const FOCUS_STATE_KEY = 'focus_state';     // meta JSON: { id, ticks, strikes, startedTs }
const CURRENT_KEY = 'current_focus_id';
const REFRACTORY_MS = 24 * 60 * 60 * 1000; // a just-closed focus can't respawn for 24h
const SIM_THRESHOLD = 0.82;                // semantic similarity that counts as "the same focus"

// --- pointer + per-run state -------------------------------------------------

function _loadState() {
  try { const raw = db.getMeta(FOCUS_STATE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function _saveState(s) { db.setMeta(FOCUS_STATE_KEY, JSON.stringify(s)); }
function _clearState() { try { db.setMeta(FOCUS_STATE_KEY, ''); } catch {} }

// The focus currently being served, or null. Only pending/active threads are
// servable — a stalled/resolved/abandoned pointer is cleared and treated as none.
function getCurrent() {
  const idStr = db.getMeta(CURRENT_KEY);
  if (!idStr) return null;
  const id = parseInt(idStr, 10);
  if (!id) return null;
  const t = db.getOpenThread(id);
  if (!t || !['pending', 'active'].includes(t.status)) { clear('pointer-stale'); return null; }
  return t;
}

function isActive() { return !!getCurrent(); }

// Promote an existing open_thread to the current focus.
function setCurrent(threadId) {
  const t = db.getOpenThread(threadId);
  if (!t) return null;
  db.setMeta(CURRENT_KEY, String(threadId));
  _saveState({ id: threadId, ticks: 0, strikes: 0, startedTs: Date.now() });
  db.touchOpenThread(threadId);  // pending → active
  try { blackboard.append({ source: 'monologue', kind: 'focus_set', focusId: threadId, content: t.content }); } catch {}
  return db.getOpenThread(threadId);
}

function clear(reason = null) {
  try { db.setMeta(CURRENT_KEY, ''); } catch {}
  _clearState();
  if (reason) console.log(`[focus] cleared (${reason})`);
}

// --- self-set from a thought -------------------------------------------------

// A thought can declare an intention with <focus>goal</focus>. Explicit-tag only
// (no fuzzy intent-mining) so focus creation stays controllable and quiet. Returns
// { focus, goal } if one was set, else null. Does not create a second focus if one
// is already active (the active one must resolve/stall first).
async function setFromText(text, sourceTurnId = null) {
  if (!text) return null;
  const m = text.match(/<focus>([\s\S]*?)<\/focus>/i);
  if (!m) return null;
  const goal = m[1].trim();
  if (goal.length < 6) return null;
  if (isActive()) return null;            // one focus at a time
  // SPAWN GATE: refuse to re-open a focus too similar to one that closed in the
  // last 24h. This is the anti-thrash guard — without it an expired focus would be
  // immediately re-proposed from the same recurring thought and never converge.
  const tomb = await recentlyTombstoned(goal);
  if (tomb) {
    console.log(`[focus] suppressed re-spawn — "${goal.slice(0, 60)}" matches a focus closed within 24h`);
    return null;
  }
  const row = db.insertOpenThread({ content: goal, sourceTurnId });
  const focus = setCurrent(row.id);
  console.log(`[focus] set from thought → #${row.id}: ${goal.slice(0, 80)}`);
  return { focus, goal };
}

// Is `goal` too similar to a focus that was tombstoned within the refractory
// window? Cheap text-containment check first (deterministic, offline), then a
// semantic check via bge-small only if any tombstone carries an embedding.
async function recentlyTombstoned(goal) {
  const rows = db.getKnowledgeBySourceSince('focus_tombstone%', Date.now() - REFRACTORY_MS);
  if (!rows || rows.length === 0) return null;
  const gsig = blackboard.signature(goal);
  if (gsig) {
    for (const r of rows) {
      const rsig = blackboard.signature(r.content || '');
      if (rsig && (rsig.includes(gsig) || gsig.includes(rsig))) return r;
    }
  }
  if (rows.some(r => r.embedding)) {
    let qv = null; try { qv = await memoryLib.embed(goal); } catch { qv = null; }
    if (qv) {
      for (const r of rows) {
        if (!r.embedding) continue;
        let v; try { v = JSON.parse(r.embedding); } catch { continue; }
        if (memoryLib.cosine(qv, v) >= SIM_THRESHOLD) return r;
      }
    }
  }
  return null;
}

function stripControlTags(text) {
  return (text || '')
    .replace(/<focus>[\s\S]*?<\/focus>/gi, '')
    .replace(/<focus-done>[\s\S]*?<\/focus-done>/gi, '')
    .replace(/<focus-stalled>[\s\S]*?<\/focus-stalled>/gi, '')
    .trim();
}

// Parse an explicit resolution signal the model emitted this tick.
// <focus-done>note</focus-done> → resolved; <focus-stalled>reason</focus-stalled> → stalled.
function parseControlTags(text) {
  if (!text) return null;
  let m = text.match(/<focus-done>([\s\S]*?)<\/focus-done>/i);
  if (m) return { type: 'done', note: m[1].trim() };
  m = text.match(/<focus-stalled>([\s\S]*?)<\/focus-stalled>/i);
  if (m) return { type: 'stalled', reason: m[1].trim() };
  return null;
}

// --- progress measurement ----------------------------------------------------

// A tick "progressed" only if it produced a NOVEL artifact for this focus — a
// signature not already on the focus's own timeline. Re-stating an existing
// thought is not progress. (signature='' means blank → never novel.)
function isNovel(focusId, signature) {
  if (!signature) return false;
  const events = blackboard.forFocus(focusId, 60);
  for (const e of events) if (e.signature && e.signature === signature) return false;
  return true;
}

// Record the outcome of one focus tick and decide whether the focus continues.
// Returns { action: 'continue'|'resolved'|'stalled', reason }.
//   control — parsed <focus-done>/<focus-stalled> tag (takes precedence).
//   progressed — did this tick produce a novel artifact?
function recordOutcome(focus, { progressed = false, control = null } = {}) {
  // Defensive: never re-open / re-count a focus that's already closed. In the
  // real flow getCurrent() returns null for a non-active thread so this can't be
  // reached, but a guard keeps recordOutcome idempotent after close.
  const cur = db.getOpenThread(focus.id);
  if (!cur || !['pending', 'active'].includes(cur.status)) {
    return { action: cur ? cur.status : 'gone', reason: 'already closed' };
  }
  const state = _loadState() || { id: focus.id, ticks: 0, strikes: 0, startedTs: Date.now() };
  state.ticks += 1;
  state.strikes = progressed ? 0 : state.strikes + 1;
  db.touchOpenThread(focus.id);

  // explicit model signal wins
  if (control && control.type === 'done') return _close(focus, 'resolved', control.note || 'completed');
  if (control && control.type === 'stalled') {
    // She declared the focus blocked — that's a capability gap signal. Log it
    // (deduped) so it can become a proposal on return, then close the focus.
    try { require('./gaps').recordOne(focus.content, control.reason || null, 'focus-stalled'); } catch {}
    return _close(focus, 'stalled', control.reason || 'model stalled');
  }

  // stuck detector (scoped to this focus) — exact-repeat / oscillation teeth
  const st = stuck.check({ focusId: focus.id });
  if (st.stuck) return _close(focus, 'stalled', `stuck:${st.scenario}`);

  // hard caps
  if (Date.now() - state.startedTs > MAX_WALLCLOCK_MS) return _close(focus, 'stalled', 'wall-clock cap');
  if (state.ticks >= MAX_TICKS) return _close(focus, 'stalled', 'tick cap');
  if (state.strikes >= MAX_STRIKES) return _close(focus, 'stalled', 'no-progress strikes');

  _saveState(state);
  return { action: 'continue', reason: progressed ? 'progressed' : `strike ${state.strikes}/${MAX_STRIKES}` };
}

function _close(focus, status, reason) {
  try { db.markOpenThreadStatus(focus.id, status, { reason }); } catch {}
  try { blackboard.append({ source: 'monologue', kind: 'focus_resolve', focusId: focus.id, content: `${status}: ${reason}` }); } catch {}
  // TOMBSTONE: a durable, retrievable note recording the focus and its outcome.
  // It powers the spawn gate (similarity check) AND compounds into the knowledge
  // store — a resolved focus is a higher-importance insight than a stalled one.
  // Fire-and-forget (embedding is async); the spawn gate also has a text fallback.
  try {
    memoryLib.store({
      kind: 'note',
      content: `Focus "${focus.content}" → ${status}: ${reason}`,
      source: 'focus_tombstone',
      importance: status === 'resolved' ? 0.8 : 0.5
    }).catch(e => console.error('[focus] tombstone store failed:', e.message));
  } catch (e) { console.error('[focus] tombstone store threw:', e.message); }
  clear(`${status}:${reason}`);
  console.log(`[focus] #${focus.id} ${status} — ${reason}`);
  return { action: status, reason };
}

module.exports = {
  getCurrent, isActive, setCurrent, clear,
  setFromText, recentlyTombstoned, stripControlTags, parseControlTags,
  isNovel, recordOutcome,
  MAX_TICKS, MAX_STRIKES, MAX_WALLCLOCK_MS, REFRACTORY_MS, SIM_THRESHOLD
};
