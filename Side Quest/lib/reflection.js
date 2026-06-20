const db = require('./db');
const { streamChat } = require('./ollama');
const { buildReflectionPrompt } = require('./context');
const blackboard = require('./blackboard');
const memoryLib = require('./memory');

// Generative-Agents significance trigger: reflection fires when enough IMPORTANT
// thinking has accumulated (sum of thought/reading importance ≥ threshold), not
// just on a clock. Those reflections are stored as durable knowledge notes so
// they compound (the "understand topics deeper" mechanism) and become retrievable
// by the scored retriever. Park et al. use 150; we match it.
const SIGNIFICANCE_THRESHOLD = 150;
const MIN_ITEMS_FOR_SIGNIFICANCE = 4;

const IDLE_THRESHOLD_MS = 3 * 60 * 1000;     // 3 min of no user input
const MIN_GAP_MS = 10 * 60 * 1000;            // at most one reflection per 10 min
const MIN_TURNS_SINCE_LAST = 6;               // need at least 6 new turns
const TICK_INTERVAL_MS = 30 * 1000;           // check every 30s
const MODEL = require('./config').model();

let timer = null;
let lastUserActivityTs = Date.now();
let opts = { getSessionId: () => null, getWindow: () => null };
let paused = false;
let inFlight = false;

function pause() { paused = true; }
function resume() { paused = false; }

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
  if (paused || inFlight) return;
  try {
    // Significance-triggered reflection takes precedence (it's the "enough has
    // happened" signal). Falls back to the time/turn-based reflection otherwise.
    const did = await maybeSignificanceReflect();
    if (!did) await reflectIfDue({ force: false });
  } catch (err) {
    console.error('[reflection] tick error:', err);
  }
}

// Fires when the importance accumulator (bumped by the monologue as it scores
// thoughts/readings) crosses the threshold. Synthesizes 1–3 higher-level insights
// from the recent significant stream and stores each as a durable knowledge note.
async function maybeSignificanceReflect() {
  if (inFlight || paused) return false;
  const accum = parseInt(db.getMeta('reflection_importance_accum') || '0', 10);
  if (accum < SIGNIFICANCE_THRESHOLD) return false;

  const lastId = parseInt(db.getMeta('last_significance_monologue_id') || '0', 10);
  const recent = db.getRecentMonologue(40).filter(m => m.id > lastId && (m.type === 'thought' || m.type === 'reading'));
  if (recent.length < MIN_ITEMS_FOR_SIGNIFICANCE) {
    // Threshold tripped but too little fresh material to synthesize — decay the
    // accumulator so it doesn't sit permanently tripped, and wait for more.
    db.setMeta('reflection_importance_accum', String(Math.floor(accum / 2)));
    return false;
  }

  inFlight = true;
  try {
    const userName = db.getMeta('user_name') || 'them';
    const lines = recent.slice(-20).map((m, i) => `${i + 1}. ${(m.content || '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
    const messages = [{
      role: 'user',
      content: `These are things ${userName}'s companion has recently thought and read on its own:\n\n${lines}\n\nWhat 1–3 higher-level INSIGHTS connect or deepen these — durable takeaways worth keeping, NOT a summary and NOT a restatement of any single item? Write each insight as ONE standalone sentence on its own line. No preamble, no numbering.`
    }];

    let raw = '';
    await streamChat({
      model: MODEL,
      messages,
      options: { temperature: 0.6, top_p: 0.9, num_ctx: 8192, num_predict: 220 },
      onToken: (t) => { raw += t; }
    });

    const insights = raw.split('\n').map(s => s.replace(/^[\s\-*\d.)]+/, '').trim()).filter(s => s.length >= 15).slice(0, 3);
    if (insights.length === 0) { db.setMeta('reflection_importance_accum', '0'); return false; }

    const now = Date.now();
    for (const ins of insights) {
      try { await memoryLib.store({ kind: 'note', content: ins, source: 'reflection', importance: 0.8 }); }
      catch (e) { console.error('[reflection] insight store failed:', e.message); }
    }
    const joined = insights.map(s => `• ${s}`).join('\n');
    const reflRow = db.insertReflection({ promptUsed: 'significance-v1', content: joined, sourceTurnStart: null, sourceTurnEnd: null, model: MODEL });
    try { blackboard.append({ source: 'reflection', kind: 'insight', refTable: 'reflections', refId: reflRow && reflRow.id, content: joined }); } catch {}

    db.setMeta('reflection_importance_accum', '0');
    db.setMeta('last_significance_monologue_id', String(recent[recent.length - 1].id));
    db.setMeta('last_reflection_at', String(now));
    console.log(`[reflection] significance reflection — ${insights.length} insight(s) stored as notes`);
    try { const win = opts.getWindow ? opts.getWindow() : null; if (win && !win.isDestroyed()) win.webContents.send('reflection:fired', { ts: now, significance: true }); } catch {}
    return true;
  } finally {
    inFlight = false;
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

    const reflRow = db.insertReflection({
      promptUsed: 'v0',
      content: trimmed,
      sourceTurnStart: startId,
      sourceTurnEnd: endId,
      model: MODEL
    });
    db.setMeta('last_reflected_turn_id', String(endId));
    db.setMeta('last_reflection_at', String(now));
    // write-bottom: a reflection is an 'insight' event on the shared timeline.
    try { blackboard.append({ source: 'reflection', kind: 'insight', refTable: 'reflections', refId: reflRow && reflRow.id, content: trimmed }); } catch (e) { console.error('[reflection] blackboard append failed:', e.message); }

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
  pause,
  resume,
  markUserActivity,
  reflectIfDue,
  maybeSignificanceReflect,
  forceReflectionIfDue: () => reflectIfDue({ force: true }),
  SIGNIFICANCE_THRESHOLD,
  MIN_ITEMS_FOR_SIGNIFICANCE
};
