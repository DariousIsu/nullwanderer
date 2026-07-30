/**
 * lib/user_work.js — HIS WORK OUTRANKS THE SWEEP (Lucas 2026-07-30).
 *
 * Measured that morning: 8 user-origin research threads sat `pending` with action_count 0 —
 * the grid/data-center memo cluster, robot-control, Louisiana deep-research — while the
 * state-map fallback owned every idle window. The scheduler only protected a user focus that
 * already HELD the primary slot; nothing ever promoted an unstarted user thread INTO it. His
 * projects and the sweep weren't competing — only the sweep's queue had a driver.
 *
 * This module is the pure brain of the user-thread driver:
 *   - isResearchShaped:   which pending threads qualify as seedable research runs
 *   - parseDeadline:      "within an hour" vs "you have 6 hours" → dueTs + kind, anchored to
 *                         the thread's BIRTH (re-anchoring to now() would never expire)
 *   - matchNewsToThread:  working-topic news vigilance — related headlines matched to a live
 *                         story/paper so the work stays current
 *   - pickUserThread:     the ordering — deadline urgency > news heat > RECENCY (his newest
 *                         ask is usually the live one)
 *   - augmentGuidance:    the per-pass addenda (related news + deadline pacing)
 *
 * main.js owns the I/O: seeding/preemption in the autonomic tick (a seeded thread is a USER
 * focus — full cadence, browser-owning, never idle-tiered), news stamping in the maintenance
 * sweep, and the guidance splice in the directed pass.
 */
'use strict';

const RESEARCH_RE = /\b(research|substantiate|identify|compile|investigate|verify|map(?:ping)?|gather|analy[sz]e|understand|deep[- ]?dive|document|catalog(?:ue)?|trace|survey)\b/i;

// A seedable research thread: enough words to be a task, a research-shaped verb, and not a
// pure conversational commitment. Deliberately conservative — a miss stays a pending thread
// (visible, unharmed); a false seed steals the primary from real work.
function isResearchShaped(content) {
  const c = String(content || '').trim();
  if (c.split(/\s+/).length < 4) return false;
  return RESEARCH_RE.test(c);
}

// Deadline language → { dueTs, kind: 'rush' | 'today' | 'open' } or null (no deadline named).
// `anchorTs` is the thread's created_ts — "within an hour" means an hour from when he SAID it.
function parseDeadline(text, anchorTs) {
  const t = String(text || '').toLowerCase();
  const a = Number(anchorTs) || 0;
  if (!a) return null;
  let m;
  if (/\basap\b|\bright away\b|\bimmediately\b|\burgent(?:ly)?\b/.test(t)) return { dueTs: a + 30 * 60e3, kind: 'rush' };
  if ((m = t.match(/\bwithin (?:the next )?(\d+)\s*min(?:ute)?s?\b/))) return { dueTs: a + parseInt(m[1], 10) * 60e3, kind: 'rush' };
  if ((m = t.match(/\b(?:within|in|next|have(?: the next)?) (?:the next )?(an?|\d+)\s*(?:hour|hr)s?\b/))) {
    const n = /^a/.test(m[1]) ? 1 : parseInt(m[1], 10);
    return { dueTs: a + n * 3600e3, kind: n <= 2 ? 'rush' : 'today' };
  }
  if (/\bby (?:the )?end of (?:the )?day\b|\bby tonight\b|\bby eod\b/.test(t)) return { dueTs: a + 10 * 3600e3, kind: 'today' };
  if (/\bby (?:tomorrow|the morning)\b|\btomorrow morning\b/.test(t)) return { dueTs: a + 20 * 3600e3, kind: 'open' };
  if (/\bno rush\b|\bno hurry\b|\bwhenever\b/.test(t)) return { dueTs: null, kind: 'open' };
  return null;
}

