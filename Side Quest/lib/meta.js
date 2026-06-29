/**
 * lib/meta.js — the META PASS (autonomy roadmap: depth ratchet + learning-to-learn).
 *
 * Cold + periodic (runs in the daily/overnight curator pass), cloud-assisted via lib/cloud_logic
 * (cached / budgeted / traced / fail-safe). Bounded to the TOP interests so cost stays small. For
 * each, three moves the research said a small model can't do well alone but a cloud tutor can:
 *
 *   1. CLOSE answered gaps — an open agenda question whose answer a recently-banked fact now covers
 *      (embedding match) is marked answered. Deterministic, no cloud.
 *   2. GAP QUESTIONS (STORM/Self-Ask) — given what she already knows, the cloud asks what she does
 *      NOT (mechanism / why / quantitative / prerequisites), stored as `agenda` open questions the
 *      idle loop then works. This is the depth ratchet: work a specific unknown, don't re-circle.
 *   3. SUMMARIZE (RAPTOR-lite) — fold the interest's banked facts into ONE higher-level 'topic'
 *      note so retrieval gains an abstraction and knowledge compounds upward; set mastery from the
 *      fact count.
 *
 * Cloud PROPOSES (questions, summary); deterministic gates DISPOSE (dedup, validate). All deps
 * injectable so the whole pass is offline-testable.
 */
const db = require('./db');
const memory = require('./memory');

const TOP_INTERESTS = 3;          // only the hottest interests each pass (cost bound)
const GAP_TARGET = 3;             // keep ~this many open questions per interest
const KNOWN_SNIPPETS = 6;         // notes shown to the gap/summary prompt (context budget)
const MASTERY_K = 8;              // facts → mastery saturation
const SUMMARY_MIN_FACTS = 4;      // need this many facts to summarize
const GAP_ANSWERED_SIM = 0.6;     // a banked fact this close to a question "answers" it
const FACT_MATCH_SIM = 0.45;      // a fact "belongs to" an interest

