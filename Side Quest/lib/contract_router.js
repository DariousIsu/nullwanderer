/**
 * lib/contract_router.js — THE STEERING ROUTER (contract-agent slice 3, docs/CONTRACT_AGENT_SPEC_2026-08-22.md §8)
 * + THE YEA-MISROUTE CURE (conversation-quality audit #3, 2026-08-19).
 *
 * Two jobs, one comprehension principle: a user turn is read for WHAT IT DOES, not for its surface tokens.
 *
 * 1. affirmationLead(text): "Yea more details" is an affirmation + a continuation — the route must run
 *    on "more details", never on "yea" (live: "yea" became a vocabulary tangent about the parliamentary
 *    yes). A BARE affirmation returns rest:'' — the greenlight/offer arcs own those.
 *
 * 2. verdict(): binds a user turn to a RUNNING contract, in §8's order — repair (a fresh misroute is
 *    pulled back in one turn) → answer (an open question's reply, bare yes/no included) → status (read
 *    the store, never invent progress) → steering (instruction-shaped only; a question is never
 *    steering). Binding is exact-token (the civic discipline: no substrings) PLUS context: with exactly
 *    one live contract, an instruction binds on one token hit or a recent binding; with several, it
 *    takes ≥2 hits and a clear leader — ties CLARIFY, never guess. Pure; main.js owns the store writes,
 *    the directive injection, and the route override.
 */
'use strict';

const _AFFIRM_LEAD_RE = /^\s*(yes|yeah|yea|yep|yup|sure|ok(?:ay)?|absolutely|definitely|sounds good|got it)\b[\s,.!-]*/i;
function affirmationLead(text) {
  const s = String(text || '');
  const m = s.match(_AFFIRM_LEAD_RE);
  if (!m) return { lead: '', rest: '' };
  return { lead: m[1], rest: s.slice(m[0].length).trim() };
}

