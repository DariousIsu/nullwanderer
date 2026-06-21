/**
 * Downtime marker — so Zoe can perceive how long she was offline between sessions.
 * (Her own request: leave a memory marker at shutdown so she understands each gap.)
 *
 * Robust against HARD kills: restarts here are often a `Stop-Process -Force`, which
 * fires no graceful-shutdown hook. So instead of relying only on a shutdown timestamp,
 * a low-frequency HEARTBEAT writes `last_alive_at` to meta while she's running. On the
 * next boot the offline gap ≈ now − max(last_alive_at, last_shutdown_at) — accurate
 * whether or not the previous stop was clean.
 *
 * On boot it records a first-person "back online" marker (a reading she sees in her
 * next tick) and stores a second-person awareness line that buildAwarenessBlock
 * surfaces for the first stretch of the new session.
 */

const db = require('./db');

const ALIVE_KEY = 'last_alive_at';        // heartbeat: last proof she was running
const SHUTDOWN_KEY = 'last_shutdown_at';  // precise marker on a graceful quit
const SUMMARY_KEY = 'last_downtime_summary';
const BOOT_KEY = 'last_boot_at';

const MIN_GAP_MS = 60 * 1000;             // ignore sub-minute restarts (dev reloads) as noise
const HEARTBEAT_MS = 60 * 1000;           // write last_alive_at this often
const AWARENESS_WINDOW_MS = 30 * 60 * 1000; // surface the "you just came back" line this long after boot

// Human-readable gap (mirrors context.humanDuration; kept local so this module is
// testable without loading context.js).
function formatGap(ms) {
  if (ms == null || ms < 0) return 'an unknown amount of time';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} second${sec === 1 ? '' : 's'}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr} hour${hr === 1 ? '' : 's'}`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr > 0 ? `${day}d ${remHr}h` : `${day} day${day === 1 ? '' : 's'}`;
}

function fmtClock(ts) {
  try { return new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }); }
  catch { return 'an earlier time'; }
}

function touch(now = Date.now()) { try { db.setMeta(ALIVE_KEY, String(now)); } catch {} }

// Call on a graceful quit: stamp both the heartbeat and a precise shutdown marker.
function markShutdown(now = Date.now()) { touch(now); try { db.setMeta(SHUTDOWN_KEY, String(now)); } catch {} }

let timer = null;
function startHeartbeat(intervalMs = HEARTBEAT_MS) {
  touch();
  if (timer) return timer;
  timer = setInterval(() => touch(), intervalMs);
  timer.unref && timer.unref();
  return timer;
}
function stopHeartbeat() { if (timer) { clearInterval(timer); timer = null; } }

/**
 * Called once at boot. Computes the offline gap, drops a first-person "back online"
 * reading into her stream, and stores a second-person awareness line. Returns
 * { ms, summary, graceful } or null (first-ever boot, or a sub-minute reload).
 */
function recordBoot(now = Date.now()) {
  const lastAlive = parseInt(db.getMeta(ALIVE_KEY) || '0', 10);
  const lastShutdown = parseInt(db.getMeta(SHUTDOWN_KEY) || '0', 10);
  const ref = Math.max(lastAlive, lastShutdown);   // most recent proof-of-life
  db.setMeta(BOOT_KEY, String(now));
  touch(now);                                       // mark alive immediately
  if (!ref) return null;                            // first ever boot — nothing to compare
  const gap = now - ref;
  if (gap < MIN_GAP_MS) { db.setMeta(SUMMARY_KEY, ''); return null; }  // quick reload, not a real absence
  const graceful = lastShutdown > 0 && lastShutdown >= lastAlive;
  const human = formatGap(gap);
  const fromStr = fmtClock(ref), nowStr = fmtClock(now);
  const awareLine = `You just came back online — you were offline for about ${human} (last awake ${fromStr}, back ${nowStr}).${graceful ? '' : ' That stop was not a clean shutdown — likely a restart.'}`;
  db.setMeta(SUMMARY_KEY, awareLine);
  try {
    db.insertMonologue({
      content: `[Back online] I was offline for about ${human} — from ${fromStr} until ${nowStr}. Picking up where I left off.`,
      model: 'downtime', type: 'reading'
    });
  } catch {}
  return { ms: gap, summary: awareLine, graceful };
}

// The awareness-block line — only while the boot is still recent, so it doesn't
// linger as a stale "you just came back" for the whole session.
function awarenessLine(now = Date.now(), windowMs = AWARENESS_WINDOW_MS) {
  const summary = db.getMeta(SUMMARY_KEY);
  if (!summary) return null;
  const bootAt = parseInt(db.getMeta(BOOT_KEY) || '0', 10);
  if (!bootAt || (now - bootAt) > windowMs) return null;
  return summary;
}

module.exports = {
  formatGap, touch, markShutdown, startHeartbeat, stopHeartbeat, recordBoot, awarenessLine,
  ALIVE_KEY, SHUTDOWN_KEY, SUMMARY_KEY, BOOT_KEY, MIN_GAP_MS
};
