'use strict';
/* lib/collab.js — THE COLLABORATION REGISTER (blind-week catch #1, 2026-08-20 night).
 *
 * The live failure (Lucas's op-ed session): feedback/brainstorm turns — "help me come up with some
 * ideas", "We're brainstorming here, I need ideas" — routed task/lookup, drew "Let me get that
 * going", and DELIVERED ARTIFACTS instead of thinking. The campaign hardened the order machinery
 * until it swallowed the thinking-partner register. This module is the register's door:
 *   isCollabTurn(text)      — the turn is thinking-together, not an order.
 *   artifactsAllowed(text)  — the SAME turn explicitly names an artifact destination, so canvas/
 *                             file production stays allowed (the carve-out).
 *   directive()             — the say-side register pin (ideas IN the reply, no deliverables).
 *   groundingBlock(...)     — the accreted-context pull: the session's named docs + the top held
 *                             documents matching the turn+thread terms (documents_fts, the proven
 *                             ~1ms path), excerpted. "The living database at her fingertips" —
 *                             surfacing as conversation, not as a lookup product.
 * Everything fails OPEN: a throw anywhere = the turn proceeds exactly as before this module.
 */
const db = () => require('./db');

const _COLLAB_RE = /\b(?:brainstorm(?:ing)?|spitball(?:ing)?|riff(?:ing)? (?:on|with)|kick(?:ing)? (?:some )?ideas? around|bounce (?:some )?(?:ideas?|this|thoughts?) (?:off|around|back)|workshop(?:ping)? (?:this|the|it|my)|i need ideas?|give me (?:some )?ideas?|help me (?:come up with|think through|figure out|shape|sharpen)|what do you think|what are your thoughts|your (?:thoughts|read|take) on|thoughts on (?:this|the|my|that)|feedback on|give me feedback|weigh in on|talk (?:this|it|me) through|think (?:this|it) through with me|let'?s think|sanity.check (?:this|my)|poke holes in|react to (?:this|my))\b/i;
function isCollabTurn(text) {
  const t = String(text || '');
  if (t.trim().length < 8) return false;
  return _COLLAB_RE.test(t);
}

// The carve-out: a collab turn that EXPLICITLY names an artifact destination keeps production
// allowed ("brainstorm names and put the list on the canvas"). Absent this, a collab turn
// suppresses the artifact-router, canvas-cmd creation, and the order-booking backstop.
const _ARTIFACT_OK_RE = /\b(?:on (?:the|your|my) canvas|to the canvas|make (?:me )?a (?:doc|document|file|list on)|save (?:it|this|that|them)|write (?:it|this|that) up as|land (?:it|this|that)|put (?:it|this|that|them) in (?:a|the|notes)|drop (?:it|this|that) (?:in|into|on))\b/i;
function artifactsAllowed(text) { return _ARTIFACT_OK_RE.test(String(text || '')); }

// The say-side register pin. Injected into the composed message on every collab turn.
function directive() {
  return '[COLLABORATION REGISTER: this turn is THINKING TOGETHER, not a work order. Your ideas, reactions, and connections go IN THIS REPLY — concrete, specific, grounded in the held material below (cite it by name), and positioned so he can bounce them back. Give real substance: angles, framings, connections between his documents, disagreements. Do NOT create or edit any artifact, do NOT say "let me get that going" or "it\'s on your canvas", do NOT convert this into a deliverable or book work — unless he explicitly named a destination this turn. Conversation IS the deliverable.]';
}

const _STOP = new Set(['this', 'that', 'with', 'have', 'from', 'into', 'what', 'your', 'them', 'then', 'they', 'were', 'when', 'need', 'some', 'ideas', 'idea', 'help', 'come', 'think', 'through', 'about', 'more', 'here', 'there', 'want', 'going', 'just', 'like', 'work', 'working', 'feedback', 'thoughts', 'brainstorm', 'brainstorming']);
function _terms(text, max = 6) {
  const out = [];
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []) {
    if (_STOP.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/** The accreted-context pull for a collab turn. Bounded (~2200 chars), read-only, fail-empty.
 *  Sources, in priority order:
 *   1. docs NAMED in this session's recent turns ("doc#17787" — the live thread's document);
 *   2. top held documents matching the turn's + the thread-ask's terms (documents_fts, bm25). */
function groundingBlock({ sessionId, text = '' } = {}) {
  try {
    const d = db();
    const parts = [];
    const seen = new Set();
    const addDoc = (row, why) => {
      if (!row || seen.has(row.id) || parts.length >= 3) return;
      seen.add(row.id);
      const body = String(row.body || '').replace(/\s+/g, ' ').trim();
      parts.push(`- doc#${row.id} "${String(row.title || '(untitled)').slice(0, 80)}" (${why}): ${body.slice(0, 420)}…`);
    };
    // 1. session-named docs — the live thread's own material outranks every search hit.
    if (sessionId) {
      try {
        const turns = d.getDb().prepare('SELECT content FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT 24').all(sessionId);
        const ids = [];
        for (const t of turns) for (const m of String(t.content || '').matchAll(/doc#(\d{1,8})\b/g)) { const id = parseInt(m[1], 10); if (!ids.includes(id)) ids.push(id); }
        for (const id of ids.slice(0, 2)) addDoc(d.getDb().prepare('SELECT id, title, body FROM documents WHERE id = ?').get(id), 'the live thread’s doc');
      } catch {}
    }
    // 2. held-document search on the turn + thread terms.
    let ask = '';
    try { const ts = require('./answer_cache').threadState({ sessionId }); if (ts) ask = ts.ask || ''; } catch {}
    const terms = _terms(`${text} ${ask}`, 6);
    if (terms.length >= 2 && parts.length < 3) {
      try {
        const rows = d.getDb().prepare(
          `SELECT d2.id, d2.title, d2.body FROM documents_fts f JOIN documents d2 ON d2.id = f.rowid WHERE documents_fts MATCH ? ORDER BY bm25(documents_fts) LIMIT 4`
        ).all(terms.map((t) => `${t}*`).join(' OR '));
        for (const r of rows) addDoc(r, 'held, matches this thread');
      } catch {}
    }
    if (!parts.length) return null;
    return `[COLLAB GROUNDING (measured, from the held stores — think WITH this, cite it by name):\n${parts.join('\n')}]`;
  } catch { return null; }
}

module.exports = { isCollabTurn, artifactsAllowed, directive, groundingBlock, _COLLAB_RE };