// Working-topic news vigilance: match recent headlines to a thread's content by token overlap.
// ≥2 distinct content-token hits — one shared word ("grid") is coincidence, two is a topic.
// Work-shape and time-filler words are NOT topics (boot122 first-fire: "…over coming weeks"
// matched 3 unrelated stories on "coming"+"weeks" — ordinary news prose — and the false heat
// would have outranked his real grid cluster at the next pick).
const _STOP = new Set(['research', 'substantiate', 'identify', 'compile', 'investigate', 'verify', 'gather', 'understand', 'document', 'catalog', 'survey', 'trace', 'analyze', 'analyse', 'that', 'this', 'with', 'from', 'into', 'onto', 'about', 'their', 'each', 'every', 'lucas', 'help', 'find', 'right', 'needs', 'need', 'cases', 'where', 'would', 'could', 'should', 'been', 'have', 'more', 'most', 'what', 'when', 'were', 'will', 'coming', 'weeks', 'week', 'days', 'months', 'years', 'over', 'next', 'upcoming', 'topic', 'topics', 'provided', 'write', 'writing', 'written', 'report', 'reports', 'story', 'stories', 'paper', 'papers', 'draft', 'memo']);
function threadTokens(content) {
  return new Set(String(content || '').toLowerCase().match(/[a-z][a-z0-9-]{3,}/g)?.filter((w) => !_STOP.has(w)) || []);
}
function matchNewsToThread(content, headlines) {
  const toks = threadTokens(content);
  if (toks.size < 2) return [];
  const out = [];
  for (const h of (Array.isArray(headlines) ? headlines : [])) {
    const text = `${(h && h.title) || ''} ${(h && h.summary) || ''}`.toLowerCase();
    if (!text.trim()) continue;
    let hits = 0;
    for (const t of toks) { if (text.includes(t)) { hits++; if (hits >= 2) break; } }
    if (hits >= 2) out.push({ title: String(h.title || '').slice(0, 140), summary: String(h.summary || '').slice(0, 200) });
    if (out.length >= 5) break;
  }
  return out;
}

// The ordering. Deadline urgency dominates (overdue > rush > today), then news heat (a working
// topic in the news is hot for ~24h), then RECENCY — his newest ask wins ties.
function scoreThread(t, { now = 0, newsAt = 0 } = {}) {
  let s = 0;
  const dl = parseDeadline(t.content, t.created_ts);
  if (dl && dl.dueTs) {
    const left = dl.dueTs - now;
    s += left <= 0 ? 1000 : left < 2 * 3600e3 ? 800 : left < 8 * 3600e3 ? 400 : 150;
  }
  if (newsAt && now - newsAt < 24 * 3600e3) s += 200 * (1 - (now - newsAt) / (24 * 3600e3));
  const ageH = Math.max(0, now - (t.created_ts || 0)) / 3600e3;
  s += Math.max(0, 100 - Math.min(100, ageH));   // newest ask carries up to +100, fading over ~4 days
  return s;
}

// Pick the user thread the primary should run next: pending, never-driven, research-shaped,
// not beat-tagged (the caller filters beat tags — it has the meta). Null = nothing qualifies →
// the sweep may have the slot.
function pickUserThread(threads, { now = 0, newsAtOf = () => 0 } = {}) {
  let best = null, bestScore = -1;
  for (const t of (Array.isArray(threads) ? threads : [])) {
    if (!t || t.status !== 'pending' || (t.action_count | 0) !== 0) continue;
    if (!isResearchShaped(t.content)) continue;
    const s = scoreThread(t, { now, newsAt: newsAtOf(t.id) || 0 });
    if (s > bestScore || (s === bestScore && (t.created_ts || 0) > ((best && best.created_ts) || 0))) { best = t; bestScore = s; }
  }
  return best;
}

