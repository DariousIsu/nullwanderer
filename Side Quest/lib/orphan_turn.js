'use strict';
/**
 * lib/orphan_turn.js — THE ORPHANED TURN (cut 24, 2026-09-04).
 *
 * A generation that dies mid-reply — a cycle, a crash — leaves his newest message in the store with
 * no reply after it in its session, and nothing in the next generation ever looked for it. Measured
 * twice on 09-04: at 00:26 he retyped his message himself a minute later; at 02:30 it sat dead until
 * this was written. The finder names the orphan; main.js serves it through the one chat door at boot.
 *
 * The rule is the test port's own unanswered rule (lib/test_port._realUserState): the newest user
 * turn, unanswered when no ai_said row follows it IN ITS SESSION. Bounded by age — a message from
 * yesterday is not re-answered as if it were new (he has moved on; the unprompted lanes carry the
 * rest) — and never an injected test-port turn (those are the harness's, not his).
 */
const DEFAULT_MAX_AGE_MS = 6 * 3600 * 1000;

/** The newest user turn that no reply followed in its session, if it is younger than maxAgeMs; else null. */
function findOrphanedTurn(db, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, injectedWindows = [] } = {}) {
  try {
    const d = db.getDb();
    const rows = d.prepare(`SELECT id, session_id, ts, content FROM turns WHERE speaker = 'user' ORDER BY ts DESC LIMIT 40`).all();
    const t = (rows || []).find((r) => !(injectedWindows || []).some((w) => r.ts >= w.a && r.ts <= w.b));
    if (!t) return null;
    if (now - (t.ts || 0) > maxAgeMs) return null;
    if (!String(t.content || '').trim()) return null;
    const n = d.prepare(`SELECT COUNT(*) n FROM turns WHERE speaker = 'ai_said' AND session_id = ? AND ts > ?`).get(t.session_id, t.ts);
    if (n && n.n > 0) return null;
    return t;
  } catch { return null; }
}

function describe(t, now = Date.now()) {
  if (!t) return 'none';
  const age = Math.max(0, now - (t.ts || 0));
  return `${Math.round(age / 1000)}s old, session ${t.session_id}: "${String(t.content || '').replace(/\s+/g, ' ').slice(0, 80)}"`;
}

module.exports = { findOrphanedTurn, describe, DEFAULT_MAX_AGE_MS };
