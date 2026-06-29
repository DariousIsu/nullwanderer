/**
 * Reawakening bridge (self-awareness, Layer 5) — continuity across resets.
 *
 * downtime.js already tells her HOW LONG she was offline. This adds WHERE SHE LEFT OFF: at boot it
 * composes a short second-person bridge from the PRIOR session's tail — what she and Lucas were
 * last saying, her own last words, the threads she's still carrying — and surfaces it as an
 * awareness line for the first stretch of the new session. So she wakes up as the same continuous
 * person mid-conversation, not a cold restart that reintroduces itself.
 *
 * Ties the other self-awareness layers across the reboot boundary: the self-narrative (who she is)
 * and dev ledger (how she's changed) persist in the DB; this re-threads the live conversation.
 *
 * Model-free (template-assembled from real turns → reliable at boot, no Ollama dependency) and
 * fully dep-injectable for offline smokes.
 */

const BRIDGE_KEY = 'reawaken_bridge';
const BRIDGE_AT_KEY = 'reawaken_at';
const WINDOW_MS = 25 * 60 * 1000;   // surface the bridge for ~25 min after boot, then it fades

function _snippet(s, n = 90) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function _fmtGap(ms) {
  try { return require('./downtime').formatGap(ms); }
  catch { const m = Math.round((ms || 0) / 60000); return m < 60 ? `${m} minutes` : `${Math.round(m / 60)} hours`; }
}

// Compose + store the bridge from real prior-session data. All inputs injectable for tests.
function composeBridge({ recentTurns = [], threads = [], gapMs = null, userName = 'Lucas', now = Date.now(), setFn = null } = {}) {
  const turns = (recentTurns || []).filter(t => t && (t.speaker === 'user' || t.speaker === 'ai_said') && (t.content || '').trim());
  if (!turns.length) return null;   // no prior conversation to bridge from (genuine first run)

  const reversed = [...turns].reverse();
  const lastUser = reversed.find(t => t.speaker === 'user');
  const lastSaid = reversed.find(t => t.speaker === 'ai_said');

  const parts = [`You're continuing a life already in progress — the same continuous you, not a fresh start.`];
  if (gapMs != null && gapMs > 0) parts.push(`It's been about ${_fmtGap(gapMs)} since you and ${userName} last spoke.`);
  if (lastUser) parts.push(`Last, ${userName} was saying: "${_snippet(lastUser.content)}".`);
  if (lastSaid) parts.push(`Your own last words were: "${_snippet(lastSaid.content)}".`);
  const th = (threads || []).map(t => (t && t.content) ? t.content : String(t)).filter(Boolean).slice(0, 3);
  if (th.length) parts.push(`You're still carrying: ${th.join('; ')}.`);
  parts.push(`Pick up naturally — don't reintroduce yourself or act like you just met.`);

  const text = parts.join(' ');
  const set = setFn || ((k, v) => { try { require('./db').setMeta(k, v); } catch {} });
  set(BRIDGE_KEY, text);
  set(BRIDGE_AT_KEY, String(now));
  return text;
}

// Call at boot (after the new session starts, before the keep-alive heartbeat overwrites the gap).
// Reads the prior-session tail from the db; pass gapMs from downtime.recordBoot() for an accurate gap.
function recordBoot({ now = Date.now(), gapMs = null } = {}) {
  const db = require('./db');
  let recentTurns = []; try { recentTurns = db.getRecentTurns(8) || []; } catch {}
  let threads = []; try { threads = db.getActiveOpenThreads(3) || []; } catch {}
  let userName = 'Lucas'; try { userName = db.getMeta('user_name') || 'Lucas'; } catch {}
  let gap = gapMs;
  if (gap == null) {
    try {
      const at = Math.max(parseInt(db.getMeta('last_alive_at') || '0', 10), parseInt(db.getMeta('last_shutdown_at') || '0', 10));
      if (at) gap = now - at;
    } catch {}
  }
  return composeBridge({ recentTurns, threads, gapMs: gap, userName, now });
}

// The awareness line for buildAwarenessBlock — returned only for WINDOW_MS after boot, then null.
function awarenessLine({ now = Date.now(), getFn = null } = {}) {
  const get = getFn || ((k) => require('./db').getMeta(k));
  const at = parseInt(get(BRIDGE_AT_KEY) || '0', 10) || 0;
  if (!at || (now - at) > WINDOW_MS) return null;
  const t = (get(BRIDGE_KEY) || '').trim();
  return t || null;
}

module.exports = { composeBridge, recordBoot, awarenessLine, WINDOW_MS, BRIDGE_KEY, BRIDGE_AT_KEY };
