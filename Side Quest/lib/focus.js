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
// DIRECTED focus = a task Lucas explicitly assigned ("spend the night studying every think tank").
// The tiny self-spawned caps above are wrong for it: he WANTS hours of sustained work. Directed
// focuses get overnight-scale caps (still bounded — loop safety never goes away: strikes/stuck/
// wall-clock all still apply, just sized for a real project instead of a 10-minute musing).
const MAX_TICKS_DIRECTED = 2000;                    // ceiling; a 45s driver cadence ⇒ ~hundreds/night
const MAX_STRIKES_DIRECTED = 12;                    // tolerant of a few hard sub-steps, still bounded
const MAX_WALLCLOCK_MS_DIRECTED = 14 * 60 * 60 * 1000; // ~one night
const FOCUS_STATE_KEY = 'focus_state';     // meta JSON: { id, ticks, strikes, startedTs, directed }
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

// Promote an existing open_thread to the current focus. opts.directed marks it as a Lucas-assigned
// task (overnight caps + driven by the directed-focus driver in main.js rather than the monologue).
function setCurrent(threadId, { directed = false } = {}) {
  const t = db.getOpenThread(threadId);
  if (!t) return null;
  db.setMeta(CURRENT_KEY, String(threadId));
  _saveState({ id: threadId, ticks: 0, strikes: 0, startedTs: Date.now(), directed: !!directed });
  db.touchOpenThread(threadId);  // pending → active
  try { blackboard.append({ source: 'monologue', kind: 'focus_set', focusId: threadId, content: t.content }); } catch {}
  return db.getOpenThread(threadId);
}

// Is the currently-served focus a Lucas-assigned (directed) task? Reads the per-run state, so it's
// true only while that directed focus is the active pointer.
function isDirected(focus) {
  if (!focus) return false;
  const s = _loadState();
  return !!(s && s.id === focus.id && s.directed);
}

// Create a DIRECTED focus straight from a user instruction (the chat entry-point the focus system
// was missing). Unlike setFromText this does NOT require an explicit <focus> tag and does NOT honor
// the 24h refractory — Lucas explicitly assigned it, so his word overrides the anti-thrash gate. A
// directed assignment DISPLACES a self-spawned musing focus (user priority > her own wandering), but
// is idempotent against an already-active directed focus on a near-identical goal (a follow-up like
// "start now" must not spawn a duplicate). Returns { focus, goal } or null.
async function setFromDirective(goal, sourceTurnId = null) {
  const g = String(goal || '').trim();
  if (g.length < 6) return null;
  const active = getCurrent();
  if (active) {
    if (isDirected(active)) {
      // already running a directed task — only keep the SAME one (avoid duplicates on follow-ups)
      const asig = blackboard.signature(active.content || '');
      const gsig = blackboard.signature(g);
      if (asig && gsig && (asig.includes(gsig) || gsig.includes(asig))) { db.touchOpenThread(active.id); return { focus: active, goal: active.content }; }
      // a genuinely different directed task supersedes the old one (user changed the assignment)
      clear('superseded-by-new-directive');
    } else {
      clear('displaced-by-directive');  // user task outranks a self-spawned musing
    }
  }
  const row = db.insertOpenThread({ content: g, sourceTurnId });
  const focus = setCurrent(row.id, { directed: true });
  console.log(`[focus] DIRECTED set from user → #${row.id}: ${g.slice(0, 80)}`);
  return { focus, goal: g };
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
  // S3 (autonomic-architecture): the SCHEDULER owns the research agenda now, so the heartbeat/monologue is
  // DEMOTED to surfacing-only — it no longer self-spawns a musing research focus. That ad-hoc self-set focus
  // was the old fixation driver (it looped one cluster); her standing curiosity is the BEATS instead. Chat
  // (setFromDirective) and the scheduler remain the only focus drivers. Gap-proof (doesn't depend on a beat
  // being active). Kill switch: ZOE_AUTONOMIC=0 restores the pre-autonomic self-directed behavior.
  if (String(process.env.ZOE_AUTONOMIC || '1').trim() !== '0') {
    if (!setFromText._demoteLogged) { console.log('[focus] self-set research focus suppressed — autonomic scheduler owns research (heartbeat = surfacing-only)'); setFromText._demoteLogged = true; }
    return null;
  }
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
// CHRONIC-STALL suppression (D2): a goal tombstoned this many times within this window is demonstrably
// uncompletable/thrashing — e.g. "promote these four records to active status", where KG promotion is
// Echo's async gate with NO tool her focus loop can invoke, so it re-derives after each 24h refractory
// expires and re-stalls forever (the loop Lucas saw her "fighting herself" in). Suppress it indefinitely.
// A user DIRECTIVE (setFromDirective) still bypasses this gate, so Lucas can always deliberately re-assign.
const CHRONIC_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;   // look back a month for repeat offenders
const CHRONIC_STALLS = 2;                              // stalled >= this many times → treat as uncompletable

async function recentlyTombstoned(goal) {
  // Chronic pre-check: count same-goal tombstones over the wide window (cheap text-signature match only —
  // no embedding cost); if it's a repeat offender, suppress indefinitely regardless of the 24h refractory.
  try {
    const wide = db.getKnowledgeBySourceSince('focus_tombstone%', Date.now() - CHRONIC_WINDOW_MS);
    const gsig = blackboard.signature(goal);
    if (wide && wide.length && gsig) {
      let n = 0, first = null;
      for (const r of wide) {
        const rsig = blackboard.signature(r.content || '');
        if (rsig && (rsig.includes(gsig) || gsig.includes(rsig))) { n += 1; first = first || r; }
      }
      if (n >= CHRONIC_STALLS) {
        console.log(`[focus] suppressed CHRONIC re-spawn — "${goal.slice(0, 60)}" has stalled ${n}x within 30d; treating as uncompletable (re-assign via a directive to override)`);
        return first;
      }
    }
  } catch (e) { console.error('[focus] chronic-stall check failed:', e.message); }
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

  // hard caps — overnight-scale for a Lucas-assigned (directed) task, tight for a self-spawned musing
  const maxWall = state.directed ? MAX_WALLCLOCK_MS_DIRECTED : MAX_WALLCLOCK_MS;
  const maxTicks = state.directed ? MAX_TICKS_DIRECTED : MAX_TICKS;
  const maxStrikes = state.directed ? MAX_STRIKES_DIRECTED : MAX_STRIKES;
  if (Date.now() - state.startedTs > maxWall) return _close(focus, 'stalled', 'wall-clock cap');
  if (state.ticks >= maxTicks) return _close(focus, 'stalled', 'tick cap');
  if (state.strikes >= maxStrikes) return _close(focus, 'stalled', 'no-progress strikes');

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
      importance: status === 'resolved' ? 0.8 : 0.5,
      embedText: focus.content   // embed the BARE goal — recentlyTombstoned compares against the bare goal, so the wrapper must not dilute it
    }).catch(e => console.error('[focus] tombstone store failed:', e.message));
  } catch (e) { console.error('[focus] tombstone store threw:', e.message); }
  clear(`${status}:${reason}`);
  console.log(`[focus] #${focus.id} ${status} — ${reason}`);
  return { action: status, reason };
}

