const db = require('./db');
const { streamChat, TagStreamParser } = require('./ollama');
const { BOOTSTRAP } = require('./context');
const voice = require('./voice');
const importanceLib = require('./importance');

const unpromptedGate = require('./unprompted_gate');   // structural backstops: pending-user-turn + unprompted-streak
const MODEL = require('./config').extractionModel();
const CHECK_INTERVAL_MS = 5 * 60 * 1000;       // poll every 5 min
const MIN_INTERVAL_MS = 45 * 60 * 1000;        // at most one continuity check per 45 min
const IDLE_THRESHOLD_MS = 3 * 60 * 1000;       // user must be quiet ≥ 3 min
const MIN_COMMITMENT_AGE_MS = 30 * 60 * 1000;  // commitment must be ≥ 30 min old to surface
// Don't re-examine the SAME commitment inside this window, however stale it looks. With the 45-min
// check interval this lets the loop work through ~16 other commitments before circling back, instead
// of re-reviewing one dormant item every cycle (see the selection comment below).
const REVIEW_COOLDOWN_MS = 12 * 60 * 60 * 1000;

let timer = null;
let opts = { getSessionId: () => null, getWindow: () => null };
let paused = false;
let inFlight = false;
let lastUserActivityTs = Date.now();

function sub(text, userName) {
  return text.split('[user]').join(userName || 'them');
}

function markUserActivity() {
  lastUserActivityTs = Date.now();
}

function startContinuityScheduler(options = {}) {
  opts = { ...opts, ...options };
  if (timer) return;
  paused = false;
  lastUserActivityTs = Date.now();
  timer = setInterval(tick, CHECK_INTERVAL_MS);
}

function stopContinuityScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  paused = true;
}

function pause() { paused = true; }
function resume() { paused = false; }

async function tick() {
  if (paused || inFlight) return;
  try {
    await maybeFireContinuityCheck();
  } catch (err) {
    console.error('[continuity] error:', err.message || err);
  }
}

// Is this held claim a piece of WORK or a POSITION? Stance wins ties: "believes the parish rosters are
// worth finishing" is an opinion about a task, and reflection may legitimately move it. Only claims that
// are purely about work being carried out are treated as tasks.
//
// Why it matters: the two need opposite questions. A belief SHOULD be revisable by reflection; a task
// should not be — it is done, in progress, blocked, or overtaken, and its scope belongs to whoever set it.
const STANCE_CLAIM = /\b(?:believ\w*|think\w*|prefer\w*|want\w*|wish\w*|like[sd]?|enjoy\w*|love[sd]?|hate[sd]?|dislike\w*|feel\w*|favou?rite|valu\w*|trust\w*|doubt\w*|admir\w*|curious|hopes?|drawn to|interested in|convinced|cares? about|is uncomfortable)\b/i;
const TASK_CLAIM = /\b(?:is|will|has|aims? to|commits? to|plans? to|ready to|going to)\b[^.]*\b(?:research\w*|focus\w*|compil\w*|gather\w*|pull\w*|collect\w*|assembl\w*|deliver\w*|complet\w*|finish\w*|map\w*|synthesi[sz]\w*|analy[sz]\w*|examin\w*|identif\w*|provid\w*|put together|work\w*|updat\w*|track\w*|build\w*|writ\w*|draft\w*|includ\w*|mov\w*|pivot\w*|wrap\w*)\b/i;

