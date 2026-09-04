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
// THE TIER SPLIT (usage law, Lucas 2026-09-03 — "she's still firing on validate elected officials state by
// state when there is very incomplete work outstanding"). Two flags, one meaning each:
//   directed  = HIS WORD. A focus born from a user directive (or a thread of his a beat adopted). It gets
//               displacement, the directed spend tier (floor-gated, never paced), his-order cadence.
//   expansion = the program's own roster/topic sweep (a beat-minted focus). It shares the DRIVEN mechanics
//               (the overnight caps below, the directed driver) but NEVER the priority: research tier,
//               idle-gated passes, and it yields whenever directed or user work is outstanding.
// Before the split a beat-minted focus rode setFromDirective and carried directed:true, so every "is his
// work running?" test in the program said yes to the sweep. Measured 09-03: 88 beat-tagged threads had
// also been laundered to origin=user by the scheduler's resume path (setCurrent defaulted the stamp), so
// a RESUMED sweep even passed the idle gate as his work. Origin is now DERIVED from durable stamps
// (_resolveOrigin) and the tier from origin — a caller cannot mint a directed focus for the sweep.
const FOCUS_STATE_KEY = 'focus_state';     // meta JSON: { id, ticks, strikes, startedTs, directed, expansion }
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

// Promote an existing open_thread to the current focus. opts.directed asks for the DRIVEN mechanics
// (overnight caps + the directed-focus driver in main.js rather than the monologue); whether the focus
// is DIRECTED (his word) or EXPANSION (the sweep) is decided by its ORIGIN, never by the caller's flag.
function setCurrent(threadId, { directed = false, origin = null } = {}) {
  const t = db.getOpenThread(threadId);
  if (!t) return null;
  const o = _resolveOrigin(threadId, origin, t);
  const expansion = o === 'beat' || o === 'subc';   // the sweep, or her own subconscious-born investigation
  db.setMeta(CURRENT_KEY, String(threadId));
  _saveState({ id: threadId, ticks: 0, strikes: 0, startedTs: Date.now(), directed: !!directed && !expansion, expansion });
  // WHO seeded this focus — 'user' (a real directive), 'beat' (the autonomic scheduler), 'self' (a
  // musing) — persisted per id. Rewritten on every re-point from the derived value, so a laundered
  // stamp heals the next time the scheduler resumes the thread.
  try { db.setMeta(`focus.${threadId}.origin`, o); } catch {}
  db.touchOpenThread(threadId);  // pending → active
  try { blackboard.append({ source: 'monologue', kind: 'focus_set', focusId: threadId, content: t.content }); } catch {}
  return db.getOpenThread(threadId);
}