// PERSISTENT DOMAIN LEASH (shared by the browse-download + contact leashes). Distinctive lowercased tokens
// of the operator's domain: the ACTIVE directed focus if one is being served, ELSE their STANDING civic
// work (recent open focus threads: "Louisiana parish leadership", "county commissioners"…). This is what
// keeps the autonomous lanes on-domain even after a directed focus STALLS — without it every leash turns
// off and the idle browse wanders (e.g. to a University of Arkansas Medical Sciences faculty page, whose
// PDFs doc-decompose then mints as medical contacts — the recurring "medical spinning"). Returns null only
// when the operator has NO civic work at all → genuinely free exploration. Generic civic words are dropped
// so it keys on distinctive terms (louisiana, parish, orleans, commissioner, jury…).
// Words removed from the leash-token set because they appear in almost every english/project doc and turn
// the leash from a domain filter into a rubber stamp. Two classes: (A) generic project-adjacent vocabulary
// (a medical directory can trivially mention "organization" or "social" or "director" — those aren't useful
// signals); (B) English filler that leaked through the 4+ char length gate (into/that/they/them/etc.).
// Kept: project-DISTINCTIVE terms (louisiana, parish, county, commissioners, roster, jury, parishes) — the
// words that ACTUALLY differentiate on-domain from off-domain. Audit trigger (2026-07-13): a "COVID
// Emergency Dental Providers" CSV and a "ca-dppo dental directory" PDF flowed through the leash unblocked
// because `direct` matched "directory" and `organization`/`social` matched the doc bodies.
const _LEASH_STOP = new Set([
  // A. generic project vocabulary — too common to differentiate
  'council', 'district', 'city', 'board', 'members', 'member', 'office', 'department', 'state', 'elected', 'official', 'officials', 'public', 'general', 'gather', 'profile', 'profiles', 'leadership', 'research', 'information', 'contact', 'contacts', 'compile', 'find', 'work', 'complete', 'inc', 'llc', 'corp', 'company', 'group', 'groups', 'organization', 'organizations', 'staff', 'roles', 'numbers', 'people', 'emails', 'phone',
  // A2. project verbs/adjectives that add no domain signal
  'direct', 'social', 'relevant', 'level', 'priority', 'project', 'monitor', 'match', 'summary', 'task', 'include', 'included', 'identified', 'named', 'higher', 'highest', 'lower', 'lowest', 'across', 'earlier', 'further', 'future', 'full', 'days', 'hour', 'hours', 'depth', 'digging', 'details', 'detail', 'findings', 'restate', 'restated', 'align', 'alignment', 'conduct', 'expand', 'deepen', 'deepens', 'focus', 'focusing', 'build', 'safety', 'prior', 'over', 'several', 'made', 'make', 'keep', 'next', 'just', 'life', 'world',
  // B. English filler (leaked past the 4+ char gate)
  'from', 'with', 'their', 'list', 'that', 'this', 'they', 'them', 'these', 'those', 'than', 'into', 'each', 'your', 'every',
  // proper-noun leaks: people/named entities that show up in every thread but don't gate the domain
  'lucas', 'anthropic', 'linkedin',
]);
// Add a word to the token set, plus a naive plural-stem so "Parishes" (in the focus text) also matches
// "parish" (in a doc) at word-boundary check time — the failure I was working around. Deliberately naive
// (not a full stemmer): -ies→-y, -es→-, -s→-. Never expands, only contracts. Cross-project bleed is
// avoided at the SELECTION step, not here — recent threads and active focus are handled separately.
function _addToken(toks, w) {
  if (_LEASH_STOP.has(w)) return;
  toks.add(w);
  if (w.length > 5) {
    if (w.endsWith('ies')) { const s = w.slice(0, -3) + 'y'; if (!_LEASH_STOP.has(s)) toks.add(s); }
    else if (w.endsWith('es')) { const s = w.slice(0, -2); if (!_LEASH_STOP.has(s)) toks.add(s); }
    else if (w.endsWith('s')) { const s = w.slice(0, -1); if (!_LEASH_STOP.has(s)) toks.add(s); }
  }
}

