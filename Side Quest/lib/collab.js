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

const _COLLAB_RE = /\b(?:brainstorm(?:ing)?|spitball(?:ing)?|riff(?:ing)? (?:on|with)|kick(?:ing)? (?:some )?ideas? around|bounce (?:some )?(?:ideas?|this|thoughts?) (?:off|around|back)|workshop(?:ping)? (?:this|the|it|my)|i need ideas?|give me (?:some )?ideas?|help me (?:come up with|think through|figure out|shape|sharpen)|what do you think|what are your thoughts|your (?:thoughts|read|take) on|thoughts on (?:this|the|my|that)|feedback on|give me feedback|weigh in on|talk (?:this|it|me) through|think (?:this|it) through with me|let'?s think|sanity.check (?:this|my)|poke holes in|react to (?:this|my)|do you remember|you remember\b|remember (?:when|that|what|how|the)\b|remember(?=\s*\?)|ring (?:a|any) bells?|you know what i'?m talking about)\b/i;
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

const _STOP = new Set(['this', 'that', 'with', 'have', 'from', 'into', 'what', 'your', 'them', 'then', 'they', 'were', 'when', 'need', 'some', 'ideas', 'idea', 'help', 'come', 'think', 'through', 'about', 'more', 'here', 'there', 'want', 'going', 'just', 'like', 'work', 'working', 'feedback', 'thoughts', 'brainstorm', 'brainstorming', 'whose', 'name', 'which', 'down', 'know', 'tell', 'does', 'been', 'verified', 'records', 'record', 'tracked', 'pinned', 'landed', 'remind', 'pull', 'latest', 'hold', 'give']);
// A bill-number-shaped token ("sb200", "hb1234", "ssb1683") — an identifier, never a word stem.
const _BILLNUM_RE = /^[a-z]{1,4}\d{1,5}$/;
function _terms(text, max = 6) {
  const out = [];
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []) {
    if (_STOP.has(w) || /^\d+$/.test(w) || out.includes(w)) continue;
    out.push(w);
  }
  // Distinctiveness order: digit-bearing tokens (bill numbers) first, then longer words — so the
  // bounded LIKE fallback's top-two picks are the question's real subject, not its scaffold.
  out.sort((a, b) => (/\d/.test(b) ? 1 : 0) - (/\d/.test(a) ? 1 : 0) || b.length - a.length);
  return out.slice(0, max);
}

/** The accreted-context pull. Bounded (~2200 chars), read-only, fail-empty.
 *  Sources, in priority order:
 *   1. docs NAMED in this session's recent turns ("doc#17787" — the live thread's document);
 *   2. top held documents matching the turn's + the thread-ask's terms (documents_fts, bm25).
 *  mode 'collab' (default) frames for thinking-together; mode 'recall' (held-source homecoming,
 *  the run-8 residual) frames for ANSWERING FROM the held documents — and because the injection
 *  rides the composed message, it also becomes the anti-fab verifier's evidence: the same pull
 *  that enables the right answer grounds the gate that checks it. */
