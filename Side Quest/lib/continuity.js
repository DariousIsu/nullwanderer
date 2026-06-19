const db = require('./db');
const { streamChat, TagStreamParser } = require('./ollama');
const { BOOTSTRAP } = require('./context');

const MODEL = 'hf.co/bartowski/PocketDoc_Dans-PersonalityEngine-V1.3.0-24b-GGUF:Q4_K_M';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;       // poll every 5 min
const MIN_INTERVAL_MS = 45 * 60 * 1000;        // at most one continuity check per 45 min
const IDLE_THRESHOLD_MS = 3 * 60 * 1000;       // user must be quiet ≥ 3 min
const MIN_COMMITMENT_AGE_MS = 30 * 60 * 1000;  // commitment must be ≥ 30 min old to surface

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
  if (now - lastUserActivityTs < IDLE_THRESHOLD_MS) return;

  const lastCheck = parseInt(db.getMeta('last_continuity_check_at') || '0', 10);
  if (now - lastCheck < MIN_INTERVAL_MS) return;

  // Pick the oldest "held" commitment that hasn't been confirmed in a while
  const held = db.getHeldCommitments(30);
  if (held.length === 0) return;
  // Sort by last_confirmed_at ASC (stalest first)
  const candidates = held
    .filter(c => (now - c.first_held_at) >= MIN_COMMITMENT_AGE_MS)
    .sort((a, b) => (a.last_confirmed_at || a.first_held_at) - (b.last_confirmed_at || b.first_held_at));
  if (candidates.length === 0) return;
  const commitment = candidates[0];

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
    const trimmedSay = (say || '').trim();
    const isPlaceholder = /^[\s.()]*(empty|silence|nothing|none|n\/a|null|undefined)[\s.()]*$/i.test(trimmedSay);

    if (thought) {
      db.insertTurn({ sessionId, speaker: 'ai_thought', content: thought, model: MODEL, truncated });
    }

    if (trimmedSay && !isPlaceholder) {
      const saidRow = db.insertTurn({
        sessionId, speaker: 'ai_said', content: trimmedSay, model: MODEL, truncated
      });
      // Refresh confirmation timestamp — she engaged with this commitment
      db.confirmCommitment(commitment.id, saidRow.id);
      db.setMeta('last_ai_utterance_at', String(Date.now()));
      try {
        win.webContents.send('chat:complete', {
          saidId: saidRow.id, truncated, unprompted: true, continuity: true
        });
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
