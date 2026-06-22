/**
 * User availability — does Zoe think Lucas is at the machine right now?
 *
 * Drives the "what surfaces vs stays to herself" rule: she ALWAYS answers a direct
 * message immediately, but UNPROMPTED utterances (heartbeat / continuity) are
 * suppressed entirely while he's away — no musing into a window he isn't watching.
 * (His rule: don't talk just to talk, and especially not after I've said I'm away.)
 *
 * State is meta-backed (single user). Any message FROM him means he's present, so the
 * chat path clears 'away' on every turn; a message that itself announces leaving then
 * re-sets it. The detector is deliberately specific so casual phrasing doesn't trip it.
 */

const db = require('./db');

const AWAY_KEY = 'user_away';
const SINCE_KEY = 'user_away_since';
const REASON_KEY = 'user_away_reason';

// "I'm leaving / I'll be gone / I'm done for the day" signals. Broad on end-of-day
// phrasings (bed / sleep / goodnight / calling it a night / for the night) — a false
// "away" only quiets her unprompted chatter, which Lucas prefers over the reverse.
const AWAY_RE = /\b(?:i'?ll?\s+be\s+(?:away|back|gone|offline|out|afk)|i'?m\s+(?:heading|stepping|going)\s+(?:out|off|away)|stepping\s+(?:out|away|afk)|be\s+right\s+back|\bbrb\b|\bafk\b|away\s+from\s+(?:my|the)\s+(?:computer|desk|keyboard|machine|screen)|gotta\s+(?:go|run)|head(?:ing|ed)?\s+(?:out|off|home)|(?:go(?:ing)?|head(?:ing|ed)?|off)\s+to\s+bed|go(?:ing)?\s+to\s+sleep|get(?:ting)?\s+some\s+sleep|good\s?night|g'?night|night\s+night|\bnite\b|call(?:ing)?\s+it\s+(?:a\s+)?(?:night|day|quits)|done\s+for\s+(?:the\s+)?(?:night|day|today|tonight)|that'?s\s+it\s+for\s+(?:tonight|today|the\s+night)|for\s+the\s+(?:night|evening)|talk\s+(?:to\s+you\s+)?later|logging\s+off|signing\s+off|see\s+you\s+(?:later|tomorrow|tonight|in\s+a\s+bit))\b/i;
// An explicit "I'm back" is NOT an away signal (a bare message already clears away).
const BACK_RE = /\b(?:i'?m\s+back|back\s+now|i'?m\s+here|just\s+got\s+back|returned)\b/i;

// Returns a short reason label if the text announces leaving, else null.
function detectAway(text) {
  const t = String(text || '');
  if (BACK_RE.test(t)) return null;
  const m = t.match(AWAY_RE);
  return m ? m[0].toLowerCase().trim() : null;
}

function setAway(reason, now = Date.now()) {
  db.setMeta(AWAY_KEY, '1');
  db.setMeta(SINCE_KEY, String(now));
  db.setMeta(REASON_KEY, reason || '');
}
function clearAway() {
  db.setMeta(AWAY_KEY, '0');
  db.setMeta(REASON_KEY, '');
}
function isAway() { return db.getMeta(AWAY_KEY) === '1'; }
function awaySince() { const v = parseInt(db.getMeta(SINCE_KEY) || '0', 10); return v || null; }
function awayReason() { return db.getMeta(REASON_KEY) || ''; }

module.exports = { detectAway, setAway, clearAway, isAway, awaySince, awayReason, AWAY_KEY, SINCE_KEY, REASON_KEY };