const _NEG_BARE_RE = /^\s*(?:no|nope|nah|negative)\b[\s.!,]*$/i;
const _QUESTION_SHAPE_RE = /\?\s*$|^\s*(?:what|who|when|where|why|how|is|are|does|do|did|can|could|will|would)\b/i;
const _STATUS_RE = /\b(?:where (?:are we|do we stand)|status|progress|how'?s\b[^.!?\n]*\b(?:going|coming(?: along)?)|any (?:update|movement)|how far along)\b/i;
const _INSTRUCTION_RE = /^\s*(?:add|include|drop|skip|cut|remove|swap|replace|use|focus|prioriti[sz]e|expand|widen|narrow|check|verify|double-?check|make sure|also|don'?t|do not|stop|hold off|instead|keep|extend|fold|weave|go (?:deeper|further)|dig (?:deeper|in)|more)\b|\b(?:add|include|also cover|make sure|instead of|rather than|focus on|don'?t forget|be sure to|fold (?:that|this|it) in)\b/i;
const _REPAIR_RE = /\b(?:no|nope|wrong|not that)\b[^.!?\n]*\bfor\b|\bthat (?:was|is) (?:for|meant for)\b|\bwrong (?:one|work|project|dig|contract)\b/i;
const REPAIR_WINDOW_MS = 5 * 60 * 1000;
const RECENT_BIND_MS = 30 * 60 * 1000;

const _STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'have', 'has', 'was', 'were', 'are', 'will', 'would', 'could', 'should', 'their', 'they', 'them', 'your', 'our', 'out', 'not', 'all', 'can', 'get', 'make', 'sure', 'also', 'just', 'more', 'some', 'than', 'then', 'when', 'what', 'which', 'how', 'why', 'who', 'where', 'been', 'being', 'over', 'under', 'after', 'before', 'work', 'project', 'dig', 'update', 'question', 'contract', 'please', 'thanks']);
function _toks(text, max = 12) {
  const out = [];
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []) {
    if (_STOP.has(w) || /^\d+$/.test(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}
function _contractToks(c) {
  const set = new Set();
  for (const t of c.topicTokens || []) set.add(String(t).toLowerCase());
  for (const e of c.entities || []) for (const w of _toks(e)) set.add(w);
  for (const w of _toks(c.title)) set.add(w);
  return set;
}

function verdict({ text, contracts = [], openQuestions = [], expiredQuestions = [], lastBinding = null, now = Date.now() } = {}) {
  const s = String(text || '').trim();
  if (!s || !contracts.length) return { kind: 'none' };
  // live may be EMPTY — status still reads closed contracts below; every other branch self-guards.
  const live = contracts.filter((c) => c.status === 'open' || c.status === 'waiting_answer');
  const titleOf = (id) => { const c = contracts.find((x) => x.contractId === id); return c ? c.title : id; };

  // 1. REPAIR — a correction inside the window pulls the last binding back; a named other contract rebinds.
  if (lastBinding && now - (lastBinding.ts || 0) <= REPAIR_WINDOW_MS && _REPAIR_RE.test(s)) {
    let target = null;
    for (const c of live) {
      if (c.contractId === lastBinding.contractId) continue;
      if (_toks(s).filter((t) => _contractToks(c).has(t)).length >= 1) target = target ? 'AMBIG' : c;
    }
    if (target === 'AMBIG') target = null;
    return { kind: 'repair', tombstoneId: lastBinding.inboxId || null, contractId: target ? target.contractId : null, title: target ? target.title : null, confidence: 0.8 };
  }

  const aff = affirmationLead(s);
  const bareAff = !!aff.lead && !aff.rest;
  const bareNeg = _NEG_BARE_RE.test(s);

  // 2. ANSWER — an open question owns bare yes/no outright; content answers bind by token overlap.
  if (openQuestions.length) {
    if (bareAff || bareNeg) {
      if (openQuestions.length === 1) {
        const q = openQuestions[0];
        return { kind: 'answer', questionId: q.questionId, contractId: q.contractId, title: titleOf(q.contractId), questionText: q.text, confidence: 0.85 };
      }
      return { kind: 'clarify', candidates: openQuestions.map((q) => ({ contractId: q.contractId, title: titleOf(q.contractId), questionText: q.text })), reason: 'bare-answer-many-questions', confidence: 0.5 };
    }
    const bt = _toks(aff.rest || s);
    let best = null, bestN = 0;
    for (const q of openQuestions) {
      const qt = new Set([..._toks(q.text), ..._toks((q.options || []).join(' ')), ..._toks(q.assumption || '')]);
      const n = bt.filter((t) => qt.has(t)).length;
      if (n > bestN || (n === bestN && n > 0 && best && (q.askedTs || 0) > (best.askedTs || 0))) { best = q; bestN = n; }
    }
    const need = aff.rest ? 1 : 2;   // an affirmation-led reply is already answer-shaped
    if (best && bestN >= need) return { kind: 'answer', questionId: best.questionId, contractId: best.contractId, title: titleOf(best.contractId), questionText: best.text, confidence: aff.rest ? 0.8 : 0.7 };
  }

  // 2b. LATE ANSWER (slice 4, §9): an expired question's answer still binds — the rework is scoped
  // to what the answer changes, downstream via reopenFromLateAnswer. Only a CONTENT answer binds:
  // a bare "yes"/"no" arriving after the window is settled history (the work already shipped on the
  // assumption), and a question- or status-shaped turn is asking ABOUT the work, never reworking it
  // — expired questions persist for the whole listRecent horizon, so the hijack guards are strict.
  if (expiredQuestions.length && !bareAff && !bareNeg && !_QUESTION_SHAPE_RE.test(s) && !_STATUS_RE.test(s)) {
    // THE ANCHOR REQUIREMENT (sprint H1 catch, 08-24 live: "check the parish office hours for the
    // school board meeting" — an errand — bound as the late answer to "is the school board figure
    // or the parish office figure the confirmation source?" on 4 generic topic-token hits and
    // REOPENED the slot). Reopening shipped work is a high-cost bind: the turn must also hit the
    // question's ANCHOR — its slot name or its offered options ("the teacher cell", "placeholders")
    // — the tokens that mark the turn as addressing THIS question rather than its neighborhood.
    // An anchorless question (no slot, no options) instead pays a raised overlap floor.
    const bt = _toks(aff.rest || s);
    let best = null, bestN = 0;
    for (const q of expiredQuestions) {
      const qt = new Set([..._toks(q.text), ..._toks((q.options || []).join(' ')), ..._toks(q.assumption || '')]);
      const n = bt.filter((t) => qt.has(t)).length;
      if (!n) continue;
      const anchor = new Set([..._toks(String(q.slotId || '').replace(/-/g, ' ')), ..._toks((q.options || []).join(' '))]);
      const qualifies = anchor.size ? bt.some((t) => anchor.has(t)) : n >= (aff.rest ? 2 : 3);
      if (!qualifies) continue;
      if (n > bestN || (n === bestN && best && (q.askedTs || 0) > (best.askedTs || 0))) { best = q; bestN = n; }
    }
    const need = aff.rest ? 1 : 2;
    if (best && bestN >= need) return { kind: 'answer', late: true, questionId: best.questionId, contractId: best.contractId, slotId: best.slotId || null, title: titleOf(best.contractId), questionText: best.text, confidence: aff.rest ? 0.75 : 0.65 };
  }

  // Exact-token hits per contract.
  const st = _toks(s);
  const scored = live.map((c) => ({ c, n: st.filter((t) => _contractToks(c).has(t)).length }));

  // 3. STATUS — a progress ask reads the store; it is never steering and never invention. Unlike
  // steering, status considers EVERY passed contract (closed included — "where are we" about work
  // that just finished deserves "done, here's what landed", not a doc-recall fallback; p119 finding).
  if (_STATUS_RE.test(s)) {
    const scoredAll = contracts.map((c) => ({ c, n: st.filter((t) => _contractToks(c).has(t)).length }));
    const hits = scoredAll.filter((x) => x.n >= 1).sort((a, b) => b.n - a.n);
    if (hits.length === 1 || (hits.length > 1 && hits[0].n > hits[1].n)) return { kind: 'status', contractId: hits[0].c.contractId, title: hits[0].c.title, confidence: 0.8 };
    if (hits.length > 1) return { kind: 'clarify', candidates: hits.map((h) => ({ contractId: h.c.contractId, title: h.c.title })), reason: 'status-ambiguous', confidence: 0.5 };
    if (live.length === 1) return { kind: 'status', contractId: live[0].contractId, title: live[0].title, confidence: 0.6 };
    return { kind: 'none' };
  }

  // 4. STEERING — instruction shape only; a question belongs to the recall/answer doors.
  if (_QUESTION_SHAPE_RE.test(s) || !_INSTRUCTION_RE.test((aff.rest || s))) return { kind: 'none' };
  const recentBind = lastBinding && now - (lastBinding.ts || 0) <= RECENT_BIND_MS ? lastBinding.contractId : null;
  if (live.length === 1) {
    // one live contract: a token hit OR fresh binding context carries it — but never zero signals,
    // or an unrelated order ("add milk to the grocery list") would hijack the contract.
    const n = scored[0].n;
    if (n >= 1 || recentBind === live[0].contractId) {
      return { kind: 'steering', contractId: live[0].contractId, title: live[0].title, confidence: Math.min(0.9, 0.55 + n * 0.15 + (recentBind ? 0.15 : 0)) };
    }
    return { kind: 'none' };
  }
  const hits = scored.filter((x) => x.n >= 2).sort((a, b) => b.n - a.n);
  if (!hits.length) {
    // no strong token bind among several contracts — fresh binding context may still carry it
    if (recentBind && scored.some((x) => x.c.contractId === recentBind && x.n >= 1)) {
      const c = live.find((x) => x.contractId === recentBind);
      return { kind: 'steering', contractId: c.contractId, title: c.title, confidence: 0.6 };
    }
    return { kind: 'none' };
  }
  if (hits.length === 1 || hits[0].n > hits[1].n) {
    return { kind: 'steering', contractId: hits[0].c.contractId, title: hits[0].c.title, confidence: Math.min(0.95, 0.6 + hits[0].n * 0.1) };
  }
  return { kind: 'clarify', candidates: hits.map((h) => ({ contractId: h.c.contractId, title: h.c.title })), reason: 'steering-ambiguous', confidence: 0.5 };
}

module.exports = { affirmationLead, verdict, _toks, _AFFIRM_LEAD_RE, REPAIR_WINDOW_MS, RECENT_BIND_MS };
