/**
 * lib/interests.js — Zoe's self-directed agenda (autonomy roadmap, Slice 1).
 *
 * The problem this fixes: her idle loop seeds every focus from whatever was last SAID, so she
 * reactively orbits the room (cheerleading because Lucas mentioned his daughter) instead of
 * pursuing intellectual pursuits of her own. This is a persistent, weighted interest store the
 * idle loop SAMPLES from before falling back to conversation — the difference between an echo and
 * an agenda.
 *
 * Grounded in the research (see the autonomy-roadmap memory):
 *  - reward LEARNING PROGRESS, not raw novelty (Schmidhuber, Oudeyer) → deepen-then-move-on;
 *  - score topics learnable × novel, gated by an LLM "model of interestingness" (OMNI) — here the
 *    cloud ranker via lib/cloud_logic (gpt-oss:120b), propose→validate→commit, fail-safe to local;
 *  - SEED a floor of deep domains AND let EMERGENT interests form from her own research (both,
 *    layered — the seed is a floor a bad generation can't override);
 *  - anti-fixation guardrails the research mandates: a novelty divisor, ε-exploration, and a CAP
 *    on any one interest's sampling share — the principled version of the focus anti-fixation work.
 *
 * Storage: the `interests` table. Heavy stages (reweight) run in the daily curator pass; the hot
 * path is a cheap weighted sample. All LLM/embedding/rng seams are injectable for offline smokes.
 */
const db = require('./db');
const memory = require('./memory');
const learning = require('./learning');

// Seed floor — deep domains from Lucas's sketch (learn-to-learn, philosophy, sciences, maths,
// markets, why the world works). Topic carries a short gloss; the slug is the part before the —.
const SEED_INTERESTS = [
  'epistemology — how we know what we know, and how to reason well',
  'mathematics — foundations, proof, and quantitative reasoning',
  'physics — how the physical world actually works',
  'economics and markets — why money moves and prices and markets behave as they do',
  'learning how to learn — metacognition, memory, and studying faster',
  'philosophy — ethics, mind, and the big questions',
  'computer science and intelligence — computation, algorithms, and how minds and models work',
  'history and the history of ideas — how the world got to now',
];

const SEED_FLOOR = 0.5;
const EMERGENT_FLOOR = 0.25;
const SEED_START_WEIGHT = 1.0;        // seeds are pursued before any LP data exists
const EMERGENT_START_WEIGHT = 0.55;
const LP_ALPHA = 0.4;                 // EMA smoothing for learning-progress
const LP_MATCH_SIM = 0.45;            // cosine: a banked fact "belongs to" an interest
const MAX_WEIGHT_SHARE = 0.35;        // no interest gets >35% of sampling mass (anti-fixation)
const DEFAULT_EPSILON = 0.15;         // forced exploration floor
const DEFAULT_TAU = 0.7;              // softmax temperature
const EMERGENT_MIN_FACTS = 4;         // unmatched subject needs this many facts to become an interest
const LP_EMA_CAP = 4;                 // R3: ceiling on learning-progress EMA (anti-runaway)
const LOW_SCORE = 4;                  // R5: cloud interestingness below this = trivia
const LOW_INTEREST_CEIL = 1.0;        // R5: low-scored interests hard-capped here (below the seed band)

