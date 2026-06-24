/**
 * Open-question stack — Piece 1 of the conversation harness.
 *
 * The QUD/grounding fix for "she asks a question, then forgets she asked." When her <say>
 * ends in a question to Lucas, we record it as PENDING conversational state. On his next
 * message we surface it as a high-salience labeled block ("you asked X — this is his answer")
 * so a terse reply BINDS to the question instead of floating free, then mark it answered.
 *
 * Pure deterministic scaffolding — the coreference binding a 24B can't do implicitly (a bare
 * "yeah" → the question two turns up) is done in structure, not asked of the model. This is
 * also the substrate for the voice gate, where there's no scrollback to lean on.
 *
 * Grounded in QUD-stack theory (Roberts 2012; Ginzburg KoS / Dialogue Gameboard 1996) +
 * Clark & Schaefer grounding (present → accept). See docs/CONVERSATION_HARNESS.md.
 */
const db = require('./db');

const MAX_AGE_MS = 30 * 60 * 1000; // a question older than this has lost its moment

// Pull the trailing QUESTION out of her say, if any. She often closes a substantive reply
// with a question to him; we store just that sentence (capped), not the whole turn. v1 keys
// on a trailing '?' on the final sentence — the reliable "I'm asking you something" signal.
function extractQuestion(say) {
  const text = (say || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const parts = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  for (let i = parts.length - 1; i >= 0; i--) {
    const s = (parts[i] || '').trim();
    if (!s) continue;            // skip trailing empties
    return /\?$/.test(s) ? s.slice(-280) : null;  // last real sentence must be the question
  }
  return null;
}

// DETECT — if her reply asked Lucas something, record it as pending state.
function recordFromSay(sessionId, say, askedTurnId = null) {
  try {
    const q = extractQuestion(say);
    if (!q) return null;
    return db.insertOpenQuestion({ sessionId, question: q, askedTurnId });
  } catch (e) { console.error('[open_questions] record failed:', e.message); return null; }
}

// SURFACE + RESOLVE — the pending questions to show on THIS user turn (most recent first).
// We resolve them in the same breath (mark answered, bound to the answering turn): they
// surface exactly once, on the very next user message, then close — reminded, not nagged.
function takePending(sessionId, answerTurnId = null, { maxAgeMs = MAX_AGE_MS } = {}) {
  try {
    const rows = db.getPendingOpenQuestions(sessionId, { maxAgeMs, limit: 2 });
    if (rows.length) db.resolveOpenQuestions(sessionId, { answerTurnId, status: 'answered' });
    return rows;
  } catch (e) { console.error('[open_questions] takePending failed:', e.message); return []; }
}

// The labeled, high-recency prompt block. Placed at the user-message tail by context.js.
function buildBlock(rows, userName) {
  if (!rows || !rows.length) return null;
  const who = userName || 'Lucas';
  if (rows.length === 1) {
    return `[A moment ago you asked ${who}: "${rows[0].question}" — his message below is very likely his answer. Read it as the reply to YOUR question and respond to it as such; do NOT re-ask it or act as if you never asked.]`;
  }
  const lines = rows.map(r => `  • "${r.question}"`).join('\n');
  return `[A moment ago you asked ${who}:\n${lines}\nHis message below likely answers one of these. Connect it to what you asked; do NOT re-ask or act as if you never asked.]`;
}

module.exports = { extractQuestion, recordFromSay, takePending, buildBlock, MAX_AGE_MS };
