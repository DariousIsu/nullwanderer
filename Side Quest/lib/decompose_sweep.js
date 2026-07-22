'use strict';
/**
 * lib/decompose_sweep.js — find documents that landed but were never read.
 *
 * `decomposeLandedDoc` lives at main.js:9029 and is called from five specific INGEST paths — canvas
 * drop, browser download, meeting, and so on. So decomposition is coupled to how a document ARRIVED
 * rather than to the document itself, and anything landing by another route is invisible to the graph
 * forever. Found the hard way: `scripts/research_org.js` landed raineycenter.org and raineyfreedom.org
 * with correct origins and content hashes, and they produced ZERO encounters — the sentence naming the
 * sister organisation sat in the corpus, unread.
 *
 * This module is the SELECTION half, and it is the half worth testing: which documents were never read.
 * The live wiring (cloud extractor, Echo dispatch, the resolution gate) belongs to the caller, because
 * that is environment rather than logic.
 *
 * ── WHY "NO ENCOUNTERS" IS NOT ENOUGH ON ITS OWN ────────────────────────────────────────────────
 *
 * A document can be read honestly and yield nothing — a page of navigation chrome, a stub, a form. If
 * absence of encounters were the only test, that document would be re-read on every sweep forever,
 * burning a cloud extraction each time to produce the same nothing. So an ATTEMPT is recorded
 * separately from a RESULT. Trying and finding nothing is a fact worth keeping, exactly like an
 * encounter that found nothing is different from never having looked.
 */

const META_KEY = 'decompose_sweep:attempted';

/**
 * ONLY THE LANES THAT ACTUALLY USE THIS PATH.
 *
 * "No encounters citing doc:<id>" is a valid test ONLY for documents whose lane decomposes them. Other
 * lanes write their encounters under their OWN source_ref, so they look permanently unread. Measured:
 *
 *   news          1,986 documents — 0 with a `doc:` encounter   (writes `news:<id>`)
 *   legislation   1,951 documents — 0                            (its own path)
 *   meeting          10 documents — 0                            (writes via meeting_encounters)
 *   browser_download 3,341 documents — 393 WITH `doc:` encounters
 *
 * Sweeping on the naive test would re-read roughly four thousand already-processed documents and burn
 * a cloud extraction on each to rediscover what another lane already recorded. The allowlist is derived
 * from that measurement rather than from what the code looks like it should do: these are the lanes
 * observed to produce `doc:`-keyed encounters.
 */
const DECOMPOSE_LANES = ['browser_download', 'canvas_drop', 'research', 'org_research'];

// The attempted set, as ids. Stored in meta rather than a new table: it is a small operational marker,
// not evidence, and it must not look like knowledge.
function attemptedSet(db) {
  try {
    const raw = db.getMeta(META_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(Number).filter(Number.isFinite) : []);
  } catch { return new Set(); }
}

function markAttempted(db, ids = []) {
  const set = attemptedSet(db);
  for (const id of ids) if (Number.isFinite(Number(id))) set.add(Number(id));
  // Bounded: keep the most recent 20k so this marker cannot grow without limit. Older ids falling off
  // is safe — they will only be re-read if they ALSO still have no encounters, which by then is a
  // genuine question worth asking again.
  const arr = [...set].sort((a, b) => a - b).slice(-20000);
  try { db.setMeta(META_KEY, JSON.stringify(arr)); } catch { /* operational marker — never fatal */ }
  return arr.length;
}

/**
 * Documents that landed and were never read.
 *
 * A document qualifies when it has a body, has produced NO encounters, and has not already been
 * attempted. `sinceId` and `limit` bound the work; `sources` narrows to specific lanes when a caller
 * only wants to repair one (e.g. `org_research`).
 *
 * Returns [{ id, title, source, origin_host, chars }]. Never throws.
 */
function findUndecomposed(db, { limit = 50, sinceId = 0, sources = null } = {}) {
  const attempted = attemptedSet(db);
  // Default to the lanes that actually decompose. An explicit `sources` still wins, so a caller can
  // deliberately sweep something unusual — but the DEFAULT must not re-read four thousand news rows.
  const lanes = (Array.isArray(sources) && sources.length) ? sources : DECOMPOSE_LANES;
  let rows = [];
  try {
    const where = ['d.body IS NOT NULL', "TRIM(d.body) <> ''", 'd.id > ?'];
    const args = [Number(sinceId) || 0];
    where.push(`d.source IN (${lanes.map(() => '?').join(',')})`);
    args.push(...lanes);
    rows = db.getDb().prepare(
      `SELECT d.id, d.title, d.source, d.origin_host, LENGTH(d.body) AS chars
         FROM documents d
        WHERE ${where.join(' AND ')}
          AND NOT EXISTS (SELECT 1 FROM encounters e WHERE e.source_ref = 'doc:' || d.id)
        ORDER BY d.id DESC
        LIMIT ?`).all(...args, Math.max(1, (Number(limit) || 50) * 4));
  } catch { return []; }
  return rows.filter((r) => !attempted.has(Number(r.id))).slice(0, Math.max(1, Number(limit) || 50));
}