function groundingBlock({ sessionId, text = '', mode = 'collab', _notesDir = null, _canvasStore = null } = {}) {
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
    // INSTANCE DISCIPLINE (campaign §21a, 08-22): a bill-number token is an IDENTIFIER, not a
    // stem — the 2018 Louisiana "SB200" (Hewitt) rode prefix/substring widening into every 2026
    // anti-china SB200 ask. Bill numbers match as EXACT fts tokens (never sb200* ⊇ sb2000, never
    // sb20 ⊆ sb200 via LIKE), the substring fallback boundary-checks them, and the fan is RANKED
    // by the thread's other terms so the thread's own instance dominates a same-numbered stranger.
    const billToks = terms.filter((t) => _BILLNUM_RE.test(t));
    const otherToks = terms.filter((t) => !_BILLNUM_RE.test(t));
    // 2a. THE HELD-SOURCE HOMECOMING (the run-8/blind-week root, cured 08-22): a hand-built notes
    //     deliverable often IS the answer — the sponsors sheet held the full SB200 roster while the
    //     fan searched only doc rows and honest-missed ("our records don't list any co-sponsors").
    //     Bounded top-level scan of notes/*.md (filename+content term match; bill numbers exact-
    //     token, double-weighted); the excerpt cuts AROUND the strongest match so a big sheet
    //     surfaces its relevant row, never just its header. notes/_test_residue is a SUBDIRECTORY
    //     → naturally excluded (top-level .md files only). Outranks doc-store matches.
    if (terms.length >= 2 && parts.length < 3) {
      try {
        const fs2 = require('fs'), p2 = require('path');
        const dir = _notesDir || require('./files').resolvePath('notes');
        const names = fs2.existsSync(dir) ? fs2.readdirSync(dir).filter((n) => n.endsWith('.md')).slice(0, 300) : [];
        let best = null, bestScore = 0;
        for (const n of names) {
          const fp = p2.join(dir, n);
          let body = '';
          try { if (!fs2.statSync(fp).isFile() || fs2.statSync(fp).size > 300 * 1024) continue; body = fs2.readFileSync(fp, 'utf8'); } catch { continue; }
          const hay = `${n}\n${body}`.toLowerCase();
          let score = 0;
          for (const t2 of otherToks) if (hay.includes(t2)) score++;
          for (const bt of billToks) if (new RegExp(`\\b${bt}\\b`, 'i').test(hay)) score += 2;
          if (score > bestScore) { bestScore = score; best = { n, body }; }
        }
        if (best && bestScore >= 2) {
          let at = -1;
          for (const bt of billToks) { const m2 = best.body.match(new RegExp(`\\b${bt}\\b`, 'i')); if (m2) { at = m2.index; break; } }
          if (at < 0) { const hayL = best.body.toLowerCase(); for (const t2 of otherToks) { const i2 = hayL.indexOf(t2); if (i2 > -1) { at = i2; break; } } }
          const from = Math.max(0, at - 80);
          const ex = best.body.slice(from, from + 560).replace(/\s+/g, ' ').trim();
          parts.push(`- notes/${best.n} (a deliverable YOU built — often the answer itself): ${ex}…`);
        }
      } catch {}
    }
    // 2b. THE CANVAS HOMECOMING (contract-agent slice 0, 08-22): her canvas + directed-thread work
    //     was store-invisible — live-proven when an external session searched "Delta Forge" and
    //     honest-missed while the community_benefits_la compilation sat in canvas_docs. Same
    //     discipline as 2a: term match over title+body (bill numbers exact-token, double-weighted),
    //     excerpt cut AROUND the strongest match. ILLUSTRATIVE tabs (art) never ground an answer.
    if (terms.length >= 2 && parts.length < 3) {
      try {
        const cs = _canvasStore || require('./canvas_docs');
        let best = null, bestScore = 0;
        for (const t3 of cs.listDocs({ limit: 60 })) {
          if (String(t3.mode || '').toUpperCase() === 'ILLUSTRATIVE') continue;
          const body = cs.docText(t3.tabKey);
          if (!body) continue;
          const hay = `${t3.title || ''}\n${body}`.toLowerCase();
          let score = 0;
          for (const t2 of otherToks) if (hay.includes(t2)) score++;
          for (const bt of billToks) if (new RegExp(`\\b${bt}\\b`, 'i').test(hay)) score += 2;
          if (score > bestScore) { bestScore = score; best = { tab: t3, body }; }
        }
        if (best && bestScore >= 2) {
          const hayFull = `${best.tab.title || ''}\n${best.body}`;
          let at = -1;
          for (const bt of billToks) { const m2 = hayFull.match(new RegExp(`\\b${bt}\\b`, 'i')); if (m2) { at = m2.index; break; } }
          if (at < 0) { const hayL = hayFull.toLowerCase(); for (const t2 of otherToks) { const i2 = hayL.indexOf(t2); if (i2 > -1) { at = i2; break; } } }
          const from = Math.max(0, at - 80);
          const ex = hayFull.slice(from, from + 560).replace(/\s+/g, ' ').trim();
          parts.push(`- canvas "${String(best.tab.title || best.tab.tabKey).slice(0, 80)}" (tab ${best.tab.tabKey} — a doc on YOUR canvas): ${ex}…`);
        }
      } catch {}
    }
    if (terms.length >= 2 && parts.length < 3) {
      let rows = [];
      try {
        rows = d.getDb().prepare(
          `SELECT d2.id, d2.title, d2.body FROM documents_fts f JOIN documents d2 ON d2.id = f.rowid WHERE documents_fts MATCH ? ORDER BY bm25(documents_fts) LIMIT 4`
        ).all(terms.map((t) => (_BILLNUM_RE.test(t) ? `"${t}"` : `${t}*`)).join(' OR '));
      } catch { rows = []; }
      if (!rows.length) {
        // The fts index backfills on a tick — a JUST-ingested doc (or a fresh store) is not in it
        // yet. Bounded LIKE fallback on the two strongest terms (heldContext's proven degradation).
        try {
          const [a, b] = terms;
          rows = d.getDb().prepare(
            `SELECT id, title, body FROM documents WHERE (title LIKE ? OR body LIKE ?)${b ? ' AND (title LIKE ? OR body LIKE ?)' : ''} ORDER BY id DESC LIMIT 4`
          ).all(...(b ? [`%${a}%`, `%${a}%`, `%${b}%`, `%${b}%`] : [`%${a}%`, `%${a}%`]));
        } catch { rows = []; }
        // Boundary discipline on the substring path: a row that rode in on a bill-number LIKE must
        // hold that number as a WHOLE token, or genuinely match a non-bill term.
        if (billToks.length) {
          rows = rows.filter((r) => {
            const hay = `${r.title || ''} ${r.body || ''}`;
            return billToks.some((bt) => new RegExp(`\\b${bt}\\b`, 'i').test(hay)) || otherToks.some((ot) => hay.toLowerCase().includes(ot));
          });
        }
      }
      // The thread's instance dominates the fan: rank by how many non-bill thread terms each row
      // holds (the 2026 sheet carries "china"/"surveillance"; the 2018 stranger doesn't). Stable.
      if (otherToks.length && rows.length > 1) {
        const inst = (r) => { const hay = `${r.title || ''} ${r.body || ''}`.toLowerCase(); return otherToks.reduce((n, t2) => n + (hay.includes(t2) ? 1 : 0), 0); };
        rows = rows.map((r, i) => ({ r, i, s: inst(r) })).sort((x, y) => y.s - x.s || x.i - y.i).map((x) => x.r);
      }
      for (const r of rows) addDoc(r, 'held, matches this thread');
    }
    if (!parts.length) return null;
    if (mode === 'recall') {
      return `[HELD-SOURCE CONTEXT (measured — these held documents match this question):\n${parts.join('\n')}\nAnswer FROM these documents and cite them by doc# or file path. If they do not contain the answer, say so honestly — NEVER fill the gap from training data or from other recent subjects.]`;
    }
    return `[COLLAB GROUNDING (measured, from the held stores — think WITH this, cite it by name):\n${parts.join('\n')}]`;
  } catch { return null; }
}

module.exports = { isCollabTurn, artifactsAllowed, directive, groundingBlock, _COLLAB_RE };