function domainLeashTokens() {
  try {
    // ISOLATION between projects: when a DIRECTED FOCUS is active, use ONLY that focus's content — recent
    // threads from other projects (Rainey Center, MIRI, Anthropic) would cross-contaminate the vocabulary
    // and let their tokens ("center", "machine", "intelligence") match unrelated off-domain docs. When
    // there's no directed focus, fall back to recent civic threads (the standing project vocab). Plurals
    // are stem-expanded so "Parishes" also matches "parish" — this was the failure that made me try the
    // union in the first place, and the naive stem fixes it without needing the union.
    let blob = '';
    const f = getCurrent();
    if (f && isDirected(f)) {
      blob = String(f.content || '');
      try { blob += ' ' + (db.getMeta(`focus.${f.id}.enrich_facet`) || ''); } catch {}
      try { const cov = JSON.parse(db.getMeta(`focus.${f.id}.covered`) || '[]'); if (Array.isArray(cov)) blob += ' ' + cov.join(' '); } catch {}
    } else {
      // USER-ASSIGNED threads only — NOT recentThreadGoals, which also pulled SELF-GENERATED threads. The
      // 2026-07-13 medical flood (979 dentist targets/15min) was a feedback loop: Zoe wanders onto a medical
      // page → it becomes a self-thread → its vocab enters the leash HERE → dental dirs word-match a lone token
      // → decompose → that read spawns another self-thread → the leash drifts further medical. Keying the leash
      // to what LUCAS actually assigned breaks the loop: her own wandering can never seed the domain it filters.
      // (Verified 2026-07-15: getUserAssignedThreads returns the parish/institute/datacenter vocab, no self-gen.)
      // Filter to still-open (pending/active/stalled) so a resolved assignment drops out of the leash — matches
      // recentThreadGoals' recency filter (getUserAssignedThreads itself has no status filter), and keeps the
      // "no open work → null leash → fresh-install inert" fallback intact.
      try {
        blob = (db.getUserAssignedThreads(40) || [])
          .filter(t => t && ['pending', 'active', 'stalled'].includes(t.status))
          .slice(0, 15)
          .map(t => t.content || '')
          .join(' ');
      } catch {}
    }
    if (!blob.trim()) return null;
    const toks = new Set();
    for (const w of (blob.toLowerCase().match(/[a-z]{4,}/g) || [])) _addToken(toks, w);
    return toks.size ? toks : null;
  } catch { return null; }
}

module.exports = {
  getCurrent, isActive, setCurrent, isDirected, setFromDirective, clear,
  setFromText, recentlyTombstoned, stripControlTags, parseControlTags,
  isNovel, recordOutcome, domainLeashTokens,
  MAX_TICKS, MAX_STRIKES, MAX_WALLCLOCK_MS,
  MAX_TICKS_DIRECTED, MAX_STRIKES_DIRECTED, MAX_WALLCLOCK_MS_DIRECTED,
  REFRACTORY_MS, SIM_THRESHOLD
};
