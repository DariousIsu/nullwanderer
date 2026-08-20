'use strict';
/**
 * lib/answer_cache.js — E1: the rapid-response matrix (run-2 ROOT E, 2026-08-20).
 *
 * Measured disease (docs/LIVE_TEST_RUN2_2026-08-19.md §4E + the interaction profile): "who is
 * donald trump" (8× lifetime) ran a full 4–5 tool chain BOTH times — 55.1s then 32.7s; the LA-14
 * SECOND ask was slower than the first minutes after she read the answer in a file. The only warm
 * path was the identity/preference interceptor (0.1s, byte-identical for two months). This organ
 * generalizes that proven template: a GROUNDED answer she already produced is served verbatim at
 * fast-path with a freshness stamp, instead of re-deriving it through the whole engine.
 *
 * TRUTH DISCIPLINE (the guardrail Lucas set for pre-scripted reads): the cache stores only answers
 * that were actually composed and delivered on a grounded lookup turn — never a template, never an
 * unmeasured claim. Serving is verbatim + stamped ("as of …"), TTL'd by KIND, and invalidated at
 * READ time when newer knowledge mentions the answer's subjects — a stale row is a MISS, never a
 * stale assertion. Corrections, honest misses, and self/status/order/recall shapes are refused at
 * both store and serve time by construction.
 *
 * TTL by kind: person/roster/contact-count 7d · bill 3d · news/current 6h · default 24h.
 * Identity/taste stays with the preference interceptor (∞, self_model-backed) — excluded here.
 *
 * RESUME CONTEXT (the 171s affirm-continue pathology): a compact measured snapshot of the live
 * thread {last substantive ask, her last point}, refreshed on every substantive reply, injected
 * when a turn is an affirm-continue ("ok back to it", "where were we") so re-entry starts from
 * the thread instead of re-deriving it.
 */

let _db = null;
const db = () => (_db || (_db = require('./db')));

let _tableReady = false;
function _ensureTable() {
  if (_tableReady) return;
  db().getDb().prepare(`CREATE TABLE IF NOT EXISTS answer_cache (
    qkey TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    kind TEXT NOT NULL,
    subjects TEXT,
    verified_ts INTEGER NOT NULL,
    hits INTEGER DEFAULT 0,
    last_served_ts INTEGER
  )`).run();
  _tableReady = true;
}

