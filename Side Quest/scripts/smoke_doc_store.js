/* Smoke: lib/doc_store + the documents table — the SHORT-TERM landing store (Slice 1). Proves a whole
 * document lands durably, idempotent landing on ref, the doc-QA candidate shaping, keyword recall, and the
 * promote/unpromoted lifecycle the nightly pass (Slice 2) will use. Uses an ISOLATED temp DB (SQ_DB_PATH).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_doc_store.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// isolated throwaway DB BEFORE requiring db
const tmp = path.join(os.tmpdir(), `sq_docstore_smoke_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.SQ_DB_PATH = tmp;

const db = require('../lib/db');
db.init();
const store = require('../lib/doc_store');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- toCandidates (PURE) — no DB needed ---
const cand = store.toCandidates([
  { id: 1, title: 'Rainey Huddle', body: 'Lucas — deliver materials.', created_ts: 100, source: 'canvas_drop' },
  { id: 2, title: 'Empty', body: '   ', created_ts: 200 },
]);
ok(cand.length === 1 && cand[0].markdown === 'Lucas — deliver materials.' && cand[0].openedAt === 100, 'toCandidates maps body→markdown, created_ts→openedAt, drops empties');

// --- land + durability ---
const r1 = store.land({ title: 'Rainey Weekly Huddle', body: '# Notes\nLucas Overby — deliver publishing materials to Sydney.', source: 'canvas_drop', ref: 'drop-rainey-abc', understanding: 'huddle notes' });
ok(r1.landed === true && r1.id, 'land stores a new document');
ok(db.recentDocuments(10).length === 1, 'recentDocuments shows the landed doc');
ok(db.getDocumentByRef('drop-rainey-abc').title === 'Rainey Weekly Huddle', 'getDocumentByRef finds it');

// --- idempotent on ref+body (the ingest poller can re-see the same tab) ---
const r2 = store.land({ title: 'Rainey Weekly Huddle', body: '# Notes\nLucas Overby — deliver publishing materials to Sydney.', source: 'canvas_drop', ref: 'drop-rainey-abc' });
ok(r2.landed === false && db.recentDocuments(10).length === 1, 'same ref+body → NOT re-landed (idempotent)');

// --- a CHANGED body for a ref lands (an iteration; Slice 2 links it) ---
const r3 = store.land({ title: 'Rainey Weekly Huddle (v2)', body: '# Notes\nUPDATED — added action items.', source: 'canvas_drop', ref: 'drop-rainey-abc' });
ok(r3.landed === true && db.recentDocuments(10).length === 2, 'changed body for the ref → lands as a new row (iteration)');

// --- a different doc ---
store.land({ title: 'Budget Q3', body: 'spreadsheet figures for Q3', source: 'canvas_drop', ref: 'drop-budget-xyz' });
ok(db.recentDocuments(10).length === 3, 'a second distinct doc lands');

// --- CONTENT DEDUP: the same file re-dropped under a DIFFERENT ref ---
// The live bug, reproduced. The canvas lane mints a fresh random suffix per drop, so the ref check above
// can never match and one memo landed twice (docs 6740/6741, identical hash). Measured on that lane:
// 183 documents from 126 distinct texts. Duplicate rows INFLATE CORROBORATION — three drops of one memo
// would read as three sources attesting to whatever it claims.
{
  const before = db.recentDocuments(50).length;
  const dup = store.land({ title: 'Rainey Weekly Huddle', body: '# Notes\nLucas Overby — deliver publishing materials to Sydney.', source: 'canvas_drop', ref: 'drop-rainey-mrtjm37h' });
  ok(dup.landed === false && db.recentDocuments(50).length === before,
    'CRITICAL: same bytes under a NEW ref → not re-landed');
  ok(dup.id === r1.id && dup.duplicateOf === r1.id,
    'it resolves to the ORIGINAL document id, so callers cite the first encounter');
  // Trivial reformatting must not defeat it either — the hash is whitespace- and case-normalised.
  const dup2 = store.land({ title: 'Rainey', body: '# NOTES\n  Lucas Overby — deliver publishing materials to Sydney.  ', source: 'canvas_drop', ref: 'drop-rainey-zzz' });
  ok(dup2.landed === false, 'a re-save with different whitespace/case is still the same text');
  // …but a genuinely different document still lands. (Removed again so the promotion counts below,
  // which assert on the whole table, keep measuring what they were written to measure.)
  const distinct = store.land({ title: 'Other', body: 'genuinely different content here', source: 'canvas_drop', ref: 'drop-other' });
  ok(distinct.landed === true, 'dedup does not swallow distinct documents');
  db.getDb().prepare('DELETE FROM documents WHERE id = ?').run(distinct.id);
}

// --- candidates() feeds doc-QA, newest first ---
const cands = store.candidates(10);
ok(cands.length === 3 && cands[0].title === 'Budget Q3', 'candidates() returns docs newest-first in doc-QA shape');

// --- recall (keyword over title+body) ---
const hits = store.recall('publishing materials', 10);
ok(hits.length >= 1 && hits.some(h => /Rainey/.test(h.title)), 'recall finds a doc by body keyword');
ok(store.recall('nonexistent-term-xyzzy', 10).length === 0, 'recall misses → []');

// --- promote lifecycle (Slice 2 hook) ---
const unp1 = db.listUnpromotedDocuments(100);
ok(unp1.length === 3, 'all docs start un-promoted (short-term)');
db.markDocumentPromoted(unp1[0].id, 'echo-doc-123');
const unp2 = db.listUnpromotedDocuments(100);
ok(unp2.length === 2, 'markDocumentPromoted removes one from the un-promoted set');
ok(db.getDocument(unp1[0].id).promoted === 1 && db.getDocument(unp1[0].id).promoted_ref === 'echo-doc-123', 'promoted doc carries promoted=1 + the Echo ref');

// --- PROMOTION FAIR-SHARE: no lane starves (2026-07-25, "we leave nothing behind") ---
// Live measurement: a global id-ASC FIFO at 20/pass starved every young/low-volume lane behind the
// bulk — conversation 152 landed / 0 promoted, inquiry 155/0, meeting 9/0, while browser_download
// (460/day) and news held the head. Round-robin: one pass must advance EVERY source, taking rank-1
// (each source's oldest) from all before any source's rank-2. Memory-event classes lead each round.
{
  // Clear the 2 pending canvas_drops so this block controls the whole queue.
  for (const d of db.listUnpromotedDocuments(100)) db.getDb().prepare('DELETE FROM documents WHERE id=?').run(d.id);

  // A bulk lane FLOODS the queue first (lowest ids), then low-volume lanes land AFTER (higher ids) —
  // the exact starvation setup. 6 browser_downloads, then 1 each of the small lanes.
  const ids = {};
  for (let i = 0; i < 6; i++) store.land({ title: `dl ${i}`, body: `downloaded web page number ${i} with enough body`, source: 'browser_download', ref: `dl-${i}` });
  for (const src of ['conversation', 'inquiry', 'meeting', 'research', 'canvas_drop']) {
    const r = store.land({ title: `${src} A`, body: `first ${src} document with a real body of text here`, source: src, ref: `${src}-A` });
    ids[src] = r.id;
  }

  const q = db.listUnpromotedDocuments(6);   // one pass of 6
  const srcs = q.map(d => d.source);
  ok(new Set(srcs).size === 6, `a 6-doc pass touches 6 DISTINCT sources, not 6 of one lane — got: ${srcs.join(',')}`);
  ok(!srcs.includes('browser_download') || srcs.filter(s => s === 'browser_download').length === 1,
    'the flooding bulk lane takes at most ONE slot in the round, never crowding the others out');
  ok(srcs[0] === 'conversation' || srcs[0] === 'meeting',
    `a memory-event class leads the round (got "${srcs[0]}")`);
  for (const src of ['conversation', 'inquiry', 'meeting', 'research', 'canvas_drop']) {
    ok(srcs.includes(src), `low-volume lane "${src}" is served in the SAME pass as the bulk (never starved)`);
  }

  // Within a source, still oldest-first: a second conversation ranks behind the first.
  const c2 = store.land({ title: 'conv B', body: 'second conversation document, later in time than the first', source: 'conversation', ref: 'conversation-B' });
  const convOrder = db.listUnpromotedDocuments(100).filter(d => d.source === 'conversation').map(d => d.id);
  ok(convOrder[0] === ids['conversation'] && convOrder[1] === c2.id, 'within a lane, FIFO (oldest of that lane first)');

  // ⭐ THE PROMOTE LEDGER (continuity cure #3, 2026-09-02): a failed doc steps aside, it is never retried the same day
  {
    const DAY = 24 * 3600 * 1000, T0 = Date.now();
    ok(db.notePromoteFailure(ids['conversation'], "ingest: Error calling tool 'ingest_file': database is locked", { now: T0 }) === true, 'notePromoteFailure stamps the row');
    const row = db.getDocument(ids['conversation']);
    ok(row.promote_attempts === 1 && row.promote_last_ts === T0 && /database is locked/.test(row.promote_error), `the ledger on the row: attempts 1, time, error — ${row.promote_error}`);
    const after = db.listUnpromotedDocuments(100, { now: T0 + 60 * 1000 }).filter(d => d.source === 'conversation').map(d => d.id);
    ok(after[0] === c2.id && !after.includes(ids['conversation']), '⭐ inside its 1-day backoff the failed doc steps aside — the lane\'s next doc leads (rotation, not a stall)');
    ok(db.listUnpromotedDocuments(100, { now: T0 + DAY + 1000 }).some(d => d.id === ids['conversation']), 'after the backoff it is back (never dropped)');
    db.notePromoteFailure(ids['conversation'], 'ingest: another row available', { now: T0 + DAY + 1000 });
    ok(!db.listUnpromotedDocuments(100, { now: T0 + 2 * DAY + 2000 }).some(d => d.id === ids['conversation']) && db.listUnpromotedDocuments(100, { now: T0 + 3 * DAY + 3000 }).some(d => d.id === ids['conversation']), 'two failures → a 2-day backoff (doubling)');
    const bl = db.promoteDocsBacklog({ now: T0 + 60 * 1000 });
    ok(bl.pending >= 12 && bl.backingOff === 1 && bl.eligible === bl.pending - 1 && bl.errors.some(e => /another row available/.test(e.error)), `the backlog shape for the tee: ${JSON.stringify(bl)}`);
    ok(db.listUnpromotedDocuments(100, { now: T0 + 60 * 1000 }).filter(d => d.source === 'conversation').length === 1, 'the untried doc of the same lane still promotes while the failed one backs off');
  }

  // reset for the fail-safe block below
  for (const d of db.listUnpromotedDocuments(200)) db.getDb().prepare('DELETE FROM documents WHERE id=?').run(d.id);
  store.land({ title: 'Rainey Weekly Huddle', body: '# Notes\nLucas Overby — deliver publishing materials to Sydney.', source: 'canvas_drop', ref: 'drop-rainey-abc' });
  store.land({ title: 'Rainey Weekly Huddle (v2)', body: '# Notes\nUPDATED — added action items.', source: 'canvas_drop', ref: 'drop-rainey-abc' });
  store.land({ title: 'Budget Q3', body: 'spreadsheet figures for Q3', source: 'canvas_drop', ref: 'drop-budget-xyz' });
}

// --- fail-safe ---
ok(store.land({ body: '' }).landed === false, 'empty body → not landed (no throw)');
ok(store.toCandidates(null).length === 0, 'toCandidates(null) → [] (no throw)');

try { fs.unlinkSync(tmp); } catch {}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
