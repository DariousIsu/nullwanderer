/* smoke_decompose_sweep.js — documents that landed but were never read.
 *
 * decomposeLandedDoc (main.js:9029) is called from five specific INGEST paths, so decomposition is
 * coupled to how a document ARRIVED rather than to the document itself. scripts/research_org.js landed
 * raineycenter.org and raineyfreedom.org with correct origins and produced ZERO encounters — the
 * sentence naming the sister organisation sat in the corpus, unread.
 *
 * Runs against an in-memory database.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_decompose_sweep.js
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
process.env.SQ_DB_PATH = ':memory:';

const db = require('../lib/db');
db.init();
const sweep = require('../lib/decompose_sweep');
const enc = require('../lib/encounters');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

const land = (title, body, source) => db.insertDocument({ title, body, source, origin: `https://x.test/${encodeURIComponent(title)}` }).id;

// Three documents: one read, one never read, one that will be attempted and yield nothing.
const readDoc = land('Was read', 'Alcona County Board of Commissioners met.', 'browser_download');
const unread = land('Never read', 'The Rainey Center and its affiliates foster dialogue.', 'org_research');
const barren = land('Chrome only', 'Home About Contact Donate Menu', 'org_research');

enc.record({ object_type: 'gov', object_label: 'Alcona County Board', claim_class: 'existence',
  source_kind: 'document', source_ref: `doc:${readDoc}`, origin_host: 'x.test', content_hash: 'h1' });

// ── the selection ────────────────────────────────────────────────────────────────────────────────
{
  const found = sweep.findUndecomposed(db).map((r) => r.id);
  ok(!found.includes(readDoc), 'CRITICAL: a document that produced encounters is NOT re-read');
  ok(found.includes(unread) && found.includes(barren), 'documents that produced nothing ARE found');
}
{
  const rows = sweep.findUndecomposed(db);
  const r = rows.find((x) => x.id === unread);
  ok(r && r.source === 'org_research' && r.chars > 0 && r.origin_host === 'x.test',
    'each candidate carries what a caller needs to decide and to log');
}

// ── AN ATTEMPT IS RECORDED SEPARATELY FROM A RESULT ──────────────────────────────────────────────
// A page of navigation chrome can be read honestly and yield nothing. If absence of encounters were
// the only test it would be re-read on every sweep forever, burning a cloud extraction each time to
// produce the same nothing.
{
  sweep.markAttempted(db, [barren]);
  const found = sweep.findUndecomposed(db).map((r) => r.id);
  ok(!found.includes(barren),
    'CRITICAL: a document already ATTEMPTED is not retried, even though it still has no encounters');
  ok(found.includes(unread), '…and an untried one is still offered');
}
{
  ok(sweep.attemptedSet(db).has(barren), 'the attempted marker persists');
  sweep.markAttempted(db, [unread]);
  ok(sweep.findUndecomposed(db).length === 0, 'once everything is attempted the sweep is empty');
}

// ── bounds and filters ───────────────────────────────────────────────────────────────────────────
{
  const a = land('A', 'body a', 'org_research');
  const b = land('B', 'body b', 'news');
  ok(sweep.findUndecomposed(db, { sources: ['org_research'] }).map((r) => r.id).includes(a), 'sources filter selects a lane');
  ok(!sweep.findUndecomposed(db, { sources: ['org_research'] }).map((r) => r.id).includes(b), '…and excludes the others');
  ok(sweep.findUndecomposed(db, { limit: 1 }).length === 1, 'limit bounds the batch');
  ok(sweep.findUndecomposed(db, { sinceId: b }).every((r) => r.id > b), 'sinceId bounds the range');
}
{
  // An empty body is not a document to read.
  const empty = db.insertDocument({ title: 'Empty', body: '   ', source: 'org_research' });
  ok(empty === null || !sweep.findUndecomposed(db).map((r) => r.id).includes(empty && empty.id),
    'a blank document is never offered');
}
ok(Array.isArray(sweep.findUndecomposed(db, { limit: 0 })), 'garbage bounds → an array, never a throw');

// ── THE BUDGET — because the backlog is 405 MILLION characters ───────────────────────────────────
// Measured live: 3,211 unread documents, ~69,000 chunks, ~138,000 model calls with the adjudicator.
// A backlog reader that can spend that accidentally is a bug however correct its selection is.
{
  const big = db.insertDocument({ title: 'Huge', body: 'x'.repeat(120000), source: 'browser_download' }).id;
  const mid = db.insertDocument({ title: 'Mid', body: 'y'.repeat(12000), source: 'browser_download' }).id;
  const small = db.insertDocument({ title: 'Small', body: 'z'.repeat(1200), source: 'browser_download' }).id;
  const empty = db.insertDocument({ title: 'Image-only PDF', body: 'scan', source: 'browser_download' }).id;

  const b = sweep.nextBatch(db, { limit: 5 });
  const ids = b.picks.map((p) => p.id);
  ok(ids[0] === small && ids.indexOf(mid) > ids.indexOf(small),
    'CRITICAL: CHEAPEST FIRST — 62% of the corpus is under 20k chars, and reading a 425k judicial PDF first buys the least for the most');
  ok(ids.includes(big) && ids.indexOf(big) > ids.indexOf(mid),
    'NO DEFAULT SIZE CEILING — a giant is read too, LAST; the old maxChars=60000 put every backlogged multi-million-char PDF permanently outside the sweep');
  ok(!sweep.nextBatch(db, { limit: 5, maxChars: 50000 }).picks.map((p) => p.id).includes(big),
    '…but an explicit maxChars still bounds a deliberate run');
  ok(!ids.includes(empty),
    'CRITICAL: a FLOOR as well as a ceiling — ordering purely by cost picked 43-, 56- and 105-char image-only PDFs on the first live run, spending calls to learn nothing');
}
{
  const st = sweep.budgetState(db);
  ok(st.remaining === st.limit && st.spent === 0, 'a fresh day starts with the full budget');
  sweep.spendBudget(db, 5);
  ok(sweep.budgetState(db).spent === 5 && sweep.budgetState(db).remaining === st.limit - 5, 'spending is tracked');
  ok(sweep.budgetState(db, { now: Date.now() + 2 * 86400000 }).spent === 0, 'the budget resets on the calendar day');
}
{
  // The ceiling must be enforced BEFORE the work, or a stuck loop outspends it.
  sweep.spendBudget(db, 10000);
  const b = sweep.nextBatch(db, { limit: 5 });
  ok(b.picks.length === 0 && b.budget.remaining === 0,
    'CRITICAL: at the ceiling the lane picks NOTHING — a quiet state, not an error');
  ok(sweep.nextBatch(db, { limit: 5, dailyChunks: 99999 }).picks.length > 0, 'raising the ceiling releases work again');
}
{
  // A smaller document must still fit after a large one is skipped — skip, do not stop.
  const b = sweep.nextBatch(db, { limit: 3, dailyChunks: 99999, maxChars: 200000 });
  ok(b.estChunks > 0 && b.picks.length > 0, 'the batch reports what it will cost before spending it');
  // One budget unit = one MODEL CALL at the 100k decompose slice main.js passes. The old 6k estimator
  // made a 5M-char PDF "cost" 848 units — silently re-imposing the ceiling the chunking change removed.
  ok(sweep.estChunks(100000) === 1 && sweep.estChunks(250000) === 3, 'chunk estimation mirrors the extractor’s real slicing (100k)');
}

// ── THE INQUIRY PULL (2026-07-23, doc #8443) ─────────────────────────────────────────────────────
// Cheapest-first starves exactly the document an open inquiry is WAITING on: the 1.47M-char LA
// roster sat at cost-position 359/380 while inquiry touches burned against its absence, and every
// fresh small landing outranks a giant. A title that word-matches an open inquiry's question vocab
// jumps the queue — ONE per batch, budget still binding.
{
  const inquiry = require('../lib/inquiry');
  const roster = db.insertDocument({ title: 'LA-parish-officials-2026.xls', body: 'r'.repeat(300000), source: 'browser_download' }).id;
  const iq = inquiry.open({ question: 'Who currently holds each parish-level elected office across all 64 Louisiana parishes — sheriffs, clerks of court, assessors?' });
  ok(iq && iq.id, 'inquiry.open seeds an active inquiry in the sweep smoke db');

  const b1 = sweep.nextBatch(db, { limit: 2, dailyChunks: 99999 });
  ok(b1.picks.length === 2 && b1.picks[0].id === roster,
    'CRITICAL: an inquiry-matched giant JUMPS the cost queue (it would otherwise be picked dead last)');
  ok(b1.picks[1] && b1.picks[1].chars <= b1.picks[0].chars,
    '…and the rest of the batch resumes cheapest-first');

  const clerks = db.insertDocument({ title: 'Louisiana-clerks-directory.pdf', body: 'c'.repeat(5000), source: 'browser_download' }).id;
  const b2 = sweep.nextBatch(db, { limit: 2, dailyChunks: 99999 });
  ok(b2.picks[0].id === clerks && !b2.picks.map((p) => p.id).includes(roster),
    'ONE pull per batch — the cheapest match pulls, the other match waits its turn (scarce on purpose)');

  inquiry.close(iq.id, { kind: 'answered', answer: 'roster consumed' });
  const b3 = sweep.nextBatch(db, { limit: 2, dailyChunks: 99999 });
  ok(b3.picks[0].id !== roster && b3.picks[0].chars <= b3.picks[1].chars,
    'no open inquiry → pure cheapest-first restored (the pull leaves with the inquiry)');
}

// ── INVERSION 2026-07-30 (inventory §8): every lane decomposes by default; only self-keyed lanes stay out ──
{
  const inq = land('Inquiry finding', 'The parish presidents table compiled at touch 13.', 'inquiry');
  const auto = land('Autonomy artifact', 'A real document she built during an idle tick.', 'autonomy');
  const news = land('News item', 'Data centers strain the Texas grid, ERCOT warns.', 'news');
  const meet = land('Meeting notes', 'The board discussed the levee appropriation.', 'meeting');
  const found = sweep.findUndecomposed(db, { limit: 50 }).map((r) => r.id);
  ok(found.includes(inq) && found.includes(auto), 'CRITICAL: lanes outside the old allowlist (inquiry, autonomy) are READ by default now');
  ok(!found.includes(news) && !found.includes(meet), 'self-keyed lanes (news, meeting) stay out — they write their own encounter refs');
  const only = sweep.findUndecomposed(db, { limit: 50, sources: ['inquiry'] }).map((r) => r.id);
  ok(only.includes(inq) && !only.includes(auto), 'an explicit sources filter still narrows to one lane');
}

// ── THE CANDIDATE POOL (freeze cut 5, 2026-09-03) ────────────────────────────────────────────────
// boot_p256: findUndecomposed ran 47× for 258s of main-thread block — 235 unattempted candidates
// carrying 88M chars, re-read every 5 minutes for lengths already known, to pick two documents. The
// pool walks once, refreshes incrementally above its high-water id, evicts on attempt, is persisted,
// and re-verifies each pick against encounters.
{
  const T0 = Date.now();
  const b1 = sweep.nextBatch(db, { limit: 50, dailyChunks: 99999, now: T0 });
  ok(b1.pool && ['full', 'incremental'].includes(b1.pool.mode) && b1.pool.size > 0, 'nextBatch reports the pool it drew from');
  const late = land('Late arrival', 'l'.repeat(2000), 'browser_download');
  const b2 = sweep.nextBatch(db, { limit: 50, dailyChunks: 99999, now: T0 + 1000 });
  ok(b2.pool.mode === 'incremental' && b2.pool.fresh >= 1 && b2.picks.some((p) => p.id === late),
    'CRITICAL: a document landed after the walk is offered on the next tick — an incremental refresh above the high-water id, not a full walk');
  sweep.markAttempted(db, [late]);
  const b3 = sweep.nextBatch(db, { limit: 50, dailyChunks: 99999, now: T0 + 2000 });
  ok(b3.pool.mode === 'incremental' && !b3.picks.some((p) => p.id === late), 'an attempted document leaves the pool the same moment');
  const other = land('Read elsewhere', 'o'.repeat(2000), 'browser_download');
  const b4 = sweep.nextBatch(db, { limit: 50, dailyChunks: 99999, now: T0 + 3000 });
  ok(b4.picks.some((p) => p.id === other), 'a pooled document is offered while it is unread');
  enc.record({ object_type: 'gov', object_label: 'Elsewhere Board', claim_class: 'existence',
    source_kind: 'document', source_ref: `doc:${other}`, origin_host: 'x.test', content_hash: 'h2' });
  const b5 = sweep.nextBatch(db, { limit: 50, dailyChunks: 99999, now: T0 + 4000 });
  ok(!b5.picks.some((p) => p.id === other) && b5.pool.stale >= 1,
    'CRITICAL: a pooled document decomposed by ANOTHER path since the walk is caught at pick time — one probe, never a cloud read');
  ok(sweep.candidatePool(db, { now: T0 + 5000 }).rows.every((r) => r.id !== other), '…and it is evicted from the pool');
  ok(!!db.getMeta(sweep.POOL_KEY), 'the pool lives in meta next to the attempted set');
  delete require.cache[require.resolve('../lib/decompose_sweep')];
  const sweep2 = require('../lib/decompose_sweep');
  const b6 = sweep2.nextBatch(db, { limit: 50, dailyChunks: 99999, now: T0 + 6000 });
  ok(b6.pool.mode === 'incremental', 'CRITICAL: the pool is PERSISTED — a fresh process (a reboot) does not pay the full walk again');
  const b7 = sweep2.nextBatch(db, { limit: 50, dailyChunks: 99999, now: T0 + sweep.POOL_FULL_TTL_MS + 7000 });
  ok(b7.pool.mode === 'full', 'past the TTL the pool is rebuilt from the store');
  ok(sweep2.nextBatch(db, { limit: 50, dailyChunks: 99999, now: T0 + 1000, poolTtlMs: 0 }).pool.mode === 'full', 'poolTtlMs: 0 forces a full walk (a deliberate run)');
  // The refresh keeps known lengths and measures only new ids (boot_p257: the first walk was 7.1s of body reads)
  const bare = sweep2.findUndecomposed(db, { limit: 50, chars: false });
  const full = sweep2.findUndecomposed(db, { limit: 50 });
  ok(bare.length >= full.length && bare.every((r) => r.chars === null) && full.every((r) => r.chars > 0 && bare.some((b) => b.id === r.id)),
    'chars:false walks without the body (chars null, same ids) — the refresh measures only what it has never measured');
  const refreshed = sweep2.candidatePool(db, { now: T0 + 2 * sweep.POOL_FULL_TTL_MS });
  ok(refreshed.mode === 'full' && refreshed.rows.length > 0
     && refreshed.rows.every((r) => r.chars > 0 && r.chars === String((db.getDocument(r.id) || {}).body || '').length),
    'a TTL refresh carries every candidate with its REAL length (known ones kept, new ones measured, empty bodies dropped)');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
