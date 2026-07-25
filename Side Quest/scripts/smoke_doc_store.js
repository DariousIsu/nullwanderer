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

// --- PROMOTION PRIORITY: memory-event classes jump the FIFO (2026-07-25 starvation fix) ---
// Live measurement: 152 conversations landed, 0 promoted — 3,879 lower-id bulk docs (browser_download
// / news / canvas_drop) sat ahead of them in a pure id-ASC queue, ~194 days deep at 20/pass. A
// conversation that lands AFTER a pile of bulk docs must still promote FIRST, or chat memory never
// reaches long-term.
{
  const pendingBulk = db.listUnpromotedDocuments(100).map(d => d.id);   // the 2 older canvas_drops
  const convo = store.land({ title: 'Conversation — chat', body: 'Lucas: hi there\n\nZoe: hey, good to see you', source: 'conversation', ref: 'conversation-1-2' });
  const meet = store.land({ title: 'Meeting notes', body: 'standup notes with action items for the week', source: 'meeting', ref: 'meeting-xyz' });
  ok(convo.landed && meet.landed && convo.id > Math.max(...pendingBulk),
    'the conversation lands with a HIGHER id than the pending bulk docs (the starvation setup)');
  const q = db.listUnpromotedDocuments(100);
  const firstTwo = q.slice(0, 2).map(d => d.source).sort().join(',');
  ok(firstTwo === 'conversation,meeting', 'conversation + meeting promote FIRST despite their higher ids');
  ok(q[q.length - 1].source === 'canvas_drop', 'the older bulk canvas_drop is pushed to the BACK of the queue');
  const conv2 = store.land({ title: 'Conversation 2', body: 'Lucas: another thread here\n\nZoe: sure, tell me more', source: 'conversation', ref: 'conversation-3-4' });
  const convQ = db.listUnpromotedDocuments(100).filter(d => d.source === 'conversation');
  ok(convQ.length === 2 && convQ[0].id < convQ[1].id, 'within the memory-event tier, still oldest-first (FIFO)');
  // clean up so the fail-safe counts below are unaffected
  for (const id of [convo.id, meet.id, conv2.id]) db.getDb().prepare('DELETE FROM documents WHERE id = ?').run(id);
}

// --- fail-safe ---
ok(store.land({ body: '' }).landed === false, 'empty body → not landed (no throw)');
ok(store.toCandidates(null).length === 0, 'toCandidates(null) → [] (no throw)');

try { fs.unlinkSync(tmp); } catch {}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