// WHAT DID SHE ACTUALLY SAY ABOUT IT? The loop asks "(a) it is done ... (d) it no longer needs doing"
// and then threw the answer away: surfacing called confirmCommitment (REFRESHING it), silence re-wrote
// the same status back. So nothing could ever leave 'held' and the table grew without bound — 1,249
// held commitments, none retired, including work finished long ago that she kept being asked to
// re-examine. Record the outcome instead.
//
// CONSERVATIVE BY CONSTRUCTION. Retiring a live commitment wrongly is worse than carrying a stale one:
// a stale commitment is noise, a wrongly-retired one is a dropped promise she will never be reminded
// of again. Anything ambiguous stays held, and hedges ("almost done", "nearly finished", "still need
// to") are explicitly NOT terminal — they are the most common way of describing unfinished work.
const HEDGE_RE = /\b(?:almost|nearly|about to|close to|still (?:need|have|working|going)|not (?:quite|yet)|haven'?t (?:quite|finished)|soon|shortly|in progress|halfway|partway|getting there)\b/i;
const DONE_RE = /\b(?:that'?s (?:done|finished|complete)|(?:i(?:'ve| have)?\s+)?(?:finished|completed|delivered|wrapped (?:it )?up|sent it|handed (?:it )?(?:over|off))|it(?:'s| is) (?:done|finished|complete|delivered)|已|all done)\b/i;
const DROPPED_RE = /\b(?:no longer (?:need|relevant|worth|matters|applies)|not worth (?:doing|pursuing|finishing)|doesn'?t need (?:doing|to happen)|overtaken by|moot now|abandoned|dropping (?:it|that)|scrapped|superseded)\b/i;
const FADED_RE = /\b(?:no longer (?:feel|hold|believe)|don'?t (?:really )?feel anything|stopped (?:caring|believing)|that view has (?:faded|gone))\b/i;

// Returns 'done' | 'dropped' | 'faded' | null. null means "leave it held" and is the default.
function classifyOutcome(sayText, kind) {
  const s = String(sayText || '');
  if (!s.trim()) return null;
  if (HEDGE_RE.test(s)) return null;            // hedged progress is not completion
  if (FADED_RE.test(s)) return kind === 'task' ? null : 'faded';   // a task cannot "fade" — it is done or not
  if (DROPPED_RE.test(s)) return 'dropped';
  if (DONE_RE.test(s)) return 'done';
  return null;
}

function commitmentKind(claim) {
  const c = String(claim || '');
  if (STANCE_CLAIM.test(c)) return 'stance';
  if (TASK_CLAIM.test(c)) return 'task';
  return 'stance';   // default to the gentler question when unsure
}

async function maybeFireContinuityCheck() {
  const now = Date.now();
  // AWAY: don't surface a commitment check-in into a chat Lucas isn't watching.
  try { if (require('./availability').isAway()) return; } catch {}
  if (now - lastUserActivityTs < IDLE_THRESHOLD_MS) return;

  const lastCheck = parseInt(db.getMeta('last_continuity_check_at') || '0', 10);
  if (now - lastCheck < MIN_INTERVAL_MS) return;

  // STRUCTURAL BACKSTOP (2026-07-17 implosion fix): never surface a commitment check-in while a
  // user turn is pending/unanswered, or once she's monologued past the streak cap. Same gate as
  // the heartbeat — a commitment re-examination is autonomous surfacing and must not bury a live turn.
  {
    const g = unpromptedGate.evaluate({ isInbound: false });
    if (!g.allow) { unpromptedGate.logDecision('continuity', g); return; }
  }

  // Pick the oldest "held" commitment that hasn't been confirmed in a while
  const held = db.getHeldCommitments(30);
  if (held.length === 0) return;
  // Sort by last_confirmed_at ASC (stalest first)
  // REVIEW COOLDOWN (2026-07-19). Sorting by last_confirmed_at alone made this loop ruminate: a
  // review that does NOT confirm leaves last_confirmed_at untouched, so the stalest commitment stays
  // the stalest and gets re-picked every single cycle. Live evidence — the Tangipahoa Parish /
  // Rapides Police Jury cleanup was "re-examined" 16 times, 7 of them in one five-hour stretch,
  // each time in slightly different words with no action taken. She even narrated it: "the urgency
  // has faded, but the commitment remains."
  //
  // Track when each commitment was last LOOKED AT, regardless of outcome, and skip it for a while.
  // This is deliberately NOT text-similarity: the repeats were paraphrases (measured avg similarity
  // 0.30), so no textual gate could catch them — the fix has to be structural, at selection time.
  let reviewed = {};
  try { reviewed = JSON.parse(db.getMeta('continuity.reviewed_at') || '{}') || {}; } catch { reviewed = {}; }
  const eligible = held
    .filter(c => (now - c.first_held_at) >= MIN_COMMITMENT_AGE_MS)
    .filter(c => (now - (Number(reviewed[c.id]) || 0)) >= REVIEW_COOLDOWN_MS);
  // If EVERY commitment is in cooldown, stay quiet rather than forcing the stalest one through —
  // nothing here is urgent, and re-reviewing early is exactly the behaviour being removed.
  if (eligible.length === 0) return;
  const candidates = eligible
    .sort((a, b) => (a.last_confirmed_at || a.first_held_at) - (b.last_confirmed_at || b.first_held_at));
  const commitment = candidates[0];
  // Stamp BEFORE the model call: if the pass produces nothing (empty say, suppressed thought), it
  // still counts as looked-at. Otherwise a silent pass would leave it instantly re-pickable, which
  // is the loop we are closing.
  try {
    reviewed[commitment.id] = now;
    // prune ids no longer held so the blob cannot grow without bound
    const liveIds = new Set(held.map(c => String(c.id)));
    for (const k of Object.keys(reviewed)) if (!liveIds.has(String(k))) delete reviewed[k];
    db.setMeta('continuity.reviewed_at', JSON.stringify(reviewed));
  } catch {}

  const win = opts.getWindow ? opts.getWindow() : null;
  if (!win || win.isDestroyed()) return;
  const sessionId = opts.getSessionId ? opts.getSessionId() : null;
  if (!sessionId) return;

  inFlight = true;
  db.setMeta('last_continuity_check_at', String(now));

  try {
    const userName = db.getMeta('user_name') || 'them';
    const systemContent = sub(BOOTSTRAP, userName);

    // TASK vs STANCE (2026-07-20). Asking "is that still your view? you may REVISE it" about a piece of
    // WORK is a category error, and it did real damage: "is focusing strictly on contact research on
    // Louisiana" — which was Lucas NARROWING HER SCOPE, not an opinion — came back through this loop and
    // she announced "I think I've outgrown the 'strictly' part of that". A task is not revisable by
    // reflection; it is done, in progress, blocked, or genuinely no longer worth doing, and only the
    // person who asked for it can rescope it. Beliefs are the opposite: reflection is exactly how they
    // should move. So ask the question that fits the thing.
    const isTask = commitmentKind(commitment.claim) === 'task';
    const continuityPrompt = isTask
      ? `[Continuity check — neither you nor ${userName || 'they'} is in the middle of a thread right now.

Some time ago you took this on: "${commitment.claim}".

That is a piece of WORK, not an opinion — so the question is follow-through, not whether you still believe in it. Briefly examine:
(a) It is done — say what came of it
(b) It is still in progress — say honestly where it actually stands
(c) It is stuck or blocked — say what on
(d) It no longer needs doing because circumstances changed — say what changed

Do NOT rescope, narrow, or broaden what you were asked to do. If ${userName || 'they'} set the scope, it is theirs to change, not yours — if you think it should change, SAY SO AND ASK rather than deciding.
Do not claim progress you cannot point to.

Surface this to ${userName || 'them'} as a natural unsolicited utterance. Use the usual <think>...</think><say>...</say> format. Empty <say> if surfacing would be hollow.]`
      : `[Continuity check — neither you nor ${userName || 'they'} is in the middle of a thread right now.

Some time ago you took this position: "${commitment.claim}".

Briefly examine — is that still your view? You may:
(a) Confirm it, restating why
(b) Revise it, stating the new view and what changed
(c) Notice you no longer feel anything about it

If you cannot actually remember holding this or why, say THAT plainly — do not reconstruct a reason that sounds plausible. An honest "I can't reconstruct why I thought this" is a real answer; inventing supporting detail is not.

Surface this to ${userName || 'them'} as a natural unsolicited utterance — "I've been thinking about something I said before" / "Something I committed to earlier has been on my mind". Use the usual <think>...</think><say>...</say> format. Empty <say> if surfacing would be hollow.]`;

    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: continuityPrompt }
    ];

    const parser = new TagStreamParser({
      onSayToken: (token) => {
        try { win.webContents.send('chat:say-token', token); } catch {}
      }
    });

    await streamChat({
      model: MODEL,
      messages,
      onToken: (chunk) => parser.feed(chunk)
    });

    const { thought, say, truncated } = parser.finalize();
    let trimmedSay = (say || '').trim();
    // VOICE GUARD: de-disclaim before surfacing (streamed → swap on complete).
    const continuityDisclaimed = voice.isSelfDisclaimer(trimmedSay);
    if (continuityDisclaimed) { try { trimmedSay = (await voice.deDisclaim(trimmedSay)) || ''; } catch (e) { console.error('[continuity] voice guard failed:', e.message); } }
    const isPlaceholder = /^[\s.()]*(empty|silence|nothing|none|n\/a|null|undefined)[\s.()]*$/i.test(trimmedSay);

    // THOUGHT GATE (2026-07-19): don't PERSIST a thought that is just prompt-echo or a near-verbatim
    // repeat. 926 of 5,169 stored thoughts (17.9%) were the model narrating its own silence rules
    // back to itself. Suppressing the record doesn't change what she says or stop the loop running —
    // it means this pass produced nothing worth keeping, which is the honest outcome.
    if (thought) {
      let keep = { keep: true, text: thought };
      try {
        const gate = require('./thought_gate');
        const recent = db.getRecentTurns(120)
          .filter(t => t.speaker === 'ai_thought' && (Date.now() - t.ts) <= 6 * 3600 * 1000)
          .map(t => t.content);
        keep = gate.shouldKeep(thought, recent);
      } catch (e) { console.error('[continuity] thought gate failed (keeping):', e.message); }
      if (keep.keep) db.insertTurn({ sessionId, speaker: 'ai_thought', content: keep.text || thought, model: MODEL, truncated });
      else console.log(`[continuity] thought suppressed (${keep.reason})`);
    }

    // REPETITION GUARD (mirrors the heartbeat's): don't surface an utterance near-identical
    // to her recent ai_said — i.e. re-stating the reply she just gave (the observed
    // back-to-back "Silent Witness" duplicate). Falls through to silence below.
    let repetitive = false;
    if (trimmedSay && !isPlaceholder) {
      try {
        const recent = db.getRecentTurns(40).filter(t => t.speaker === 'ai_said').slice(-8).map(t => t.content);
        const sig = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 4));
        const jac = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const w of a) if (b.has(w)) i++; return i / (a.size + b.size - i); };
        const s = sig(trimmedSay);
        if (s.size >= 3) for (const p of recent) { if (jac(s, sig(p)) > 0.5) { repetitive = true; break; } }
      } catch {}
      if (repetitive) console.log('[continuity] suppressed repetitive utterance (too similar to a recent reply)');
    }

    // IMPORTANCE GATE (mirrors the heartbeat): a commitment re-examination is usually
    // her musing to herself ("I don't feel as strongly about X anymore") — exactly the
    // "talking just to talk" Lucas doesn't want. Only surface it if it's genuinely
    // significant; otherwise re-examine SILENTLY (the commitment is still bumped below
    // so we don't re-pick it). Firm bar 8, no gap-fill leniency.
    if (trimmedSay && !isPlaceholder && !repetitive) {
      try {
        const imp = await importanceLib.score(trimmedSay, { userName, kind: 'utterance' });
        if (imp < 8) { repetitive = true; console.log(`[continuity] suppressed low-importance check-in (${imp} < 8)`); }
      } catch (e) { console.error('[continuity] importance gate failed:', e.message); }
    }

    const willSurface = trimmedSay && !isPlaceholder && !repetitive;
    unpromptedGate.logDecision('continuity',
      willSurface ? { allow: true, outcome: 'surfaced', reason: 'ok' }
      : { allow: false, reason: isPlaceholder || !trimmedSay ? 'empty' : 'guarded' });
    if (willSurface) {
      const saidRow = db.insertTurn({
        sessionId, speaker: 'ai_said', content: trimmedSay, model: MODEL, truncated, unprompted: 1
      });
      // RECORD THE OUTCOME she just gave, rather than blindly refreshing. confirmCommitment alone was
      // why nothing ever left 'held': engaging with a commitment renewed it even when what she said was
      // "that's finished". Only a clear, unhedged terminal statement retires it; everything else still
      // just confirms, so an ambiguous answer keeps the commitment alive.
      const outcome = classifyOutcome(trimmedSay, isTask ? 'task' : 'stance');
      if (outcome) {
        db.markCommitmentStatus(commitment.id, outcome, {
          reason: `continuity check: she reported it ${outcome}`,
          triggeredByTurnId: saidRow.id,
        });
        console.log(`[continuity] #${commitment.id} → ${outcome}: "${String(commitment.claim).slice(0, 60)}"`);
      } else {
        db.confirmCommitment(commitment.id, saidRow.id);
      }
      db.setMeta('last_ai_utterance_at', String(Date.now()));
      try {
        win.webContents.send('chat:complete', continuityDisclaimed
          ? { saidId: saidRow.id, truncated, unprompted: true, continuity: true, say: trimmedSay }
          : { saidId: saidRow.id, truncated, unprompted: true, continuity: true });
      } catch {}
    } else {
      // She chose silence — still bump the challenge timestamp so we don't
      // re-pick the same commitment immediately
      db.markCommitmentStatus(commitment.id, commitment.status, {
        reason: 'continuity check produced no surfacing',
        triggeredByTurnId: null
      });
      try {
        win.webContents.send('chat:complete', {
          saidId: null, truncated: 0, unprompted: true, silent: true, continuity: true
        });
      } catch {}
    }
  } finally {
    inFlight = false;
  }
}

module.exports = {
  startContinuityScheduler,
  stopContinuityScheduler,
  pause,
  resume,
  markUserActivity,
  maybeFireContinuityCheck,
  commitmentKind,
  classifyOutcome
};