// THE LIVING DOCUMENT (Lucas 2026-07-30: "a concept built as an actionable living document —
// the task bounces off that document over time"): match a new research thread to an EXISTING
// landed research doc so the run CONTINUES it instead of restarting at zero. Same 2-token topic
// rule as news vigilance (one shared word is coincidence, two is a topic); research-source docs
// only; newest wins ties. Null = genuinely new ground → a fresh document is right.
function matchDocToTopic(topic, docs) {
  const toks = threadTokens(topic);
  if (toks.size < 2) return null;
  let best = null, bestHits = 0;
  for (const d of (Array.isArray(docs) ? docs : [])) {
    if (!d || (d.source && d.source !== 'research')) continue;
    const text = `${d.title || ''} ${String(d.markdown || '').slice(0, 4000)}`.toLowerCase();
    let hits = 0;
    for (const t of toks) { if (text.includes(t)) hits++; }
    if (hits < 2) continue;
    if (hits > bestHits || (hits === bestHits && (d.openedAt || 0) > ((best && best.openedAt) || 0))) { best = d; bestHits = hits; }
  }
  return best;
}

// The living-document CANDIDATE POOL. The recency window alone starves the anchor — measured on
// boot128, the newest-40 docs were 100% news/inquiry/browser_download and the 15k grid dossier
// (two days old) could never match, so #3617 seeded blind. Union the recency window with
// per-token recall over the WHOLE store; searchDocuments is whole-string LIKE, so recall must
// ride one token at a time, never the full sentence.
function docPoolForTopic(topic, { candidates = () => [], recall = () => [] } = {}) {
  const pool = [].concat(candidates(40) || []);
  for (const t of [...threadTokens(topic)].slice(0, 8)) pool.push(...(recall(t, 8) || []));
  return pool;
}

