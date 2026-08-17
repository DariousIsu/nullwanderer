'use strict';
/* smoke_documents_fts.js — the metabolism-stall cure (2026-08-17).
 *
 * heldContext (lib/recheck_queue) built EVERY metabolism verification prompt with a full-table
 * `title LIKE '%tok%' OR body LIKE '%tok%'` scan over ~17k docs / 1.29GB body — a MEASURED ~1.4s
 * SYNCHRONOUS main-thread block, 1–3× per tick: the adversarially-confirmed carrier of the ~3.4s
 * metabolism stall. Fix: an external-content documents_fts (fts5) filled by db.syncDocumentsFts; heldContext
 * MATCHes it (~1ms) once built and FALLS BACK to the LIKE until then, so it can never regress recall.
 * This proves: LIKE fallback pre-build; MATCH RECALL PARITY post-build (incl a body-only match — the exact
 * county case that killed the cheap title-only bound); graceful empties; incremental append; and the wiring.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_documents_fts.js
 */
const fs = require('fs'), path = require('path'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_docfts_${process.pid}_${Date.now().toString(36)}.db`);
process.env.SQ_DB_PATH = tmp;
const ROOT = 'C:/Users/azrae/Desktop/Side Quest';
const db = require(ROOT + '/lib/db');
const rq = require(ROOT + '/lib/recheck_queue');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  try {
    db.init();
    const now = Date.now();
    const ins = db.getDb().prepare('INSERT INTO documents(id,title,body,source,created_ts) VALUES(?,?,?,?,?)');
    ins.run(1, 'Barbour County Commission', 'The governing body roster and members of Barbour County, West Virginia.', 'held', now);
    ins.run(2, 'Maritime shipping notice', 'Something entirely about maritime law and cargo — no civic subject here.', 'held', now - 1000);
    ins.run(3, 'Acadia Parish council', 'Louisiana parish governing council members and contacts for acadia parish.', 'held', now - 2000);
    // THE BODY-ONLY CASE: none of the subject tokens are in the TITLE, only the body (why title-only bounds fail).
    ins.run(4, 'Meeting notes — Q3', 'barbour county west virginia council met to discuss the annual budget.', 'notes', now - 500);

    const SUBJ = 'barbour county west virginia';

    // 1. BEFORE build: not ready → heldContext uses the LIKE fallback (today's behaviour, unchanged)
    ok(!db.documentsFtsReady(), 'documents_fts is NOT ready before the first sync (built flag unset)');
    const like = rq.heldContext(SUBJ);
    ok(/doc#1/.test(like) && /doc#4/.test(like), 'LIKE fallback surfaces the title match (doc#1) AND the body-only match (doc#4)');
    ok(!/doc#2/.test(like), 'LIKE fallback excludes the unrelated maritime doc#2');

    // 2. sync BUILDS the index — chunked (batch 2 forces the multi-chunk fill path to run)
    let r, guard = 0; do { r = db.syncDocumentsFts({ batch: 2 }); } while (!r.caughtUp && ++guard < 50);
    ok(r.caughtUp && db.documentsFtsReady(), 'syncDocumentsFts fills the index over bounded chunks → ready');

    // 3. AFTER build: the MATCH fast-path returns the SAME held docs (RECALL PARITY, incl the body-only doc#4)
    const match = rq.heldContext(SUBJ);
    ok(/doc#1/.test(match) && /doc#4/.test(match), 'MATCH recall parity — same held docs as LIKE, INCLUDING the body-only doc#4');
    ok(!/doc#2/.test(match), 'MATCH excludes the unrelated doc#2 (AND-of-tokens intent preserved)');

    // 4. graceful empties — no crash, and a genuine no-hit does NOT silently fall back to the slow LIKE
    ok(rq.heldContext('a') === '', 'a subject with no usable tokens → empty string, never a throw');
    ok(rq.heldContext('zzqqxxnonexistentsubjectxyz') === '', 'a genuine MATCH no-hit → empty (returns [], not a LIKE re-scan)');

    // 5. incremental append: a NEW doc past the watermark is picked up by the next sync
    ins.run(5, 'Fresh Barbour update', 'newly landed: barbour county west virginia council special election', 'held', now + 1);
    db.syncDocumentsFts();
    ok(/doc#5/.test(rq.heldContext(SUBJ)), 'a new doc landed after the watermark is indexed by the next sync and found via MATCH');

    // 6. WIRING — a background tick keeps the index fresh
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    ok(/db\.syncDocumentsFts\(\)/.test(mainSrc) && /docfts-sync/.test(mainSrc), 'main.js runs a background documents_fts sync tick');
    const rqSrc = fs.readFileSync(path.join(ROOT, 'lib', 'recheck_queue.js'), 'utf8');
    ok(/documents_fts MATCH/.test(rqSrc) && /documentsFtsReady/.test(rqSrc), 'heldContext prefers the FTS MATCH and gates on readiness');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
