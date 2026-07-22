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

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