// PARK-LANDING: a stopped or preempted user run must still enter the living-document pool.
// Only the condense path (run COMPLETION) landed the deliverable, and his biggest research is
// exactly the kind that gets stopped mid-flight — directed-3618 accreted 15k across days of
// passes and was invisible to the next seed. Beat foci re-derive from the sweep and stay out.
// land() is idempotent on ref+body, so repeated stops of an unchanged deliverable are free.
function parkDeliverable({ focusId, reason = 'parked', readFile = () => null, getMeta = () => null, getThread = () => null, land = () => null } = {}) {
  if (!focusId) return null;
  if (String(getMeta(`focus.${focusId}.beat`) || '').trim()) return null;
  const r = readFile(`notes/directed-${focusId}.md`);
  const body = (r && r.text) || '';
  if (String(body).trim().length < 400) return null;   // a header-only shell isn't a living document
  let goal = ''; try { const t = getThread(focusId); goal = (t && t.content) || ''; } catch { /* title falls back below */ }
  const dl = land({ title: `Research — ${String(goal || `directed run #${focusId}`).slice(0, 100)}`, body, source: 'research', ref: `directed-${focusId}`, understanding: String(goal).slice(0, 300) });
  return (dl && dl.landed) ? { id: dl.id, reason } : null;
}

// Per-pass guidance addenda: related news (so the working story stays current) + deadline pacing
// (an hour left means ASSEMBLE, six hours means depth that finishes inside the window).
function augmentGuidance(guidance, { focusId, content, createdTs, getMeta = () => null, now = 0 } = {}) {
  const parts = [String(guidance || '').trim()];
  try {
    const news = JSON.parse(getMeta(`thread.${focusId}.news_recent`) || '[]') || [];
    if (news.length) {
      parts.push('RELATED NEWS (working-topic vigilance — fold anything that changes the picture into THIS pass, and cite the story):\n'
        + news.slice(0, 5).map((h) => `- ${h.title}`).join('\n'));
    }
  } catch { /* vigilance is additive, never blocking */ }
  const dl = parseDeadline(content, createdTs);
  if (dl && dl.dueTs) {
    const mins = Math.round((dl.dueTs - now) / 60000);
    if (mins <= 0) parts.push('DEADLINE: PASSED — stop hunting. Assemble the best available answer NOW from what is gathered; name the gaps plainly.');
    else if (dl.kind === 'rush') parts.push(`DEADLINE: ~${mins} minutes left — ASSEMBLE the best available answer; cite what you have, name what's missing, do NOT keep hunting for perfection.`);
    else parts.push(`DEADLINE: about ${Math.max(1, Math.round(mins / 60))}h left — pace the depth to finish INSIDE the window with a complete draft.`);
  }
  return parts.filter(Boolean).join('\n\n');
}

// REDIRECT DETECTION (turn 10275, 2026-07-30: "I would honestly rather have you focus on the
// China AI and materials research" → she SAID "I'm pivoting focus" and NOTHING registered — no
// thread, no park; the driver rolled on. The pivot must be CODE, not a promise). Conservative
// by design (the directives over-capture warning): preference/imperative shapes only — a
// question never fires, and bare "work on" never fires (direction grid: HIS work is not a
// redirect of HERS).
const _REDIRECT_RES = [
  /\bi(?:'d| would)(?: honestly| really)? rather (?:have you |you )?(?:focus|work) on\s+(.{4,140}?)(?:\s+(?:instead|for now|next))?[.!]?\s*$/i,
  /(?:^|[.!?]\s+)(?:please\s+)?(?:focus on|switch to|pivot to|prioriti[sz]e)\s+(.{4,140}?)(?:\s+(?:instead|for now|next))?[.!]?\s*$/i,
  /\blet'?s focus on\s+(.{4,140}?)(?:\s+(?:instead|for now|next))?[.!]?\s*$/i,
];
function detectRedirect(message) {
  const t = String(message || '').trim();
  if (!t || /\?\s*$/.test(t)) return null;                              // a question is not a redirect
  for (const re of _REDIRECT_RES) {
    const m = re.exec(t);
    if (m) {
      const topic = m[1].replace(/^(?:the\s+)+/i, '').replace(/\s+/g, ' ').trim();
      if (topic.length >= 4 && !/^(it|that|this|them|him|her)$/i.test(topic)) return { topic };
    }
  }
  return null;
}

// THE CLASSIFIER IS PRIMARY, THE REGEX IS FALLBACK (detectors-vs-comprehension, proven AGAIN the
// same hour the regex shipped: "pivot your attention to the AI…", "move to the china research",
// "Complete any research related to China first" — three real steering phrasings, zero fired.
// Enumerating surface forms fails identically in JavaScript or English; the prompt states the
// DISTINCTION). Wide cheap trigger → cloud classify → regex only when the cloud is unreachable.
const REDIRECT_TRIGGER_RE = /\b(pivot|shift|switch|move|focus|prioriti[sz]e|rather|instead|first|concentrate|complete|finish)\b/i;
function buildRedirectAsk(message) {
  return {
    task: 'redirect_intent', v: 1, think: false,
    input: { message: String(message || '').slice(0, 800) },
    want: `Lucas is talking to his research assistant, who has a live working focus. Decide: is he STEERING WHAT SHE WORKS ON — changing or ordering HER research/working focus? ANY phrasing counts ("pivot your attention to X", "move to the X research", "complete X first", "I'd rather you focus on X", "switch to X"). It is NOT steering when he asks a question, plans HIS OWN work ("I'll work on the deck"), or narrates the past.
Reply ONLY: {"redirect": true|false, "immediate": true|false, "topic": "<the work he steered her toward, in his words — empty when redirect is false>"}
immediate=true when the new topic should take over NOW; immediate=false when he queued it AFTER current work ("finish Y first, then X").`,
    validate: (raw) => {
      try {
        const m = String(raw || '').match(/\{[\s\S]*\}/);
        if (!m) return { valid: false, error: 'no JSON object' };
        const o = JSON.parse(m[0]);
        if (typeof o.redirect !== 'boolean') return { valid: false, error: 'redirect must be true|false' };
        const topic = String(o.topic || '').replace(/\s+/g, ' ').trim().replace(/^(?:the\s+)+/i, '').slice(0, 140);
        if (o.redirect && topic.length < 4) return { valid: false, error: 'a redirect needs a real topic' };
        return { valid: true, value: { redirect: o.redirect, immediate: o.immediate !== false, topic } };
      } catch (e) { return { valid: false, error: e.message }; }
    },
  };
}

// Match a redirect topic to an EXISTING thread (any live status — an already-driven thread can
// be re-promoted) by the same 2-token topic rule as news vigilance. Null = genuinely new topic.
function matchThreadToTopic(topic, threads) {
  const toks = threadTokens(topic);
  if (toks.size < 1) return null;
  let best = null, bestHits = 0;
  for (const t of (Array.isArray(threads) ? threads : [])) {
    const tt = threadTokens(t && t.content);
    let hits = 0;
    for (const w of tt) if (toks.has(w)) hits++;
    if (hits >= 2 && (hits > bestHits || (hits === bestHits && (t.created_ts || 0) > ((best && best.created_ts) || 0)))) { best = t; bestHits = hits; }
  }
  return best;
}

// DEFERRED-AGENDA CAPTURE (chat audit 10278/10280, 2026-07-30: "Save that elections news for
// next week's Rainey team meeting" → she said "saved / will be on the agenda" and NOTHING
// registered — no note, no task, no track. A hold-for-later ask must become a REAL row on her
// own clock. Classifier-primary, same contract as the redirect; the recent turns ride the input
// so "that" resolves to what was actually being discussed.
const AGENDA_TRIGGER_RE = /\b(remind|agenda|meeting|next (?:week|month)|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|save (?:that|this|it)|bring (?:that|this|it|up)|keep (?:that|this|it)|flag (?:that|this|it)|later)\b/i;
function buildAgendaAsk(message, context = '') {
  return {
    task: 'agenda_intent', v: 1, think: false,
    input: { message: String(message || '').slice(0, 800), recent_turns: String(context || '').slice(0, 900) },
    want: `Lucas is talking to his research assistant. Decide: is he asking her to HOLD something for a FUTURE moment — save/bring up/remind/flag an item for a later meeting, day, or event? It is NOT a hold when he asks a question, gives an immediate task, or just mentions a meeting in passing.
Reply ONLY: {"defer": true|false, "item": "<WHAT to hold, resolved from the recent turns — a concrete phrase, not 'that'>", "when": "<his words for when>", "days": <estimated days from now until it's needed, e.g. 7 for next week>}
When defer is false, item/when may be empty and days 0.`,
    validate: (raw) => {
      try {
        const m = String(raw || '').match(/\{[\s\S]*\}/);
        if (!m) return { valid: false, error: 'no JSON object' };
        const o = JSON.parse(m[0]);
        if (typeof o.defer !== 'boolean') return { valid: false, error: 'defer must be true|false' };
        const item = String(o.item || '').replace(/\s+/g, ' ').trim().slice(0, 240);
        if (o.defer && (item.length < 6 || /^that\b/i.test(item))) return { valid: false, error: 'a hold needs a CONCRETE item (resolve "that" from the recent turns)' };
        const days = Number(o.days);
        return { valid: true, value: { defer: o.defer, item, whenText: String(o.when || '').slice(0, 80), days: isFinite(days) ? days : 7 } };
      } catch (e) { return { valid: false, error: e.message }; }
    },
  };
}

module.exports = { RESEARCH_RE, isResearchShaped, parseDeadline, threadTokens, matchNewsToThread, matchDocToTopic, docPoolForTopic, parkDeliverable, scoreThread, pickUserThread, augmentGuidance, detectRedirect, matchThreadToTopic, REDIRECT_TRIGGER_RE, buildRedirectAsk, AGENDA_TRIGGER_RE, buildAgendaAsk };
