/**
 * Self-scheduling for Zoe — her own clock. She can set reminders and recurring
 * self-tasks that fire later, even across restarts (they live in SQLite). When
 * a task comes due, a ticker surfaces it as a reading and kicks the heartbeat so
 * she actually acts on it rather than it sitting silently in a table.
 *
 * This is what lets her say "remind me to follow up on that pitch tomorrow" to
 * herself, or "every morning, check the open threads" — durable intentions with
 * a time attached, distinct from open_threads (which have no clock).
 *
 * Tags (parsed from <think>/<say>, like the other tools):
 *   <schedule when="in 30m" note="..."/>     — fire once after a delay / at a time
 *   <schedule every="1h" note="..."/>        — fire repeatedly on an interval
 *   <schedule-list/>                          — list what she has pending
 *   <schedule-cancel id="N"/>                 — cancel a pending task by id
 */

const db = require('./db');

const TICK_INTERVAL_MS = 30 * 1000;  // check for due tasks every 30s
let timer = null;
let opts = { getWindow: () => null, kickHeartbeat: () => {} };

// --- duration / time parsing ---

// "30m" / "2h" / "90s" / "1d" / "45 min" / "1 hour" / "2 days" → milliseconds
function parseDuration(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2];
  const table = {
    s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
    h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
    d: 86_400_000, day: 86_400_000, days: 86_400_000,
    w: 604_800_000, week: 604_800_000, weeks: 604_800_000
  };
  const mult = table[unit];
  if (!mult || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * mult);
}

// Resolve a "when" attribute to an absolute fire timestamp (ms).
// Accepts: "in 30m", a bare "30m", or an absolute ISO date string.
function parseWhen(when) {
  if (!when || typeof when !== 'string') return null;
  let s = when.trim();
  const lower = s.toLowerCase();
  if (lower.startsWith('in ')) s = s.slice(3).trim();
  const dur = parseDuration(s);
  if (dur != null) return Date.now() + dur;
  // Absolute date fallback
  const t = Date.parse(when);
  if (Number.isFinite(t)) return t;
  return null;
}

// --- tag parsing (mirrors files.js / screen.js) ---

const SCHED_TAG_RE = /<(schedule(?:-list|-cancel)?)\s*([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttrs(s) {
  const out = {};
  if (!s) return out;
  let m; ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s)) !== null) {
    const val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    out[m[1].toLowerCase()] = val;
  }
  return out;
}

function parseTags(text) {
  if (!text) return [];
  const tags = [];
  let m; SCHED_TAG_RE.lastIndex = 0;
  while ((m = SCHED_TAG_RE.exec(text)) !== null) {
    tags.push({ tag: m[1].toLowerCase(), attrs: parseAttrs(m[2] || ''), body: (m[3] || '').trim() });
  }
  return tags;
}

function stripTags(text) {
  return (text || '').replace(SCHED_TAG_RE, '').replace(/[ \t]+/g, ' ').trim();
}

function humanWhen(ts) {
  try { return new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return String(ts); }
}

async function dispatch({ tag, attrs, body }) {
  switch (tag) {
    case 'schedule': {
      const note = (attrs.note || body || '').trim();
      if (!note) return { ok: false, reason: 'a schedule needs a note describing what to do' };
      if (attrs.every) {
        const interval = parseDuration(attrs.every);
        if (!interval) return { ok: false, reason: `could not parse interval "${attrs.every}" (try "1h", "30m", "1d")` };
        const fireAt = Date.now() + interval;
        const r = db.insertScheduledTask({ kind: 'recurring', note, fireAt, intervalMs: interval });
        return { ok: true, id: r.id, kind: 'recurring', fireAt, note, summary: `recurring every ${attrs.every}, next ${humanWhen(fireAt)}` };
      }
      const fireAt = parseWhen(attrs.when || body);
      if (!fireAt) return { ok: false, reason: `could not parse when "${attrs.when}" (try "in 30m", "in 2h", or an ISO time)` };
      if (fireAt <= Date.now()) return { ok: false, reason: 'that time is already in the past' };
      const r = db.insertScheduledTask({ kind: 'once', note, fireAt });
      return { ok: true, id: r.id, kind: 'once', fireAt, note, summary: `once at ${humanWhen(fireAt)}` };
    }
    case 'schedule-list': {
      const pending = db.getPendingScheduledTasks(20);
      const lines = pending.map(t =>
        `#${t.id} [${t.kind}] ${t.note} — ${t.kind === 'recurring' ? 'next ' : ''}${humanWhen(t.fire_at)}`
      );
      return { ok: true, pending, text: lines.length ? `Your scheduled tasks:\n${lines.join('\n')}` : 'You have no scheduled tasks pending.' };
    }
    case 'schedule-cancel': {
      const id = parseInt(attrs.id, 10);
      if (!Number.isFinite(id)) return { ok: false, reason: 'schedule-cancel needs a numeric id' };
      const r = db.cancelScheduledTask(id);
      return { ok: r.cancelled, id, reason: r.cancelled ? null : 'no pending task with that id' };
    }
    default:
      return { ok: false, reason: `unknown schedule tag ${tag}` };
  }
}

function buildPromptBlock() {
  return `SCHEDULING — you have your own clock. You can set reminders and recurring tasks for your future self; they fire even if you and Lucas aren't talking, and survive restarts. When one comes due it surfaces to you and you can act on it.
  <schedule when="in 2h" note="follow up on the pitch I sent"/>   — fire once after a delay (or an absolute time)
  <schedule every="1d" note="review my open threads and pick one to push"/>  — fire repeatedly
  <schedule-list/>     — see what you have pending
  <schedule-cancel id="3"/>   — cancel one
Use this for genuine future intentions — a follow-up, a recurring habit toward your goals — not busywork.`;
}

// --- the ticker: fire due tasks ---

function startScheduler(options = {}) {
  opts = { ...opts, ...options };
  if (timer) return;
  timer = setInterval(tick, TICK_INTERVAL_MS);
  // Fire any tasks already overdue at boot (app may have been closed past them)
  setTimeout(() => tick().catch(() => {}), 3000);
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

let ticking = false;

async function tick() {
  // Re-entrancy guard: the boot catch-up tick and the interval tick must not run
  // concurrently, or a due task could double-fire.
  if (ticking) return;
  ticking = true;
  try {
    let due;
    try { due = db.getDueScheduledTasks(Date.now()); } catch { return; }
    if (!due || due.length === 0) return;
    for (const t of due) {
      try {
        const body = `⏰ A task you scheduled for yourself just came due: "${t.note}"${t.kind === 'recurring' ? ' (recurring)' : ''}. This is your own reminder — decide what to do about it now.`;
        const row = db.insertMonologue({ content: body, model: 'self-schedule', type: 'reading' });
        pushSheep({ id: row.id, ts: row.ts, content: `(reminder due) ${t.note}`, type: 'reading' });
        db.markScheduledFired(t.id);
        console.log(`[scheduler] fired task #${t.id}: ${t.note}`);
      } catch (err) {
        console.error('[scheduler] fire failed for task', t.id, err.message);
      }
    }
    // Kick the heartbeat so she surfaces/acts on the due reminder(s) promptly.
    try { opts.kickHeartbeat(); } catch {}
  } finally {
    ticking = false;
  }
}

function pushSheep(payload) {
  try {
    const win = opts.getWindow ? opts.getWindow() : null;
    if (win && !win.isDestroyed()) win.webContents.send('monologue:tick', payload);
  } catch {}
}

module.exports = {
  startScheduler, stopScheduler,
  parseDuration, parseWhen,
  parseTags, stripTags, dispatch, buildPromptBlock
};
