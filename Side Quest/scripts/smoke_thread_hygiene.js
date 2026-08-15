/* Smoke: the worklist-hygiene cluster (2026-08-15 deep-dive §4). Hermetic temp sq.db.
 *   B3 — touchOpenThread bumps action_count only on a real progress note (bare touch / lane stamp: no bump).
 *   B2 — the beat churn guard's reuse/reopen queries (identical open → reuse; identical resolved → reopen).
 *   B7 — a thread-born need's green exit resolves its mother thread (markOpenThreadStatus path).
 *   B4 — extractFromUserTurn SERIALIZES: overlapping calls never interleave (the injected worker seam).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_thread_hygiene.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `sq_smoke_thyg_${process.pid}_${Date.now().toString(36)}.db`);
process.env.SQ_DB_PATH = tmp;
const db = require('../lib/db');
const ot = require('../lib/open_threads');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const acOf = (id) => db.getDb().prepare('SELECT COALESCE(action_count,0) c FROM open_threads WHERE id = ?').get(id).c;
const statusOf = (id) => db.getDb().prepare('SELECT status FROM open_threads WHERE id = ?').get(id).status;

(async () => {
  try {
    db.init();

    // ── B3: action_count only increments on a real action (a progress note) ──
    console.log('B3 — action_count wakes up');
    const t = db.insertOpenThread({ content: 'validate the Louisiana parish leadership roster' });
    ok(acOf(t.id) === 0, 'fresh thread → action_count 0');
    db.touchOpenThread(t.id, 'covered St. Charles Parish — 7 seats confirmed');
    ok(acOf(t.id) === 1, 'a touch WITH a progress note → +1 (the driver paths finally count)');
    db.touchOpenThread(t.id, 'covered Jefferson Parish — 9 seats');
    ok(acOf(t.id) === 2, 'each worked slice increments');
    db.touchOpenThread(t.id);                          // bare touch — no note
    ok(acOf(t.id) === 2, 'a bare touch (no note) does NOT count as an action');
    db.touchOpenThread(t.id, 'lane stamp', { keepStatus: true });
    ok(acOf(t.id) === 3, 'a stamp with a note still counts (the note IS the action record)');
    db.touchOpenThread(t.id, null, { keepStatus: true });
    ok(acOf(t.id) === 3, 'a keepStatus stamp with NO note does not count');

    // ── B2: the churn-guard reuse/reopen queries (the beat mint→resolve→remint killer) ──
    console.log('B2 — churn guard reuse/reopen');
    const goal = 'Research every county board in California';
    const norm = goal.replace(/\s+/g, ' ').trim().toLowerCase();
    const original = db.insertOpenThread({ content: goal });
    const openMatch = (db.getActiveOpenThreads(300) || []).find((x) => String(x.content || '').replace(/\s+/g, ' ').trim().toLowerCase() === norm);
    ok(openMatch && openMatch.id === original.id, 'identical OPEN content → reuse the existing thread (no mint)');
    db.markOpenThreadStatus(original.id, 'resolved', { reason: 'test' });
    const openMatch2 = (db.getActiveOpenThreads(300) || []).find((x) => String(x.content || '').replace(/\s+/g, ' ').trim().toLowerCase() === norm);
    ok(!openMatch2, 'once resolved it leaves the ACTIVE pool (would otherwise re-mint)');
    const resMatch = db.getDb().prepare("SELECT id FROM open_threads WHERE status = 'resolved' AND lower(content) = ? ORDER BY id DESC LIMIT 1").get(norm);
    ok(resMatch && resMatch.id === original.id, 'the resolved twin is findable for REOPEN (history survives, no re-mint)');
    db.getDb().prepare("UPDATE open_threads SET status = 'pending' WHERE id = ?").run(resMatch.id);
    ok(statusOf(original.id) === 'pending', 'reopen restores it in place — same id, same history');

    // ── B7: a thread-born need's green exit auto-resolves the mother thread ──
    console.log('B7 — tool-lane auto-close');
    const mother = db.insertOpenThread({ content: 'she needs a tool to fetch FEC committee totals' });
    // (the live path: need.born_from = `thread-<id>` → on green, markOpenThreadStatus(id,'resolved'))
    db.markOpenThreadStatus(mother.id, 'resolved', { reason: 'capability need #99 went green — proposal card out' });
    ok(statusOf(mother.id) === 'resolved', 'green need → mother thread resolved (no longer pending forever)');
    const notes = JSON.parse(db.getDb().prepare('SELECT progress_notes FROM open_threads WHERE id = ?').get(mother.id).progress_notes || '[]');
    ok(notes.some((n) => /went green/.test(n.reason || '')), 'the resolve trail names why (card out)');

    // ── B3 guard: the over-pursuit breaker must NOT abandon a healthy large bounded run ──
    console.log('B3 guard — coverage-bounded runs are exempt from the over-pursuit breaker');
    const curator = require('../lib/curator');
    // an unbounded chat-spawned fixation over the bar → SHOULD retire
    const fixation = db.insertOpenThread({ content: 'learn absolutely everything about permitting reform' });
    db.getDb().prepare('UPDATE open_threads SET action_count = 120, last_touched_ts = ? WHERE id = ?').run(Date.now(), fixation.id);
    // a large BOUNDED run at the same count (58-county coverage) → must SURVIVE (it bounds itself)
    const bounded = db.insertOpenThread({ content: 'validate every county board in California' });
    db.getDb().prepare('UPDATE open_threads SET action_count = 120, last_touched_ts = ? WHERE id = ?').run(Date.now(), bounded.id);
    db.setMeta(`focus.${bounded.id}.universe`, '58');
    curator.curateThreads({ staleDays: 9999, activeStaleDays: 9999 });   // disable the staleness arms; isolate the runaway breaker
    ok(statusOf(fixation.id) === 'abandoned', 'unbounded fixation over 60 actions → retired (the breaker still fires)');
    ok(statusOf(bounded.id) !== 'abandoned', 'a coverage-bounded run at the same count → SURVIVES (bounds itself; not the fixation class)');

    // ── B3 double-count guard (backcheck): a [thread-progress:N] tag must add EXACTLY +1, not +2 ──
    console.log('B3 backcheck — the tag path does not double-count');
    const tagT = db.insertOpenThread({ content: 'track the FEC committee totals' });
    ot.parseAndApplyStatusUpdates(`[thread-progress:${tagT.id} pulled Q3 filing]`);
    ok(acOf(tagT.id) === 1, 'one [thread-progress] tag → +1 (touchOpenThread is the single counter; the redundant increment is gone)');
    ot.parseAndApplyStatusUpdates(`[thread-progress:${tagT.id} pulled Q4 filing]`);
    ok(acOf(tagT.id) === 2, 'a second tag → +1 (matches the driver/worked-slice path — the two are comparable again)');
    const doneT = db.insertOpenThread({ content: 'finish the donor rollup' });
    ot.parseAndApplyStatusUpdates(`[thread-done:${doneT.id} shipped]`);
    ok(acOf(doneT.id) === 1 && statusOf(doneT.id) === 'resolved', 'a [thread-done] tag still counts its one action + resolves');

    // ── B4: extractFromUserTurn serializes (overlapping calls never interleave) ──
    console.log('B4 — extraction serialization');
    const order = [];
    let active = 0, maxActive = 0;
    const worker = (tag, delay) => async () => {
      active++; maxActive = Math.max(maxActive, active);
      order.push(`start:${tag}`);
      await new Promise((r) => setTimeout(r, delay));
      order.push(`end:${tag}`);
      active--;
      return [{ id: tag }];
    };
    // fire three "concurrently" — the chain must run them strictly in order, never overlapping
    const p1 = ot.extractFromUserTurn({ _worker: worker('A', 40) });
    const p2 = ot.extractFromUserTurn({ _worker: worker('B', 5) });
    const p3 = ot.extractFromUserTurn({ _worker: worker('C', 20) });
    await Promise.all([p1, p2, p3]);
    ok(maxActive === 1, 'never more than ONE extraction in flight (serialized at the root)');
    ok(order.join(',') === 'start:A,end:A,start:B,end:B,start:C,end:C', `strict FIFO order, no interleave (${order.join(',')})`);
    // a throwing extraction must not wedge the lane
    let after = false;
    await ot.extractFromUserTurn({ _worker: () => Promise.reject(new Error('boom')) }).catch(() => {});
    await ot.extractFromUserTurn({ _worker: async () => { after = true; return []; } });
    ok(after === true, 'a failed extraction does not wedge the chain (next one still runs)');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
