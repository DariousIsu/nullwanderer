const db = require('./db');
const { streamChat } = require('./ollama');
const { buildReflectionPrompt } = require('./context');

const IDLE_THRESHOLD_MS = 3 * 60 * 1000;     // 3 min of no user input
const MIN_GAP_MS = 10 * 60 * 1000;            // at most one reflection per 10 min
const MIN_TURNS_SINCE_LAST = 6;               // need at least 6 new turns
const TICK_INTERVAL_MS = 30 * 1000;           // check every 30s
const MODEL = 'hf.co/bartowski/PocketDoc_Dans-PersonalityEngine-V1.3.0-24b-GGUF:Q4_K_M';

let timer = null;
let lastUserActivityTs = Date.now();
let opts = { getSessionId: () => null, getWindow: () => null };
let inFlight = false;

function markUserActivity() {
  lastUserActivityTs = Date.now();
}

function startReflectionScheduler(options = {}) {
  opts = { ...opts, ...options };
  if (timer) return;
  lastUserActivityTs = Date.now();
  timer = setInterval(tick, TICK_INTERVAL_MS);
}

function stopReflectionScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick() {
  if (inFlight) return;
  try {
    await reflectIfDue({ force: false });
  } catch (err) {
    console.error('[reflection] tick error:', err);
  }
}

async function reflectIfDue({ force = false } = {}) {
  if (inFlight) return false;

  const now = Date.now();
  const idleMs = now - lastUserActivityTs;

  if (!force && idleMs < IDLE_THRESHOLD_MS) return false;

  const lastReflectionAtStr = db.getMeta('last_reflection_at');
  const lastReflectionAt = lastReflectionAtStr ? parseInt(lastReflectionAtStr, 10) : 0;
  if (!force && (now - lastReflectionAt) < MIN_GAP_MS) return false;

  const lastReflectedIdStr = db.getMeta('last_reflected_turn_id');
  const lastReflectedId = lastReflectedIdStr ? parseInt(lastReflectedIdStr, 10) : 0;

  const newTurns = db.getTurnsSinceId(lastReflectedId);
  if (newTurns.length < MIN_TURNS_SINCE_LAST) return false;

  inFlight = true;
  try {
    const userName = db.getMeta('user_name') || 'them';
    const messages = buildReflectionPrompt({
      userName,
      turnsSinceLastReflection: newTurns
    });

    let content = '';
    await streamChat({
      model: MODEL,
      messages,
      onToken: (t) => { content += t; }
    });

    const trimmed = content.trim();
    if (!trimmed) return false;

    const startId = newTurns[0].id;
    const endId = newTurns[newTurns.length - 1].id;

    db.insertReflection({
      promptUsed: 'v0',
      content: trimmed,
      sourceTurnStart: startId,
      sourceTurnEnd: endId,
      model: MODEL
    });
    db.setMeta('last_reflected_turn_id', String(endId));
    db.setMeta('last_reflection_at', String(now));

    try {
      const win = opts.getWindow ? opts.getWindow() : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('reflection:fired', { ts: now });
      }
    } catch {}
    return true;
  } finally {
    inFlight = false;
  }
}

module.exports = {
  startReflectionScheduler,
  stopReflectionScheduler,
  markUserActivity,
  reflectIfDue,
  forceReflectionIfDue: () => reflectIfDue({ force: true })
};