function _db() { return db.getDb(); }
function _slug(s) { return learning.slugify(String(s || '').split('—')[0]); }
function _vec(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

function getActive() { return _db().prepare("SELECT * FROM interests WHERE status='active'").all(); }
function getAll() { return _db().prepare('SELECT * FROM interests').all(); }

// Idempotent seeding: insert only seeds whose slug isn't already present. embedFn injectable.
async function seed({ seeds = SEED_INTERESTS, embedFn = null, now = Date.now() } = {}) {
  const embed = embedFn || ((t) => memory.embed(t));
  let added = 0;
  for (const topic of seeds) {
    const slug = _slug(topic);
    if (!slug) continue;
    if (_db().prepare('SELECT 1 FROM interests WHERE slug=?').get(slug)) continue;
    let emb = null; try { emb = JSON.stringify(await embed(topic)); } catch {}
    _db().prepare('INSERT INTO interests (topic, slug, weight, source, embedding, created_ts) VALUES (?,?,?,?,?,?)')
      .run(topic, slug, SEED_START_WEIGHT, 'seed', emb, now);
    added++;
  }
  return { added };
}

// Add (or skip-if-near-duplicate) an interest. Used for emergent + user-signalled interests.
async function upsert(topic, { source = 'emergent', embedFn = null, now = Date.now() } = {}) {
  const slug = _slug(topic);
  if (!slug) return null;
  const existing = _db().prepare('SELECT * FROM interests WHERE slug=?').get(slug);
  if (existing) return existing;
  const embed = embedFn || ((t) => memory.embed(t));
  let emb = null; try { emb = JSON.stringify(await embed(topic)); } catch {}
  const w = source === 'seed' ? SEED_START_WEIGHT : EMERGENT_START_WEIGHT;
  const info = _db().prepare('INSERT INTO interests (topic, slug, weight, source, embedding, created_ts) VALUES (?,?,?,?,?,?)')
    .run(topic, slug, w, source, emb, now);
  return _db().prepare('SELECT * FROM interests WHERE id=?').get(info.lastInsertRowid);
}

/**
 * Sample one interest to pursue. ε of the time, force-explore the LEAST-visited (coverage);
 * otherwise softmax over weight/τ with a per-item share CAP so no single interest can dominate
 * (anti-fixation). rng injectable for deterministic smokes. Returns the row or null.
 */
function sampleTopic({ epsilon = DEFAULT_EPSILON, tau = DEFAULT_TAU, rng = Math.random } = {}) {
  const rows = getActive();
  if (!rows.length) return null;
  if (rng() < epsilon) {
    let best = rows[0];
    for (const r of rows) if ((r.visits || 0) < (best.visits || 0)) best = r;
    return best;
  }
  let ws = rows.map(r => Math.exp((r.weight || 0) / tau));
  let sum = ws.reduce((a, b) => a + b, 0) || 1;
  const cap = MAX_WEIGHT_SHARE * sum;
  ws = ws.map(w => Math.min(w, cap));
  sum = ws.reduce((a, b) => a + b, 0) || 1;
  let r = rng() * sum;
  for (let i = 0; i < rows.length; i++) { r -= ws[i]; if (r <= 0) return rows[i]; }
  return rows[rows.length - 1];
}

function recordVisit(id, now = Date.now()) {
  _db().prepare('UPDATE interests SET visits = visits + 1, last_visited_ts = ? WHERE id = ?').run(now, id);
}

// Cloud "model of interestingness" — rank candidates 0–10 by worth-pursuing-next, through the
// broker (cached/budgeted/traced, fail-safe). Returns [{id,score}] or [].
async function _defaultRank(candidates) {
  if (!candidates.length) return [];
  const cloudLogic = require('./cloud_logic');
  const r = await cloudLogic.ask({
    task: 'rank_interests', v: 1,
    input: { candidates, values: SEED_INTERESTS.map(s => s.split('—')[0].trim()) },
    want: 'Output ONLY a JSON array, one object per candidate id: [{"id":N,"score":M}], where M is 0-10 for how worth-pursuing-NEXT the topic is — genuinely interesting AND with real learning headroom — given the values and the topic\'s mastery/learning-progress. No prose.',
    validate: _validateScores
  });
  return Array.isArray(r) ? r : [];
}
function _validateScores(raw) {
  try {
    const m = String(raw || '').match(/\[[\s\S]*\]/);
    if (!m) return { valid: false, error: 'no JSON array' };
    const a = JSON.parse(m[0]);
    if (!Array.isArray(a)) return { valid: false, error: 'not an array' };
    for (const x of a) if (!x || x.id == null || typeof x.score !== 'number') return { valid: false, error: 'item missing id/score' };
    return { valid: true, value: a };
  } catch (e) { return { valid: false, error: e.message }; }
}

/**
 * Daily re-weighting (runs in the curator pass). For each interest: measure learning-progress as
 * the count of recently-banked facts that match it (embedding cosine), update lp_ema, recompute
 * weight = (floor + lp_ema) × novelty, then multiply by the cloud interestingness score. Unmatched
 * recent learning that clusters on one subject becomes an EMERGENT interest. embedFn/rankFn
 * injectable; apply=false → plan only (writes nothing).
 */
async function reweight({ apply = true, sinceMs = 24 * 60 * 60 * 1000, now = Date.now(), embedFn = null, rankFn = null } = {}) {
  const interests = getActive();
  if (!interests.length) return { interests: 0, reweighted: 0, emergent: [], apply };
  const since = now - sinceMs;
  // include reflection_knowledge: that's where her idle-pursuit learning actually banks today, so
  // it must count toward learning-progress or the agenda never reflects what she's really studying.
  const learnRows = _db()
    .prepare("SELECT id, content, embedding, provenance, created_ts FROM knowledge WHERE source IN ('learning','verified_fact','reflection_knowledge') AND created_ts >= ? AND embedding IS NOT NULL")
    .all(since);
  const ivecs = interests.map(it => _vec(it.embedding));
  const lvecs = learnRows.map(r => _vec(r.embedding));

  // learning-progress: assign each recent fact to its best-matching interest (if above threshold)
  const lpCounts = interests.map(() => 0);
  const matched = new Array(learnRows.length).fill(false);
  for (let li = 0; li < learnRows.length; li++) {
    if (!lvecs[li]) continue;
    let bestI = -1, bestS = LP_MATCH_SIM;
    for (let ii = 0; ii < interests.length; ii++) {
      if (!ivecs[ii]) continue;
      const s = memory.cosine(lvecs[li], ivecs[ii]);
      if (s >= bestS) { bestS = s; bestI = ii; }
    }
    if (bestI >= 0) { lpCounts[bestI]++; matched[li] = true; }
  }

  const updates = interests.map((it, ii) => {
    const lp = lpCounts[ii];
    // R3: CAP lp_ema so no single topic's learning-progress can compound unbounded (CS hit 11+,
    // cheer 7.9 — both runaway). Capped, weight stays bounded and the cloud gate (R5) can bite.
    const lp_ema = Math.min(LP_EMA_CAP, LP_ALPHA * lp + (1 - LP_ALPHA) * (it.lp_ema || 0));
    const floor = it.source === 'seed' ? SEED_FLOOR : EMERGENT_FLOOR;
    const novelty = 0.5 + 1 / (1 + (it.visits || 0));   // ~[0.5..1.5], diminishing on the familiar
    const weight = (floor + lp_ema) * novelty;
    return { id: it.id, lp, lp_ema, weight };
  });

  // cloud interestingness rerank (batched, one call) — gates the deterministic base
  const rank = rankFn || _defaultRank;
  const scores = {};
  try {
    const ranked = await rank(interests.map(it => ({ id: it.id, topic: it.topic, mastery: it.mastery, lp_ema: +(it.lp_ema || 0).toFixed(3) })));
    if (Array.isArray(ranked)) for (const x of ranked) if (x && x.id != null && typeof x.score === 'number') scores[x.id] = x.score;
  } catch { /* fail-safe: no rerank */ }
  for (const u of updates) {
    const sc = scores[u.id];
    if (sc != null) {
      u.weight *= Math.max(0.4, Math.min(1.6, sc / 5));
      // R5: give the cloud score real AUTHORITY — a low interestingness score HARD-CAPS the weight
      // below the seed band, so trivia (e.g. a cheer team scored ~2-3) can't climb no matter how much
      // learning-progress it accrues. Without this, lp overwhelmed the multiplier and trivia re-fixated.
      if (sc < LOW_SCORE) u.weight = Math.min(u.weight, LOW_INTEREST_CEIL);
    }
  }

  if (apply) {
    const stmt = _db().prepare('UPDATE interests SET lp_ema = ?, weight = ? WHERE id = ?');
    const tx = _db().transaction(() => { for (const u of updates) stmt.run(u.lp_ema, u.weight, u.id); });
    tx();
  }

  const emergent = await _emergentFromUnmatched(learnRows, matched, { apply, embedFn: embedFn || ((t) => memory.embed(t)), now });
  return { interests: interests.length, reweighted: updates.length, emergent, apply };
}

// Recent learning that matched NO interest, grouped by subject; a subject with enough facts becomes
// an emergent interest (her own derived agenda). Low floor + the cloud ranker keep trivia (e.g. a
// cheer team) from ever climbing — it scores low and is rarely sampled.
async function _emergentFromUnmatched(learnRows, matched, { apply, embedFn, now }) {
  const bySubj = new Map();
  for (let i = 0; i < learnRows.length; i++) {
    if (matched[i]) continue;
    let p = {}; try { p = JSON.parse(learnRows[i].provenance || '{}'); } catch {}
    if (!p.subject || !p.subject_key) continue;
    if (!bySubj.has(p.subject_key)) bySubj.set(p.subject_key, { subject: p.subject, count: 0 });
    bySubj.get(p.subject_key).count++;
  }
  const created = [];
  for (const [key, info] of bySubj) {
    if (info.count < EMERGENT_MIN_FACTS) continue;
    if (_db().prepare('SELECT 1 FROM interests WHERE slug=?').get(key)) continue;
    if (apply) {
      let emb = null; try { emb = JSON.stringify(await embedFn(info.subject)); } catch {}
      _db().prepare('INSERT INTO interests (topic, slug, weight, source, embedding, created_ts) VALUES (?,?,?,?,?,?)')
        .run(info.subject, key, EMERGENT_START_WEIGHT, 'emergent', emb, now);
    }
    created.push(info.subject);
  }
  return created;
}

/**
 * Idle-loop hook: when no focus is active, sample an interest and make it the current focus, so her
 * idle time pursues her AGENDA (reusing the focus lifecycle's caps + the frontier push). Returns the
 * spawned focus or null. focusLib/rng injectable; gated by `prob` so she isn't 100% on-agenda.
 */
// opts.background (2026-08-16, Lucas: "she should be able to wonder and work at the same time"): the
// PRIMARY lane yields if the single focus slot is busy (the old, starved behavior); the BACKGROUND lane
// spawns the interest as a CONCURRENT background focus — its own thread, never CURRENT_KEY — so it runs
// alongside the research sweep, isolated by thread/store (writes only interests/self_model). Returns the
// threadId so the caller can register it in the wondering lane for the background driver to advance.
async function maybeSpawnFocus({ focusLib = null, prob = 0.8, rng = Math.random, now = Date.now(), background = false } = {}) {
  const focus = focusLib || require('./focus');
  if (!background) { try { if (focus.isActive()) return null; } catch {} }   // primary lane only: don't fight the single slot
  if (rng() > prob) return null;              // leave room for free-association / conversation pull
  const pick = sampleTopic({ rng });
  if (!pick) return null;
  // DEPTH RATCHET: if the meta pass has an open gap-question for this interest, pursue THAT specific
  // unknown rather than the broad topic — the difference between deepening and re-circling.
  let content = pick.topic;
  try { const q = db.getTopAgenda(pick.id); if (q && q.question) content = `${pick.topic} — specifically: ${q.question}`; } catch {}
  let threadId = null;
  try { const row = db.insertOpenThread({ content, sourceTurnId: null }); threadId = row.id; } catch { return null; }
  let set = null;
  try {
    if (background) {
      set = (typeof focus.setBackground === 'function') ? focus.setBackground(threadId) : focus.setCurrent(threadId);
      // background flag routes the pass outcome to the background run-state (never a chat announce); origin
      // 'self' marks it a musing, not his work, so it's never mistaken for a user-directed task.
      try { db.setMeta(`focus.${threadId}.background`, '1'); } catch {}
      try { db.setMeta(`focus.${threadId}.origin`, 'self'); } catch {}
    } else {
      set = focus.setCurrent(threadId);
    }
  } catch { return null; }
  if (set) recordVisit(pick.id, now);
  return set ? { focus: set, interest: pick, threadId } : null;
}

module.exports = {
  seed, upsert, getActive, getAll, sampleTopic, recordVisit, reweight, maybeSpawnFocus,
  // exported for the offline smoke
  _defaultRank, _validateScores, _emergentFromUnmatched,
  SEED_INTERESTS, MAX_WEIGHT_SHARE, EMERGENT_MIN_FACTS, LP_MATCH_SIM
};