// The origin of a focus, from its DURABLE stamps. An explicit origin from the caller wins (seedBeatRun says
// 'beat'; the boot resume says 'user'). Otherwise: a beat-tagged thread (focus.<id>.beat, set on every
// sweep thread at seed time) is 'beat' UNLESS it was born from his own turn — that is a thread the beat
// ADOPTED ("compile leadership for all Louisiana parishes"), which stays his word. An untagged thread keeps
// its prior stamp, else 'user'. This is what stops the RESUME path from turning the sweep into his work:
// setCurrent(thread, {directed:true}) with no origin used to stamp 'user' on a beat thread.
function _resolveOrigin(threadId, origin, thread) {
  if (origin) return String(origin);
  let beatTag = '', prior = '';
  try { beatTag = (db.getMeta(`focus.${threadId}.beat`) || '').trim(); } catch {}
  try { prior = db.getMeta(`focus.${threadId}.origin`) || ''; } catch {}
  if (beatTag) return _bornFromUser(thread || db.getOpenThread(threadId)) ? 'user' : 'beat';
  // SELF-DIRECTED LINEAGE (cut 20) outranks a prior stamp: a laundered 'user' on a thread her own
  // subconscious spawned heals here, the way a laundered beat thread does above.
  const self = selfLineage(threadId);
  if (self && !_bornFromUser(thread || db.getOpenThread(threadId))) return self;
  return prior || 'user';
}
// SELF-DIRECTED LINEAGE (cut 20, 2026-09-03): a thread the subconscious spawned from its own synthesis
// (thread.<id>.spawned_from = 'subc', lib/monologue) was born from no turn of his. Measured 09-03: 41 such
// threads, 39 stamped origin=user — the user-work driver saw "pending, never driven" and seeded each as
// "HIS research thread" at user cadence (#4210, "Investigate: Determine whether the `database is locked`
// errors are transient…", a tension the subconscious read out of the engine's own log). A self-spawned
// thread is EXPANSION: her own investigation, the driven mechanics, none of the priority — it yields to
// his outstanding work and runs idle-gated. A thread spawned FROM another thread (spawned_from = '<id>',
// run-closure's children) inherits its parent's lineage, so a child of his ask stays his word and a child
// of her own stays hers. Returns 'subc' | 'beat' | null (null = his, or no lineage). Fail-closed on an
// unreadable stamp: no lineage claimed.
function selfLineage(threadId, depth = 0) {
  if (depth > 6) return null;
  let sf = '';
  try { sf = String(db.getMeta(`thread.${threadId}.spawned_from`) || '').trim(); } catch { return null; }
  if (!sf) return null;
  if (sf === 'subc') return 'subc';
  const pid = parseInt(sf, 10);
  if (!pid || pid === threadId) return null;
  const up = selfLineage(pid, depth + 1);
  if (up) return up;
  let porigin = '';
  try { porigin = db.getMeta(`focus.${pid}.origin`) || ''; } catch {}
  if (porigin === 'beat' || porigin === 'subc') return porigin;
  try { if ((db.getMeta(`focus.${pid}.beat`) || '').trim()) return 'beat'; } catch {}
  return null;
}
function isSelfSpawned(threadId) { return selfLineage(threadId) != null; }
// Was this thread minted from one of HIS turns? (source_turn_id → a 'user' speaker row.) Fail-closed: an
// unreadable lineage is not his — a beat thread must never be promoted by an error.
function _bornFromUser(thread) {
  try {
    const sid = thread && thread.source_turn_id;
    if (!sid) return false;
    const row = db.getDb().prepare('SELECT speaker FROM turns WHERE id = ?').get(sid);
    return !!(row && row.speaker === 'user');
  } catch { return false; }
}
function _beatTagged(focusId) { try { return !!(db.getMeta(`focus.${focusId}.beat`) || '').trim(); } catch { return false; } }

// WHO seeded a focus — 'user' (a real directive), 'beat' (the autonomic scheduler), or 'self' (a
// musing). Persisted per focus id by setCurrent. Defaults to 'user' for any unmarked/legacy focus, so
// a consumer (the canvas gate) only ever treats an EXPLICITLY autonomic 'beat' run specially, never a
// real request. Takes a focus id (or a focus object). NB: this is the STAMP; the tier tests below
// (isDirected / isExpansion) are what the driver, the scheduler, and the pass gate must key on.
function originOf(focusOrId) {
  const id = (focusOrId && typeof focusOrId === 'object') ? focusOrId.id : focusOrId;
  if (id == null) return 'user';
  try { return db.getMeta(`focus.${id}.origin`) || 'user'; } catch { return 'user'; }
}

function _stateFor(focus) {
  if (!focus) return null;
  const s = _loadState();
  return (s && s.id === focus.id) ? s : null;
}
// Is the currently-served focus the program's own sweep (a beat-minted EXPANSION focus)? A state written
// before the split (no `expansion` field — the boot that carries this change) falls back to the durable
// stamps: beat-tagged and not born from his turn ⇒ expansion.
function isExpansion(focus) {
  const s = _stateFor(focus);
  if (!s) return false;
  if (s.expansion != null) return !!s.expansion;
  return (_beatTagged(focus.id) || !!selfLineage(focus.id)) && !_bornFromUser(db.getOpenThread(focus.id));
}
// Is the currently-served focus HIS WORD (a Lucas-assigned, directed task)? True only while that focus
// is the active pointer — and NEVER for an expansion focus, whatever flag it was pointed with.
function isDirected(focus) {
  const s = _stateFor(focus);
  return !!(s && s.directed && !isExpansion(focus));
}
// Is the currently-served focus DRIVEN by the directed driver at all (directed OR expansion)? The
// mechanics sites (the driver tick, the caps, the scheduler's adoption, the domain leash) key on this;
// every "is his work running?" site keys on isDirected.
function isDriven(focus) { return isDirected(focus) || isExpansion(focus); }