/**
 * ── THE BACKLOG IS 405 MILLION CHARACTERS. THAT IS WHY THIS IS BUDGETED. ────────────────────────
 *
 * Measured 2026-07-21: 3,211 unread decompose-lane documents totalling 405,363,197 characters —
 * roughly 69,000 chunks, and with the type adjudicator, ~138,000 model calls. Sweeping that in one go
 * is not a housekeeping pass, it is a major spend, and a backlog reader that can do it accidentally is
 * a bug regardless of how correct its selection logic is.
 *
 * So the permanent lane reads a FEW documents per tick, cheapest first, under a hard daily ceiling it
 * enforces itself. The shape matters more than the numbers:
 *
 *   SMALLEST FIRST   1,988 of the 3,211 documents are under 20k chars — 62% of the corpus for about
 *                    4% of the calls. Reading the 425k-char judicial PDF before a 900-char county
 *                    notice buys the least knowledge for the most money.
 *   HARD CEILING     a chunk budget per day, tracked in meta and checked BEFORE the work, so a stuck
 *                    loop or an enthusiastic caller cannot outspend it.
 *   ALREADY-TRIED    an attempted document is never retried, so the backlog genuinely drains rather
 *                    than the same cheap documents being re-read forever.
 */
const BUDGET_KEY = 'decompose_sweep:budget';
// The DAILY CEILING is a RUNAWAY-LOOP BACKSTOP, not a cost throttle (Lucas: "no spend concern — just no
// artificial caps"). In real-call units, 400 calls × 100k chars ≈ 40M chars/day — the whole 414M-char
// backlog drains in ~10 days. Override via ZOE_SWEEP_DAILY_CHUNKS if that ever needs tuning.
const DEFAULT_DAILY_CHUNKS = (() => {
  const v = parseInt(String(process.env.ZOE_SWEEP_DAILY_CHUNKS || '').trim(), 10);
  return (Number.isFinite(v) && v > 0) ? v : 400;
})();
// One budget unit = one MODEL CALL. Mirrors the 100k decompose slice main.js passes to
// chunkForExtraction. The first cut kept the old 6,000 here after the chunking grew, which made a
// 5M-char PDF "cost" 848 units — more than two whole days of budget — so the estimator itself was
// silently re-imposing the ceiling the chunking change had just removed.
const CHUNK_CHARS = 100000;

const estChunks = (chars) => Math.max(1, Math.ceil((Number(chars) || 0) / CHUNK_CHARS));
// The budget day is the EASTERN calendar day. toISOString is UTC, which rolled the budget at 8pm
// Eastern — the same day-key trap that filed evening meetings under tomorrow.
const _today = (now) => require('./tz').dayKey(now == null ? Date.now() : now);

/** Chunks already spent today, and what remains. Resets on the calendar day. */
function budgetState(db, { now = Date.now(), dailyChunks = DEFAULT_DAILY_CHUNKS } = {}) {
  let spent = 0, day = _today(now);
  try {
    const raw = db.getMeta(BUDGET_KEY);
    if (raw) { const o = JSON.parse(raw); if (o && o.day === day) spent = Number(o.spent) || 0; }
  } catch { /* a corrupt marker must not block work — treat as a fresh day */ }
  return { day, spent, limit: dailyChunks, remaining: Math.max(0, dailyChunks - spent) };
}

function spendBudget(db, chunks, { now = Date.now(), dailyChunks = DEFAULT_DAILY_CHUNKS } = {}) {
  const s = budgetState(db, { now, dailyChunks });
  const next = { day: s.day, spent: s.spent + Math.max(0, Number(chunks) || 0) };
  try { db.setMeta(BUDGET_KEY, JSON.stringify(next)); } catch { /* never fatal */ }
  return next.spent;
}

/**
 * The next few documents to read: CHEAPEST FIRST, and only as many as the remaining budget affords.
 *
 * Returns { picks, estChunks, budget } — `picks` is empty when the ceiling is reached, which is a
 * normal quiet state rather than an error.
 */
// NO DEFAULT SIZE CEILING. maxChars=60000 quietly put every backlogged giant — the multi-million-char
// judicial and canvass PDFs — permanently outside the sweep's reach: cheapest-first already reads them
// LAST, and the daily budget already bounds what a day can spend, so a ceiling on top was an artificial
// cap that excluded documents forever rather than deferring them. Pass maxChars explicitly to bound a
// deliberate run. The FLOOR stays: image-only PDFs proved cheap is only good when there's something to read.
function nextBatch(db, { limit = 3, dailyChunks = DEFAULT_DAILY_CHUNKS, maxChars = Infinity, minChars = 400, now = Date.now() } = {}) {
  const budget = budgetState(db, { now, dailyChunks });
  if (budget.remaining <= 0) return { picks: [], estChunks: 0, budget };

  // Pull a generous candidate window, then order by cost. findUndecomposed orders by id DESC (newest
  // first), which is the wrong axis for a backlog — the newest document is often the largest.
  //
  // A FLOOR AS WELL AS A CEILING. Ordering purely by cost picks the emptiest documents first, and the
  // first live run proved it: 43, 56 and 105 characters — image-only PDFs whose text extraction found
  // nothing. Each would spend a call to learn nothing and then be marked attempted, so the budget goes
  // on documents that cannot teach us anything. Cheap is only good when there is something to read.
  const pool = findUndecomposed(db, { limit: 400 })
    .filter((r) => r.chars >= minChars && r.chars <= maxChars)
    .sort((a, b) => a.chars - b.chars);

  const picks = [];
  let cost = 0;
  for (const r of pool) {
    if (picks.length >= Math.max(1, limit)) break;
    const c = estChunks(r.chars);
    if (cost + c > budget.remaining) continue;      // skip, do not stop — a smaller one may still fit
    picks.push(r); cost += c;
  }
  return { picks, estChunks: cost, budget };
}

module.exports = {
  findUndecomposed, attemptedSet, markAttempted, META_KEY, DECOMPOSE_LANES,
  nextBatch, budgetState, spendBudget, estChunks, BUDGET_KEY, DEFAULT_DAILY_CHUNKS,
};
