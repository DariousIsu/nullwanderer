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

    const continuityPrompt = `[Continuity check — neither you nor ${userName || 'they'} is in the middle of a thread right now.

Some time ago you took this position: "${commitment.claim}".

Briefly examine — is that still your view? You may:
(a) Confirm it, restating why
(b) Revise it, stating the new view and what changed
(c) Notice you no longer feel anything about it

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
      // Refresh confirmation timestamp — she engaged with this commitment
      db.confirmCommitment(commitment.id, saidRow.id);
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
  maybeFireContinuityCheck
};