// DIRECTED-STOP predicate (D-stop + D-bleed, 2026-08-16 drill) — extracted PURE so the fire/no-fire edges
// are gate-testable. Returns true iff the message is a genuine "stop the standing task" command AND the
// current focus is NOT an autonomic beat sweep (hasBeat). Three-tier stop-object: STRONG task-nouns
// (task/project/research/focus/working) fire freely; the self-contained "enough" family fires freely (old
// code caught a long "that's enough of the deep dive" via the bare "that" — don't regress); bare pronouns
// (it/this/that) fire ONLY when RIGHT AFTER the stop-verb in a short (≤6-word) imperative — a pronoun
// buried in a long directed task ("forget FEC … fix it and run it again", T7: 100+ words) is NOT a stop.
// hasBeat gates out autonomic beat rotations (focus.<id>.beat set on every current beat focus, fresh AND
// adopted) that must never be narrated to Lucas as a user-facing "you stopped that task, it's saved".
const _STOP_VERB = /\b(stop|drop|cancel|forget|abandon|pause|quit|never ?mind|that'?s enough|enough (?:for now|of that))\b/i;
const _STOP_ENOUGH = /\b(that'?s enough|enough (?:for now|of that))\b/i;
const _STOP_STRONG = /\b(task|project|research|focus|working)\b/i;
const _STOP_PRONOUN_ADJ = /\b(?:stop|drop|cancel|forget|abandon|pause|quit|never ?mind)\s+(?:it|this|that)\b/i;
function isDirectedStop(userMessage, { hasBeat = false } = {}) {
  if (hasBeat) return false;                       // an autonomic beat sweep is never a user stop (D-bleed)
  const s = String(userMessage || '');
  if (!_STOP_VERB.test(s)) return false;
  const words = s.trim().split(/\s+/).length;
  return _STOP_STRONG.test(s) || _STOP_ENOUGH.test(s) || (words <= 6 && _STOP_PRONOUN_ADJ.test(s));
}

// Create a DIRECTED focus straight from a user instruction (the chat entry-point the focus system
// was missing). Unlike setFromText this does NOT require an explicit <focus> tag and does NOT honor
// the 24h refractory — Lucas explicitly assigned it, so his word overrides the anti-thrash gate. A
// directed assignment DISPLACES a self-spawned musing focus (user priority > her own wandering), but
// is idempotent against an already-active directed focus on a near-identical goal (a follow-up like
// "start now" must not spawn a duplicate). Returns { focus, goal } or null.
// origin: 'user' for a real directive. The legacy { origin: 'beat' } option routes to setExpansion — a
// beat can no longer mint a directed focus through this door.
async function setFromDirective(goal, sourceTurnId = null, { origin = 'user' } = {}) {
  if (origin === 'beat') return setExpansion(goal);
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
      // user task outranks the sweep (expansion yields to his word) and a self-spawned musing alike
      clear(isExpansion(active) ? 'displaced-by-directive (expansion yields)' : 'displaced-by-directive');
    }
  }
  const row = db.insertOpenThread({ content: g, sourceTurnId });
  const focus = setCurrent(row.id, { directed: true, origin });
  console.log(`[focus] DIRECTED set from ${origin} → #${row.id}: ${g.slice(0, 80)}`);
  return { focus, goal: g };
}