function _db() { return db.getDb(); }
function _vec(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

function _topInterests(n) {
  return _db().prepare("SELECT * FROM interests WHERE status='active' ORDER BY weight DESC LIMIT ?").all(n);
}

// All banked facts (learning/verified) matching an interest, cosine-ranked, with vectors.
function _factsForInterest(ivec) {
  if (!ivec) return [];
  const rows = _db().prepare("SELECT id, content, embedding FROM knowledge WHERE source IN ('learning','verified_fact','reflection_knowledge') AND embedding IS NOT NULL").all();
  const out = [];
  for (const r of rows) {
    const v = _vec(r.embedding); if (!v) continue;
    const s = memory.cosine(ivec, v);
    if (s >= FACT_MATCH_SIM) out.push({ id: r.id, content: r.content, sim: s, vec: v });
  }
  out.sort((a, b) => b.sim - a.sim);
  return out;
}

// ---- cloud tasks (through the broker) ----
function _validateQuestions(raw) {
  try {
    const m = String(raw || '').match(/\[[\s\S]*\]/);
    if (!m) return { valid: false, error: 'no JSON array' };
    const a = JSON.parse(m[0]);
    if (!Array.isArray(a)) return { valid: false, error: 'not an array' };
    const qs = a.filter(x => typeof x === 'string' && x.trim().length > 5).map(x => x.trim());
    if (!qs.length) return { valid: false, error: 'no usable questions' };
    return { valid: true, value: qs };
  } catch (e) { return { valid: false, error: e.message }; }
}
function _validateText(raw) {
  const t = String(raw || '').trim();
  if (t.length < 10) return { valid: false, error: 'too short' };
  return { valid: true, value: t };
}

async function _askGaps(topic, known, deps) {
  const ask = deps.ask || ((a) => require('./cloud_logic').ask(a));
  const r = await ask({
    task: 'gap_questions', v: 1,
    input: { topic, known },
    want: `You are deepening understanding of "${topic}". Given KNOWN (facts already learned), output ONLY a JSON array of up to ${GAP_TARGET} SPECIFIC questions whose answers are NOT already in KNOWN — prefer mechanism ("why/how does X cause Y"), quantification, edge cases, or a prerequisite the known facts assume but never establish. ["question one","question two"]`,
    validate: _validateQuestions
  });
  return Array.isArray(r) ? r : [];
}
async function _askSummary(topic, facts, deps) {
  const ask = deps.ask || ((a) => require('./cloud_logic').ask(a));
  return ask({
    task: 'summarize_interest', v: 1,
    input: { topic, facts },
    want: `Synthesize what is known about "${topic}" from these facts into ONE concise paragraph (~60 words) — the higher-level picture, not a list. Output ONLY the paragraph.`,
    validate: _validateText
  });
}

// ---- per-interest meta ----

// Mark open questions answered when a banked fact now covers them (embedding match). No cloud.
async function closeAnsweredGaps(interest, facts, { apply = true, embedFn = null, now = Date.now() } = {}) {
  const open = db.getOpenAgenda(interest.id, 50);
  if (!open.length || !facts.length) return 0;
  const embed = embedFn || ((t) => memory.embed(t));
  let closed = 0;
  for (const q of open) {
    let qv = null; try { qv = await embed(q.question); } catch { continue; }
    let best = null;
    for (const f of facts) { if (memory.cosine(qv, f.vec) >= GAP_ANSWERED_SIM) { best = f; break; } }
    if (best) { if (apply) db.setAgendaStatus(q.id, 'answered', { answeredNoteId: best.id, now }); closed++; }
  }
  return closed;
}

async function refillGaps(interest, known, { apply = true, deps = {}, now = Date.now() } = {}) {
  const have = db.countOpenAgenda(interest.id);
  if (have >= GAP_TARGET) return [];
  const qs = await _askGaps(interest.topic, known.map(k => k.content || k), deps);
  // dedup against ALL prior questions for this interest (any status) so an answered one never reopens
  const existing = new Set(_db().prepare('SELECT question FROM agenda WHERE interest_id = ?').all(interest.id).map(a => a.question.toLowerCase()));
  const created = [];
  for (const q of qs) {
    if (created.length + have >= GAP_TARGET) break;
    if (existing.has(q.toLowerCase())) continue;
    if (apply) db.insertAgenda({ interestId: interest.id, question: q, now });
    created.push(q);
  }
  return created;
}

async function summarizeInterest(interest, facts, { apply = true, deps = {} } = {}) {
  if (facts.length < SUMMARY_MIN_FACTS) return { summarized: false, mastery: interest.mastery || 0 };
  const summary = await _askSummary(interest.topic, facts.slice(0, KNOWN_SNIPPETS).map(f => f.content), deps);
  const mastery = +(1 - Math.exp(-facts.length / MASTERY_K)).toFixed(3);
  if (apply) {
    _db().prepare('UPDATE interests SET mastery = ? WHERE id = ?').run(mastery, interest.id);
    if (summary) {
      // supersede the prior summary for this interest (level='topic' is excluded from near-dup merge)
      const old = _db().prepare("SELECT id FROM knowledge WHERE source='interest_summary' AND provenance LIKE ?").all('%"slug":"' + interest.slug + '"%');
      for (const o of old) { _db().prepare('DELETE FROM knowledge WHERE id=?').run(o.id); try { _db().prepare('DELETE FROM knowledge_fts WHERE rowid=?').run(o.id); } catch {} }
      try { await memory.store({ kind: 'note', content: summary, source: 'interest_summary', level: 'topic', importance: 0.7, provenance: { slug: interest.slug, kind: 'interest_summary' } }); } catch {}
    }
  }
  return { summarized: !!summary, mastery };
}

/**
 * The meta pass. For the top-N interests: close answered gaps, summarize + set mastery, refill gap
 * questions. apply=false → plan only. Returns a per-interest summary. Each interest isolated in
 * try/catch so one failure can't abort the pass.
 */
async function runMetaPass({ apply = true, topN = TOP_INTERESTS, deps = {}, now = Date.now() } = {}) {
  const interests = _topInterests(topN);
  const out = { apply, interests: interests.length, perInterest: [] };
  for (const it of interests) {
    try {
      const ivec = _vec(it.embedding);
      const facts = _factsForInterest(ivec);
      const known = facts.slice(0, KNOWN_SNIPPETS);
      const closed = await closeAnsweredGaps(it, facts, { apply, embedFn: deps.embedFn, now });
      const sum = await summarizeInterest(it, facts, { apply, deps });
      const created = await refillGaps(it, known, { apply, deps, now });
      out.perInterest.push({ slug: it.slug, facts: facts.length, closed, created: created.length, summarized: sum.summarized, mastery: sum.mastery });
    } catch (e) {
      out.perInterest.push({ slug: it.slug, error: e.message });
    }
  }
  return out;
}

module.exports = {
  runMetaPass, summarizeInterest, refillGaps, closeAnsweredGaps,
  // exported for the offline smoke
  _validateQuestions, _validateText, _factsForInterest, _topInterests,
  TOP_INTERESTS, GAP_TARGET, MASTERY_K
};
