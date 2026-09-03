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

/**
 * INVERTED 2026-07-30 (shortcomings inventory §8): the allowlist above made every NEW lane invisible
 * by default — inquiry findings, autonomy artifacts, editor attachments, conversation docs all landed
 * and were never read. The honest key is "no lane of its own reads it": EXCLUDE only the lanes
 * MEASURED to write encounters under their own refs (news → `news:<id>`, legislation → its own path,
 * meeting → meeting_encounters); every other arrival route decomposes by default. A new lane is READ
 * unless it demonstrably reads itself — let-it-in semantics, with the NOT-EXISTS doc: check and the
 * attempted set still preventing any re-read.
 */
const SELF_KEYED_LANES = ['news', 'legislation', 'meeting'];

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
  _evictFromPool(db, ids);   // an attempted doc leaves the candidate pool the same moment
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
function findUndecomposed(db, { limit = 50, sinceId = 0, sources = null, chars = true } = {}) {
  const attempted = attemptedSet(db);
  // Default: every lane EXCEPT the self-keyed ones (see SELF_KEYED_LANES — inverted 2026-07-30).
  // An explicit `sources` still wins, so a caller can deliberately sweep one lane.
  let rows = [];
  try {
    // SLOW-SCAN CURE (2026-08-27, the probe's 1.96s face): the body predicates used to LEAD the
    // WHERE, so every scanned row — including the already-decomposed ones the anti-join rejects —
    // paid to load its body overflow pages and run TRIM over it (1.35GB corpus). Cheap predicates
    // (id, source, the indexed anti-join probe) now run FIRST and LENGTH replaces TRIM (no string
    // allocation; a whitespace-only body slipping through just decomposes to nothing and marks
    // attempted — harmless). Rows that fail the cheap filters never touch the body column at all.
    const where = ['d.id > ?'];
    const args = [Number(sinceId) || 0];
    if (Array.isArray(sources) && sources.length) {
      where.push(`d.source IN (${sources.map(() => '?').join(',')})`);
      args.push(...sources);
    } else {
      where.push(`(d.source IS NULL OR d.source NOT IN (${SELF_KEYED_LANES.map(() => '?').join(',')}))`);
      args.push(...SELF_KEYED_LANES);
    }
    // THE ATTEMPTED SET IS FILTERED IN SQL (freeze cut 5, 2026-09-03): it used to be applied in JS
    // AFTER the query, so the LIMIT window (4× the batch) filled with already-attempted rows — 972 of
    // 1,207 on boot_p256 — and every one of them paid the LENGTH(body) read before being thrown away.
    // json_each turns the marker into an ephemeral index the planner probes BEFORE the body is touched.
    if (attempted.size) { where.push('d.id NOT IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify([...attempted])); }
    // chars:false — the walk WITHOUT the body: LENGTH(body) is what turns a 0.8s walk into a 2–7s one
    // (the pool's refresh keeps the lengths it already knows and measures only new ids — see _charsOf).
    // A row then carries chars:null, and an empty body is the caller's to drop (its length is 0).
    rows = db.getDb().prepare(
      `SELECT d.id, d.title, d.source, d.origin_host, ${chars ? 'LENGTH(d.body)' : 'NULL'} AS chars
         FROM documents d
        WHERE ${where.join(' AND ')}
          AND NOT EXISTS (SELECT 1 FROM encounters e WHERE e.source_ref = 'doc:' || d.id)
          AND d.body IS NOT NULL${chars ? ' AND LENGTH(d.body) > 0' : ''}
        ORDER BY d.id DESC
        LIMIT ?`).all(...args, Math.max(1, Number(limit) || 50));
  } catch { return []; }
  return rows.filter((r) => !attempted.has(Number(r.id))).slice(0, Math.max(1, Number(limit) || 50));
}
// Body lengths for a set of ids in ONE statement (the only body reads a pool refresh pays).
function _charsOf(db, ids) {
  const m = new Map();
  if (!ids.length) return m;
  try {
    for (const r of db.getDb().prepare('SELECT id, LENGTH(body) AS chars FROM documents WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids))) m.set(Number(r.id), Number(r.chars) || 0);
  } catch { /* fail-soft: unknown lengths read as 0 and are dropped this refresh */ }
  return m;
}

/**
 * ── THE CANDIDATE POOL (freeze cut 5, 2026-09-03) ────────────────────────────────────────────────
 *
 * Measured on boot_p256 (4h20m): findUndecomposed ran 47 times for 258s of main-thread block — 2.3 to
 * 10.4s each, every 5-minute tick, the single largest carrier of the freeze. The walk itself (51k
 * documents, the encounters anti-join) is ~0.8s; the rest is LENGTH(body) over the survivors. The
 * backlog is down to 235 unattempted documents that carry 88 MILLION characters between them — the
 * giants, read last by design — and every tick re-read all of it to learn lengths it already knew,
 * in order to pick two documents.
 *
 * So the candidates are POOLED, in meta next to the attempted set (a small operational marker, not
 * knowledge): a FULL walk when no pool exists or once per POOL_FULL_TTL_MS; an INCREMENTAL walk every
 * tick over documents above the pool's high-water id (a few rows — milliseconds); eviction the
 * moment a document is attempted. Persisted, so a reboot does not pay the full walk again.
 *
 * A pooled row can go stale one way only: another path decomposed the document meanwhile. Every
 * pick is therefore re-verified against encounters (one index seek) before it is offered — a stale
 * row costs a probe, never a cloud read.
 */
const POOL_KEY = 'decompose_sweep:pool';
const POOL_FULL_TTL_MS = 6 * 3600 * 1000;
const POOL_LIMIT = 400;
let _pool = null;   // { at, maxId, full, rows: [{ id, title, source, origin_host, chars }] } — mirrors meta

function _readPool(db) {
  if (_pool) return _pool;
  try {
    const raw = db.getMeta(POOL_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || !Array.isArray(p.rows) || !Number.isFinite(Number(p.at))) return null;
    _pool = { at: Number(p.at), maxId: Number(p.maxId) || 0, full: !!p.full,
              rows: p.rows.filter((r) => r && Number.isFinite(Number(r.id))) };
    return _pool;
  } catch { return null; }
}
function _savePool(db, pool) {
  _pool = pool;
  try { db.setMeta(POOL_KEY, JSON.stringify(pool)); } catch { /* operational marker — never fatal */ }
}
function _evictFromPool(db, ids = []) {
  const pool = _readPool(db);
  if (!pool || !pool.rows.length) return;
  const gone = new Set(ids.map(Number).filter(Number.isFinite));
  if (!gone.size) return;
  const rows = pool.rows.filter((r) => !gone.has(Number(r.id)));
  if (rows.length !== pool.rows.length) _savePool(db, { ...pool, rows });
}
function _maxDocId(db) {
  try { return Number(db.getDb().prepare('SELECT MAX(id) m FROM documents').get().m) || 0; } catch { return 0; }
}
function _stillUnread(db, id) {
  try { return !db.getDb().prepare('SELECT 1 FROM encounters WHERE source_ref = ? LIMIT 1').get('doc:' + Number(id)); }
  catch { return true; }
}

/**
 * The pooled candidates, refreshed for this tick. Returns { rows, mode: 'full'|'incremental', fresh }.
 * `fullTtlMs: 0` forces a full walk (a deliberate run that wants the store's current truth).
 */
function candidatePool(db, { now = Date.now(), fullTtlMs = POOL_FULL_TTL_MS, limit = POOL_LIMIT } = {}) {
  let pool = _readPool(db);
  const maxId = _maxDocId(db);
  // A pool that emptied while the last full walk was CAPPED (older candidates were left outside the
  // window) refills early — the drain must reach them, not wait out the TTL on an empty pool.
  const drained = pool && !pool.rows.length && pool.full;
  if (!pool || drained || !(fullTtlMs > 0) || now - pool.at >= fullTtlMs) {
    // The refresh KEEPS the lengths it already knows (boot_p257: the first full walk was 7.1s under boot
    // load — the body reads of 233 giants). The walk itself runs without the body; only ids the pool
    // has never measured pay for LENGTH, in one statement.
    const known = new Map(((pool && pool.rows) || []).map((r) => [Number(r.id), r]));
    const found = findUndecomposed(db, { limit, chars: false });
    const lengths = _charsOf(db, found.filter((r) => !known.has(Number(r.id))).map((r) => Number(r.id)));
    const rows = found
      .map((r) => known.get(Number(r.id)) || { ...r, chars: lengths.get(Number(r.id)) || 0 })
      .filter((r) => r.chars > 0);
    pool = { at: now, maxId, full: found.length >= limit, rows };
    _savePool(db, pool);
    return { rows: pool.rows, mode: 'full', fresh: rows.filter((r) => !known.has(Number(r.id))).length };
  }
  let fresh = 0;
  if (maxId > pool.maxId) {
    const add = findUndecomposed(db, { limit, sinceId: pool.maxId });
    const have = new Set(pool.rows.map((r) => Number(r.id)));
    const rows = pool.rows.slice();
    for (const r of add) if (!have.has(Number(r.id))) { rows.push(r); fresh++; }
    pool = { ...pool, maxId, rows };
    _savePool(db, pool);
  }
  return { rows: pool.rows, mode: 'incremental', fresh };
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
function nextBatch(db, { limit = 3, dailyChunks = DEFAULT_DAILY_CHUNKS, maxChars = Infinity, minChars = 400, now = Date.now(), poolTtlMs = POOL_FULL_TTL_MS } = {}) {
  const budget = budgetState(db, { now, dailyChunks });
  if (budget.remaining <= 0) return { picks: [], estChunks: 0, budget, pool: null };

  // The pooled candidate window (see THE CANDIDATE POOL above), then order by cost. The pool keeps
  // findUndecomposed's id-DESC order (newest first), which is the wrong axis for a backlog — the newest
  // document is often the largest. The attempted set is re-applied here as a guard: eviction is the
  // normal path, the marker is the truth.
  //
  // A FLOOR AS WELL AS A CEILING. Ordering purely by cost picks the emptiest documents first, and the
  // first live run proved it: 43, 56 and 105 characters — image-only PDFs whose text extraction found
  // nothing. Each would spend a call to learn nothing and then be marked attempted, so the budget goes
  // on documents that cannot teach us anything. Cheap is only good when there is something to read.
  const pooled = candidatePool(db, { now, fullTtlMs: poolTtlMs });
  const attempted = attemptedSet(db);
  const pool = pooled.rows
    .filter((r) => !attempted.has(Number(r.id)) && r.chars >= minChars && r.chars <= maxChars)
    .sort((a, b) => a.chars - b.chars);
  // PICK-TIME VERIFICATION: a pooled row whose document was decomposed by another path since the walk
  // is stale — one encounters seek says so, and it leaves the pool instead of costing a cloud read.
  const stale = [];
  const unread = (r) => { if (_stillUnread(db, r.id)) return true; stale.push(r.id); return false; };

  // INQUIRY PULL (2026-07-23, doc #8443): cheapest-first starves exactly the document an open inquiry
  // is WAITING on — the 1.47M-char LA elected-officials roster sat at cost-position 359/380 while
  // inquiry touches burned against its absence, and every fresh small landing outranks a giant, so
  // "eventually" never arrives. A doc whose TITLE word-matches an open inquiry's question vocabulary
  // (lib/focus.inquiryVocabTokens — the same stop/stem pipeline as the domain leash, so the two gates
  // cannot drift) jumps the cost queue. ONE pulled doc per batch — the pull is scarce on purpose, and
  // the daily budget still bounds the spend. Title-only match: candidate rows don't carry bodies, and
  // pulling 400 bodies per tick to check them would cost more than the starvation it fixes.
  let pulled = null;
  try {
    const iv = require('./focus').inquiryVocabTokens();
    if (iv && iv.size) {
      const matches = pool.filter((r) => {
        const words = new Set((String(r.title || '').toLowerCase().match(/[a-z]{4,}/g) || []));
        for (const t of iv) if (words.has(t)) return true;
        return false;
      });
      pulled = matches[0] || null;                  // pool is cost-sorted → cheapest match pulls first
    }
  } catch { /* no inquiry store / no focus lib → pure cost order, as before */ }

  const picks = [];
  let cost = 0;
  if (pulled) {
    const c = estChunks(pulled.chars);
    if (c <= budget.remaining && unread(pulled)) { picks.push(pulled); cost += c; }
  }
  for (const r of pool) {
    if (picks.length >= Math.max(1, limit)) break;
    if (pulled && r.id === pulled.id) continue;
    const c = estChunks(r.chars);
    if (cost + c > budget.remaining) continue;      // skip, do not stop — a smaller one may still fit
    if (!unread(r)) continue;                        // stale — evicted below, never offered
    picks.push(r); cost += c;
  }
  if (stale.length) _evictFromPool(db, stale);
  return { picks, estChunks: cost, budget, pool: { mode: pooled.mode, fresh: pooled.fresh, size: pooled.rows.length - stale.length, stale: stale.length } };
}

module.exports = {
  findUndecomposed, attemptedSet, markAttempted, META_KEY, DECOMPOSE_LANES,
  candidatePool, POOL_KEY, POOL_FULL_TTL_MS,
  nextBatch, budgetState, spendBudget, estChunks, BUDGET_KEY, DEFAULT_DAILY_CHUNKS,
};