// Mint the program's OWN sweep focus (a beat's roster walk) as the primary — EXPANSION, never directed.
// Same driven mechanics as a directive (overnight caps, the directed driver), none of the priority:
//   • it YIELDS to a directed focus outright (returns null — his work keeps the slot; the beat retries
//     on a later scheduler tick), instead of superseding it the way a new directive does;
//   • it displaces only another expansion focus or a musing;
//   • it never honors sourceTurnId — a beat has no turn of his to claim.
// Returns { focus, goal } or null.
async function setExpansion(goal) {
  const g = String(goal || '').trim();
  if (g.length < 6) return null;
  const active = getCurrent();
  if (active) {
    if (isDirected(active)) { console.log(`[focus] expansion NOT set — his directed focus #${active.id} holds the slot`); return null; }
    clear(isExpansion(active) ? 'displaced-by-beat-seed' : 'displaced-by-beat-seed (musing)');
  }
  const row = db.insertOpenThread({ content: g });
  const focus = setCurrent(row.id, { directed: true, origin: 'beat' });   // directed:true = the DRIVEN mechanics; origin decides the tier
  console.log(`[focus] EXPANSION set from beat → #${row.id}: ${g.slice(0, 80)}`);
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

  // hard caps — overnight-scale for a DRIVEN focus (his directed task or the sweep's expansion focus —
  // both are bounded roster walks that need hours), tight for a self-spawned musing
  const driven = !!(state.directed || state.expansion);
  const maxWall = driven ? MAX_WALLCLOCK_MS_DIRECTED : MAX_WALLCLOCK_MS;
  const maxTicks = driven ? MAX_TICKS_DIRECTED : MAX_TICKS;
  const maxStrikes = driven ? MAX_STRIKES_DIRECTED : MAX_STRIKES;
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

// --- BACKGROUND RESEARCH WORKERS (parallelism) --------------------------------
// A background worker is a SECOND (third, …) directed research focus that runs CONCURRENTLY with the primary
// one. Crucially it never touches CURRENT_KEY or FOCUS_STATE_KEY — chat / the domain leash / surfacing keep
// seeing ONLY the primary focus (getCurrent), so the conversational plumbing is completely unaffected. Each
// worker's per-run caps live in its OWN per-id `bgstate`, so N workers can never corrupt each other's counters.
const _bgKey = (id) => `focus.${id}.bgstate`;
function _loadBg(id) { try { const r = db.getMeta(_bgKey(id)); return r ? JSON.parse(r) : null; } catch { return null; } }
function _saveBg(id, s) { try { db.setMeta(_bgKey(id), JSON.stringify(s)); } catch {} }

// Promote an open_thread to a background worker (pending→active), init its bgstate. Returns the thread.
function setBackground(threadId) {
  const t = db.getOpenThread(threadId);
  if (!t) return null;
  _saveBg(threadId, { id: threadId, ticks: 0, strikes: 0, startedTs: Date.now(), directed: true, background: true });
  db.touchOpenThread(threadId);
  try { blackboard.append({ source: 'monologue', kind: 'focus_set', focusId: threadId, content: t.content }); } catch {}
  return db.getOpenThread(threadId);
}

// recordOutcome for a background worker — mirrors recordOutcome (same overnight-directed caps + stuck/strike
// teeth) but on its own bgstate, and on close it tombstones + marks the thread WITHOUT clearing the primary
// CURRENT_KEY pointer (a bg close must never yank the focus out from under chat).
function recordOutcomeBackground(focus, { progressed = false, control = null } = {}) {
  const cur = db.getOpenThread(focus.id);
  if (!cur || !['pending', 'active'].includes(cur.status)) return { action: cur ? cur.status : 'gone', reason: 'already closed' };
  const state = _loadBg(focus.id) || { id: focus.id, ticks: 0, strikes: 0, startedTs: Date.now(), directed: true, background: true };
  state.ticks += 1;
  state.strikes = progressed ? 0 : state.strikes + 1;
  db.touchOpenThread(focus.id);
  const closeBg = (status, reason) => {
    try { db.markOpenThreadStatus(focus.id, status, { reason }); } catch {}
    try { db.setMeta(_bgKey(focus.id), ''); } catch {}
    try { blackboard.append({ source: 'monologue', kind: 'focus_resolve', focusId: focus.id, content: `${status}: ${reason}` }); } catch {}
    try { memoryLib.store({ kind: 'note', content: `Focus "${focus.content}" → ${status}: ${reason}`, source: 'focus_tombstone', importance: status === 'resolved' ? 0.8 : 0.5, embedText: focus.content }).catch(() => {}); } catch {}
    console.log(`[focus:bg] #${focus.id} ${status} — ${reason}`);
    return { action: status, reason };
  };
  if (control && control.type === 'done') return closeBg('resolved', control.note || 'completed');
  if (control && control.type === 'stalled') { try { require('./gaps').recordOne(focus.content, control.reason || null, 'focus-stalled'); } catch {} return closeBg('stalled', control.reason || 'model stalled'); }
  const st = stuck.check({ focusId: focus.id });
  if (st.stuck) return closeBg('stalled', `stuck:${st.scenario}`);
  if (Date.now() - state.startedTs > MAX_WALLCLOCK_MS_DIRECTED) return closeBg('stalled', 'wall-clock cap');
  if (state.ticks >= MAX_TICKS_DIRECTED) return closeBg('stalled', 'tick cap');
  if (state.strikes >= MAX_STRIKES_DIRECTED) return closeBg('stalled', 'no-progress strikes');
  _saveBg(focus.id, state);
  return { action: 'continue', reason: progressed ? 'progressed' : `strike ${state.strikes}/${MAX_STRIKES_DIRECTED}` };
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
  // B2. interrogative filler — inquiry QUESTIONS feed the leash (2026-07-23), and "What/Which/Whose…
  // currently holds…" phrasing would otherwise become pass-tokens present in nearly any English doc
  'what', 'which', 'when', 'where', 'whose', 'currently', 'holds', 'other', 'against',
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
    if (f && isDriven(f)) {   // the DRIVEN focus defines the domain — his task or the sweep's current state alike
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
    // OPEN-INQUIRY vocab joins the leash in BOTH branches (2026-07-23, boot69 doc #8443): an active
    // inquiry is standing assigned work with the same rank as a directed focus. The live failure: the
    // directed focus was Alaska municipalities, so the leash was pure Alaska vocab — and dl-ingest
    // quarantined the Louisiana SoS roster that inquiry #1's next_step was explicitly waiting on. Two
    // assigned lanes, one blind to the other. This is NOT the 2026-07-13 self-thread feedback loop
    // reopening: inquiries are a small capped set (over-cap parks the stalest), surfaced by name in the
    // manifest — nothing like the unbounded self-spawned thread pool that let wandering seed the filter.
    const toks = new Set();
    for (const w of (blob.toLowerCase().match(/[a-z]{4,}/g) || [])) _addToken(toks, w);
    try { const iv = inquiryVocabTokens(); if (iv) for (const t of iv) toks.add(t); } catch {}
    return toks.size ? toks : null;
  } catch { return null; }
}

// The open-inquiry vocabulary as its own set, through the SAME stop/stem pipeline as the leash — one
// definition, so a consumer (dl-ingest leash, decompose-sweep inquiry pull) can never drift from it.
// QUESTION only — next_step/open_leads are HOW-vocab ("search", "download", "excel", "google"…),
// measured live to add ~30 generic operational words that turn a filter into a rubber stamp.
function inquiryVocabTokens() {
  try {
    let blob = '';
    for (const q of (require('./inquiry').listActive() || [])) blob += ' ' + (q.question || '');
    if (!blob.trim()) return null;
    const toks = new Set();
    for (const w of (blob.toLowerCase().match(/[a-z]{4,}/g) || [])) _addToken(toks, w);
    return toks.size ? toks : null;
  } catch { return null; }
}

module.exports = {
  getCurrent, isActive, setCurrent, isDirected, isExpansion, isDriven, isDirectedStop, originOf, selfLineage, isSelfSpawned, setFromDirective, setExpansion, clear,
  setFromText, recentlyTombstoned, stripControlTags, parseControlTags,
  isNovel, recordOutcome, domainLeashTokens, inquiryVocabTokens,
  setBackground, recordOutcomeBackground,
  MAX_TICKS, MAX_STRIKES, MAX_WALLCLOCK_MS,
  MAX_TICKS_DIRECTED, MAX_STRIKES_DIRECTED, MAX_WALLCLOCK_MS_DIRECTED,
  REFRACTORY_MS, SIM_THRESHOLD
};