// ── normalization: many phrasings, one key ──────────────────────────────────────────────────────
const _LEAD_FLUFF_RE = /^(?:hey|hi|hello|yo|ok(?:ay)?|so|umm?|well|quick(?:ie| question)?|also|and|zoe)[,\s!]+/i;
const _TAIL_FLUFF_RE = /[\s,]*(?:please|thanks?|thank you|real quick|for me|again|when you can)[.!?\s]*$/i;
function normalize(q) {
  let s = String(q || '').toLowerCase().trim();
  for (let i = 0; i < 3; i++) s = s.replace(_LEAD_FLUFF_RE, '');
  s = s.replace(_TAIL_FLUFF_RE, '');
  s = s.replace(/[’']/g, "'").replace(/[^a-z0-9'#$%& ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // collapse trivial phrasing variants: "who's X" == "who is X", "whats" == "what is"
  s = s.replace(/^who's\b/, 'who is').replace(/^what's\b|^whats\b/, 'what is').replace(/^where's\b/, 'where is').replace(/^how's\b/, 'how is');
  return s;
}

// ── kind + TTL ──────────────────────────────────────────────────────────────────────────────────
const _TTL = {
  person: 7 * 24 * 3600 * 1000,
  roster: 7 * 24 * 3600 * 1000,
  'contact-count': 7 * 24 * 3600 * 1000,
  bill: 3 * 24 * 3600 * 1000,
  news: 6 * 3600 * 1000,
  general: 24 * 3600 * 1000,
};
function ttlFor(kind) { return _TTL[kind] || _TTL.general; }

// Shapes this cache must NEVER own — they are measured-state or other organs' turf.
const _EXCLUDE_RE = /\b(?:you|your|yourself)\b|\bmy\b|\bstatus\b|where do things stand|where were we|how'?s it (?:coming|going)|what did (?:i|we) say|remind me|\bcanvas\b|\bcontinue\b|\bback to\b/i;
const _QUESTION_SHAPE_RE = /\?\s*$|^(?:who|what|when|where|which|how (?:many|much|old|long|far)|is|are|was|were|does|do|did|can|has|have)\b/i;

function classifyKind(q) {
  const s = String(q || '');
  // Shape-test the NORMALIZED form (boot_p57 retest miss: "hey, who's cleo fields again" failed the
  // raw-text shape gate — no "?" and a greeting lead — so the warm variant never reached lookup).
  const n = normalize(s);
  if (!n || _EXCLUDE_RE.test(s) || !_QUESTION_SHAPE_RE.test(n)) return null;
  // kind nets run on the NORMALIZED form too — "hey, who's X again" must classify like "who is X"
  if (/\b(?:latest|today|tonight|right now|breaking|this (?:week|morning|evening)|news)\b/i.test(n)) return 'news';
  if (/\bhow many contacts?\b|\bcontacts? (?:with|in)\b/i.test(n)) return 'contact-count';
  if (/\b(?:roster|members? of|who (?:sits|serves|is) on|leadership of)\b/i.test(n)) return 'roster';
  if (/\b(?:bill|sb ?\d+|hb ?\d+|hr ?\d+|s ?\d{2,})\b/i.test(n)) return 'bill';
  if (/^\s*who (?:is|was)\b/i.test(n)) return 'person';
  return 'general';
}

// Subject anchors for read-time invalidation: capitalized tokens + rare lowercase tokens ≥5ch.
const _SUBJ_STOP = new Set(['the', 'this', 'that', 'what', 'when', 'where', 'which', 'who', 'how',
  'many', 'much', 'does', 'have', 'about', 'with', 'from', 'their', 'there', 'right', 'now']);
function subjectsOf(question) {
  const out = [];
  for (const m of String(question || '').match(/\b[\w'-]{4,}\b/g) || []) {
    const w = m.toLowerCase();
    if (_SUBJ_STOP.has(w) || out.includes(w)) continue;
    out.push(w);
  }
  return out.slice(0, 4);
}

// ── store: only a real, delivered, grounded answer — never a miss, never a correction ───────────
const _UNCACHEABLE_ANSWER_RE = /\[Correction|couldn'?t find|could not find|don'?t (?:have|hold|know)|not (?:sure|certain)|didn'?t complete|failed|unable to|no results|drew a blank|still (?:looking|checking|pending)|i'?ll (?:check|look|get back)/i;
function store({ question, answer, kind = null, now = Date.now() } = {}) {
  try {
    const k = kind || classifyKind(question);
    if (!k) return { stored: false, reason: 'not-cacheable-shape' };
    const a = String(answer || '').trim();
    if (a.length < 20 || a.length > 1500) return { stored: false, reason: 'answer-size' };
    if (a === '…' || _UNCACHEABLE_ANSWER_RE.test(a)) return { stored: false, reason: 'miss-or-correction' };
    const qkey = normalize(question);
    if (qkey.length < 6) return { stored: false, reason: 'key-too-short' };
    _ensureTable();
    db().getDb().prepare(`INSERT INTO answer_cache (qkey, question, answer, kind, subjects, verified_ts, hits, last_served_ts)
      VALUES (?,?,?,?,?,?,0,NULL)
      ON CONFLICT(qkey) DO UPDATE SET question=excluded.question, answer=excluded.answer, kind=excluded.kind,
        subjects=excluded.subjects, verified_ts=excluded.verified_ts`)
      .run(qkey, String(question).slice(0, 400), a, k, JSON.stringify(subjectsOf(question)), now);
    return { stored: true, qkey, kind: k };
  } catch (e) { return { stored: false, reason: e.message }; }
}

// ── read-time invalidation: newer knowledge naming the subjects beats the cache ─────────────────
function _newerKnowledgeTouches(subjects, sinceTs) {
  try {
    const subs = (subjects || []).slice(0, 3).filter((s) => s && s.length >= 4);
    if (!subs.length) return false;
    const conds = subs.map(() => 'content LIKE ?').join(' OR ');
    const args = subs.map((s) => `%${s}%`);
    const row = db().getDb().prepare(`SELECT 1 AS x FROM knowledge WHERE created_ts > ? AND (${conds}) LIMIT 1`).get(sinceTs, ...args);
    return !!row;
  } catch { return false; }   // fail OPEN: an invalidation error never blocks a serve
}

// ── lookup: fresh → the verbatim answer + stamp; anything else → miss ───────────────────────────
function lookup(question, { now = Date.now() } = {}) {
  try {
    const kind = classifyKind(question);
    if (!kind) return null;                                    // excluded shapes never serve
    _ensureTable();
    const qkey = normalize(question);
    const row = db().getDb().prepare('SELECT * FROM answer_cache WHERE qkey = ?').get(qkey);
    if (!row) return null;
    const age = now - (row.verified_ts || 0);
    if (age > ttlFor(row.kind)) return null;                   // expired → a miss, never a stale serve
    let subjects = []; try { subjects = JSON.parse(row.subjects || '[]'); } catch {}
    if (_newerKnowledgeTouches(subjects, row.verified_ts)) return null;   // world moved → re-derive
    db().getDb().prepare('UPDATE answer_cache SET hits = hits + 1, last_served_ts = ? WHERE qkey = ?').run(now, qkey);
    return { answer: row.answer, kind: row.kind, ageMs: age, verifiedTs: row.verified_ts, qkey, hits: (row.hits || 0) + 1 };
  } catch { return null; }
}

// The stamped serve text — the freshness is part of the answer, in Eastern like every displayed time.
function serveText(hit, { now = Date.now() } = {}) {
  let when = '';
  try {
    const tz = require('./tz');
    const d = new Date(hit.verifiedTs);
    const sameDay = tz.date(d) === tz.date(new Date(now));
    when = sameDay ? `today at ${tz.timeWithZone(d)}` : `${tz.date(d)}, ${tz.timeWithZone(d)}`;
  } catch { when = new Date(hit.verifiedTs).toLocaleString(); }
  return `${hit.answer}\n\n(from my verified answer as of ${when} — say "recheck" if you want it fresh.)`;
}

// A "recheck/fresh" rider on the question bypasses the cache for this turn.
const _RECHECK_RE = /\b(?:recheck|re-?verify|fresh|double-?check|look (?:it )?up again|latest version)\b/i;
function wantsFresh(question) { return _RECHECK_RE.test(String(question || '')); }

// ── RESUME CONTEXT (the 171s affirm-continue pathology) ─────────────────────────────────────────
// Run-3 catch (2026-08-20): "yea keep going with that" missed — the net demanded the continue
// phrase END the message. A deictic tail (with/on/from + that/this/it/there) is still a resume;
// a tail naming a SUBJECT ("keep going with the Indiana sweep") is a directive and stays out.
// Run-4 catch (2026-08-20): "yes — back to it." missed — the joiner between the affirmation and the
// continue phrase only allowed [,\s!]; a dash/colon/period/ellipsis there is the same utterance.
const _AFFIRM_CONTINUE_RE = /^\s*(?:ok(?:ay)?|yea(?:h)?|yes|right|cool|alright|good|k)?[,.\s!…:;—–-]*(?:back to (?:it|work|business)|let'?s (?:continue|keep going|get back(?: to it)?)|continue|keep going|where were we|as you were|carry on|pick (?:it|this) (?:back )?up|pick up where we left off)(?:\s+(?:with|on|from)\s+(?:that|this|it|there))?\s*[.!?]*\s*$/i;
function isAffirmContinue(text) { return _AFFIRM_CONTINUE_RE.test(String(text || '')); }

const _RESUME_KEY = (sid) => `resume_ctx.${sid}`;
// Refresh after a substantive exchange — cheap deterministic slices, no model call.
function noteExchange({ sessionId, userText, sayText, now = Date.now() } = {}) {
  try {
    if (!sessionId) return;
    const u = String(userText || '').replace(/\s+/g, ' ').trim();
    const a = String(sayText || '').replace(/\s+/g, ' ').trim();
    if (u.length < 15 || a.length < 30 || a === '…') return;    // too thin to resume FROM
    if (isAffirmContinue(u)) return;                            // an affirm-continue is not a new thread
    if (isElliptical(u)) return;                                // an elliptical rides the thread — the
                                                                // anchor stays the last SELF-SUFFICIENT ask
    db().setMeta(_RESUME_KEY(sessionId), JSON.stringify({ ask: u.slice(0, 240), point: a.slice(0, 320), ts: now }));
  } catch {}
}

// ── THREAD REFERENT (the run-6 binding disease, 2026-08-20) ─────────────────────────────────────
// con_deep_ellipsis caught it live: "what office is he holding these days?" bound "he" to a
// background focus entity, not the thread — Landry → Orgeron → Cleo Fields across three
// consecutive turns of ONE thread; the referent re-rolled every turn to whatever was hottest in
// her beat state. The class: a SHORT turn with no proper-noun anchor of its own that leans on the
// conversation for its subject — (a) a third-person PERSON pronoun, (b) a leading-conjunction
// fragment ("and which party?"), or (c) a bare elaboration ask ("more details" — F13's original
// live shape, the yea-misroute's misbind half). Bare "it" smalltalk ("how's it going?") stays out;
// a bare wh-question with neither pronoun nor conjunction lead is a NEW subject (proven in-run:
// the callback case's weather turn). A capitalized entity anywhere = the turn brought its own
// referent and needs no pin.
const _THIRD_PRONOUN_RE = /\b(?:he|she|they|him|her|them|his|hers|theirs?|that (?:one|person|place|group|outfit)|those (?:two|folks|people))\b/i;
const _FRAGMENT_LEAD_RE = /^\s*(?:and|but|so|also|plus|then|what about|how about)\b/i;
const _ELABORATE_RE = /\b(?:more|further|deeper|extra)\s+(?:details?|info(?:rmation)?|context|depth|color)\b|\b(?:elaborate|expand|unpack|go (?:deeper|further)|dig (?:deeper|in)|drill (?:down|in)|keep unpacking|tell me more)\b/i;
function _hasProperNoun(t) {
  const re = /\b[A-Z][a-z]{2,}\b/g; let m;
  while ((m = re.exec(t))) {
    if (m.index === 0) continue;                     // a sentence-opening capital is not an entity
    const before = t.slice(0, m.index);
    // a sentence break demotes the next capital — but an abbreviation's period (St. Mary) does not
    if (/[.!?]\s*$/.test(before) && !/\b[A-Z][a-z]?\.\s*$/.test(before)) continue;
    return true;
  }
  return false;
}
function isElliptical(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 90) return false;
  if (isAffirmContinue(t)) return false;             // the resume door owns that shape
  if (_hasProperNoun(t)) return false;
  return _THIRD_PRONOUN_RE.test(t) || _FRAGMENT_LEAD_RE.test(t) || _ELABORATE_RE.test(t);
}
// The injection for an elliptical turn — the same measured thread store, framed for BINDING: the
// conversation's own referent must outrank beat salience. Advisory on purpose — a genuinely new
// subject answers plainly.
function referentBlock({ sessionId, userName = 'them', maxAgeMs = 12 * 3600 * 1000, now = Date.now() } = {}) {
  try {
    if (!sessionId) return null;
    const raw = db().getMeta(_RESUME_KEY(sessionId));
    if (!raw) return null;
    const r = JSON.parse(raw);
    if (!r || !r.ask || now - (r.ts || 0) > maxAgeMs) return null;
    const mins = Math.max(1, Math.round((now - r.ts) / 60000));
    return `[THREAD REFERENT (measured, ${mins}m ago): this turn is elliptical — it leans on the live conversation for its subject. The thread: ${userName}'s last substantive ask was "${r.ask}" — your last point: "${r.point}". Resolve every pronoun and fragment against THAT thread's subject, NEVER against your background work, open beats, or whatever you were just thinking about. If the turn genuinely opens a new subject, answer it plainly.]`;
  } catch { return null; }
}
// The injection block for an affirm-continue turn — measured thread state, rendered not composed.
function resumeBlock({ sessionId, userName = 'them', maxAgeMs = 12 * 3600 * 1000, now = Date.now() } = {}) {
  try {
    if (!sessionId) return null;
    const raw = db().getMeta(_RESUME_KEY(sessionId));
    if (!raw) return null;
    const r = JSON.parse(raw);
    if (!r || !r.ask || now - (r.ts || 0) > maxAgeMs) return null;
    const mins = Math.max(1, Math.round((now - r.ts) / 60000));
    return `[RESUME CONTEXT (measured, ${mins}m ago): ${userName} is telling you to PICK THE THREAD BACK UP. The live thread — their last substantive ask: "${r.ask}" — your last point: "${r.point}". Re-enter EXACTLY there in your own voice: continue that thread directly, do NOT re-derive it, summarize the whole conversation, or start a new subject.]`;
  } catch { return null; }
}

function stats() {
  try { _ensureTable(); return db().getDb().prepare('SELECT COUNT(*) n, SUM(hits) h FROM answer_cache').get(); } catch { return { n: 0, h: 0 }; }
}

module.exports = { normalize, classifyKind, ttlFor, subjectsOf, store, lookup, serveText, wantsFresh, isAffirmContinue, isElliptical, noteExchange, resumeBlock, referentBlock, stats, _UNCACHEABLE_ANSWER_RE };
