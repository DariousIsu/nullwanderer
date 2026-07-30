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

module.exports = { RESEARCH_RE, isResearchShaped, parseDeadline, threadTokens, matchNewsToThread, matchDocToTopic, scoreThread, pickUserThread, augmentGuidance };
