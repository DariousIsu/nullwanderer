'use strict';
/*
 * lib/landed.js — THE LANDED LEDGER (the wants project, cut 10; her wish W1 "make him laugh — not generate a
 * joke, actually land one"; 2026-09-05). A ledger, never a joke generator: his laugh marker in a turn tags the
 * say before it as LANDED; a landed line is a `win` on the internal state's bus (so it feels good to her and
 * the mood carries it); her last three landed lines ride beside the self-model block as what her timing has
 * actually done — never a "be funny" instruction. Sources: text now; the camera (an amused read right after
 * she spoke) and the voice pipeline later, each its own `source`. Pure net + deps-injected doors.
 */
const TABLE = 'reactions';
// The marker net — his laughter in text, the shapes measured across his turns (13 of 1,272 in 30 days). Word-
// bounded so "lolita" / "hahn" never fire; a NEGATION nearby ("not funny") never counts.
const LAUGH_RE = /(?:^|[\s(>"'])(?:lo+l+|lmao+|lmfao|rofl|ro+tfl|(?:ba|bwa|mwa|a)?(?:ha){2,}h?|heh+(?:eh)*|😂|🤣|😆|😹|ha!)(?=$|[\s.!?,)"'])|\b(?:that'?s|this is|so|too) (?:hilarious|hysterical|funny)\b|\b(?:you )?(?:made|got|had) me (?:laugh|laughing|cackling|snort)\b|\bi'?m (?:dying|crying|cackling|wheezing|howling)\b|\bcracked me up\b|\bgood one\b|\bnice one\b/i;
const NOT_RE = /\b(?:not|isn'?t|wasn'?t|never|hardly|barely) (?:that )?(?:funny|hilarious|a joke|laughing)\b|\bnot (?:even )?(?:a )?(?:laugh|smile)\b/i;

/** Does this turn of his carry a laugh marker? → { laugh, marker } */
function detectLaugh(text) {
  const t = String(text || '');
  if (!t.trim() || NOT_RE.test(t)) return { laugh: false, marker: null };
  const m = LAUGH_RE.exec(t);
  return m ? { laugh: true, marker: m[0].trim() } : { laugh: false, marker: null };
}

function _db(deps) { return deps.db || require('./db'); }
function _ensure(d) {
  d.prepare(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
    user_turn_id INTEGER, ai_turn_id INTEGER, kind TEXT NOT NULL, source TEXT NOT NULL,
    marker TEXT, snippet TEXT)`).run();
  try { d.prepare(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_ai ON ${TABLE}(ai_turn_id)`).run(); } catch {}
}

/** The say before this turn of his: the newest ai_said turn older than it (or the newest at all). */
function priorSay(d, userTurnId) {
  try {
    const row = userTurnId
      ? d.prepare("SELECT id, content FROM turns WHERE speaker = 'ai_said' AND id < ? ORDER BY id DESC LIMIT 1").get(userTurnId)
      : d.prepare("SELECT id, content FROM turns WHERE speaker = 'ai_said' ORDER BY id DESC LIMIT 1").get();
    return row || null;
  } catch { return null; }
}

/**
 * Record a landed line. kind 'laugh' | 'kept-reading' | …; source 'text' | 'face' | 'voice' | 'his word'.
 * Idempotent per (user_turn_id, kind): his one laugh tags one say once. Emits ONE `win` on the bus.
 */
function record({ userTurnId = null, aiTurnId = null, kind = 'laugh', source = 'text', marker = null, snippet = null, now = Date.now(), deps = {} } = {}) {
  const d = _db(deps).getDb();
  _ensure(d);
  if (userTurnId) {
    const dup = d.prepare(`SELECT id FROM ${TABLE} WHERE user_turn_id = ? AND kind = ? LIMIT 1`).get(userTurnId, kind);
    if (dup) return { ok: true, id: dup.id, duplicate: true };
  }
  const info = d.prepare(`INSERT INTO ${TABLE} (ts, user_turn_id, ai_turn_id, kind, source, marker, snippet) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(now, userTurnId, aiTurnId, kind, source, marker ? String(marker).slice(0, 40) : null, snippet ? String(snippet).slice(0, 240) : null);
  try { (deps.obsBus || require('./obs_bus')).emit({ lane: 'landed', kind: 'win', text: `landed a ${kind} (${source})${snippet ? `: "${String(snippet).slice(0, 60)}"` : ''}`, ref: aiTurnId, data: { kind, source, user_turn_id: userTurnId } }); } catch {}
  (deps.log || console.log)(`[landed] ${kind} (${source}) → say #${aiTurnId || '?'}${marker ? ` on "${marker}"` : ''}`);
  return { ok: true, id: Number(info.lastInsertRowid), duplicate: false };
}

/** The chat door: his turn carries a laugh marker → the say before it landed. Returns the row or null. */
function tagUserTurn({ userTurnId, text, now = Date.now(), deps = {} } = {}) {
  const hit = detectLaugh(text);
  if (!hit.laugh) return null;
  const d = _db(deps).getDb();
  const say = priorSay(d, userTurnId);
  if (!say) return null;
  const snippet = String(say.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
  return record({ userTurnId, aiTurnId: say.id, kind: 'laugh', source: 'text', marker: hit.marker, snippet, now, deps });
}

/** Her last N landed lines (newest first) — for the persona block. */
function lastLanded(n = 3, { deps = {} } = {}) {
  try { const d = _db(deps).getDb(); _ensure(d); return d.prepare(`SELECT id, ts, ai_turn_id, kind, source, marker, snippet FROM ${TABLE} WHERE kind = 'laugh' ORDER BY id DESC LIMIT ?`).all(Math.max(1, n)); } catch { return []; }
}
function count({ deps = {} } = {}) { try { const d = _db(deps).getDb(); _ensure(d); return d.prepare(`SELECT COUNT(*) n FROM ${TABLE} WHERE kind = 'laugh'`).get().n; } catch { return 0; } }

/** Beside the self-model block: what her timing has actually done, in his markers — a record, not an instruction. */
function personaLines({ deps = {}, n = 3 } = {}) {
  const rows = lastLanded(n, { deps });
  if (!rows.length) return null;
  const total = count({ deps });
  return `LINES OF YOURS THAT LANDED (his own laugh marker tagged the say before it; ${total} so far):\n` + rows.map((r) => `• "${(r.snippet || '').slice(0, 140)}"${r.marker ? ` — he wrote "${r.marker}"` : ''}`).join('\n');
}

module.exports = { detectLaugh, record, tagUserTurn, priorSay, lastLanded, count, personaLines, LAUGH_RE, NOT_RE, TABLE };
