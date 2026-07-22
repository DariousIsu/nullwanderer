/* Smoke: lib/conversation_objects — conversations become OBJECTS (memory slice 1A). Deterministic:
 * pure window logic + a pass() driven by an injected fake db/land. No model/network/live db.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_conversation_objects.js
 */
'use strict';
const co = require('../lib/conversation_objects');
const promote = require('../lib/promote');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 6, 21, 18, 15);   // Tue Jul 21 2026, 2:15 PM EDT — a fixed summer instant
const turn = (id, ts, speaker, content) => ({ id, session_id: 1, ts, speaker, content });

(async () => {
  // --- findClosedWindows: gap split + open tail held back ---
  const turns = [
    turn(1, T0, 'user', 'how is your day going?'),
    turn(2, T0 + 1 * MIN, 'ai_said', 'Pretty good — I filed the Bloomberg notes this morning and lined up the follow-ups.'),
    turn(3, T0 + 60 * MIN, 'user', 'what did we decide about the op-ed?'),          // 59-min gap → new window
    turn(4, T0 + 61 * MIN, 'ai_said', 'You wanted the shorter lede and the July numbers.'),
    turn(5, T0 + 200 * MIN, 'user', 'still there?'),                                 // open tail
  ];
  const now = T0 + 210 * MIN;   // tail is 10 min old — still open
  const wins = co.findClosedWindows(turns, { nowMs: now });
  ok(wins.length === 2, 'two gap-delimited windows close; the fresh tail stays open');
  ok(wins[0].turns.length === 2 && wins[1].turns.length === 2, 'each window holds its own turns');
  const winsLater = co.findClosedWindows(turns, { nowMs: T0 + 260 * MIN });
  ok(winsLater.length === 3, 'once the silence passes the gap, the tail window closes too');

  // --- thoughts never enter the shared record (not content, not gap timing) ---
  const withThought = co.findClosedWindows([
    turn(1, T0, 'user', 'hey'),
    turn(2, T0 + 50 * MIN, 'ai_thought', 'private musing that would bridge the gap'),
    turn(3, T0 + 100 * MIN, 'user', 'back now'),
  ], { nowMs: T0 + 300 * MIN });
  ok(withThought.length === 2 && withThought.every(w => w.turns.every(t => t.speaker !== 'ai_thought')),
    'ai_thought is excluded — a thought neither joins the transcript nor bridges a silence');

  // --- worthLanding gates ---
  ok(co.worthLanding(wins[0]), 'a real exchange is worth landing');
  ok(!co.worthLanding({ turns: [turn(9, T0, 'ai_said', 'unprompted announce with no reply, long enough to pass the char floor easily')] }),
    'a lone announce with no user reply is NOT a conversation');
  ok(!co.worthLanding({ turns: [turn(9, T0, 'user', 'hi'), turn(10, T0 + MIN, 'ai_said', 'hey')] }),
    'a "hi"/"hey" blip is below the char floor');

  // --- ref + render ---
  ok(co.refFor(wins[0]) === 'conversation-1-2', 'ref is the stable turn-id span');
  const r = co.renderConversation(wins[0]);
  ok(/^Conversation — /.test(r.title) && /Jul 21/.test(r.title), 'title carries the Eastern date');
  ok(/"how is your day going\?/.test(r.title), 'title carries the opening line (the recall handle)');
  ok(/\*\*Lucas:\*\* how is your day going\?/.test(r.body) && /\*\*Zoe:\*\* Pretty good/.test(r.body), 'body is a speaker-labeled transcript');
  ok(/2 turns/.test(r.body) && /E[DS]T/.test(r.body), 'body header carries turn count + zone label');
  const longOpen = co.renderConversation({ turns: [turn(1, T0, 'user', 'x'.repeat(90)), turn(2, T0 + MIN, 'ai_said', 'ok')], firstTs: T0, lastTs: T0 + MIN });
  ok(/…"/.test(longOpen.title) && longOpen.title.length < 140, 'a long opening line is ellipsized in the title');

  // --- pass(): fake db + land ---
  function fakeDb(rows) {
    const meta = new Map();
    return {
      meta,
      getMeta: (k) => (meta.has(k) ? meta.get(k) : null),
      setMeta: (k, v) => meta.set(k, String(v)),
      turnsAfter: (after, limit) => rows.filter(t => t.id > after && (t.speaker === 'user' || t.speaker === 'ai_said')).slice(0, limit),
    };
  }
  const landCalls = [];
  let nextId = 100;
  const goodLand = (doc) => { landCalls.push(doc); return { id: nextId++, landed: true }; };

  const db1 = fakeDb(turns);
  const p1 = co.pass({ deps: { db: db1, land: goodLand }, nowMs: now });
  ok(p1.landed === 2 && !p1.halted, 'pass lands both closed windows');
  ok(db1.meta.get(co.WATERMARK_KEY) === '4', 'watermark advances to the last closed turn — the open tail is not consumed');
  ok(landCalls.every(d => d.source === 'conversation' && /^conversation-\d+-\d+$/.test(d.ref)), 'landed docs carry source + idempotency ref');

  const p1b = co.pass({ deps: { db: db1, land: goodLand }, nowMs: now });
  ok(p1b.landed === 0 && p1b.windows === 0, 'second pass past the watermark finds nothing new');

  // duplicates advance; failures halt WITHOUT advancing
  const db2 = fakeDb(turns);
  const p2 = co.pass({ deps: { db: db2, land: () => ({ id: 55, landed: false, duplicateOf: 55 }) }, nowMs: now });
  ok(p2.duplicates === 2 && db2.meta.get(co.WATERMARK_KEY) === '4', 'already-landed windows count as duplicates and still advance');
  const db3 = fakeDb(turns);
  const p3 = co.pass({ deps: { db: db3, land: () => ({ id: null, landed: false }) }, nowMs: now });
  ok(p3.halted && p3.landed === 0 && !db3.meta.has(co.WATERMARK_KEY), 'a landing FAILURE halts before advancing — the window is never lost');

  // maxLand paces without losing the rest
  const db4 = fakeDb(turns);
  const p4 = co.pass({ deps: { db: db4, land: goodLand }, maxLand: 1, nowMs: now });
  ok(p4.landed === 1 && db4.meta.get(co.WATERMARK_KEY) === '2', 'maxLand stops after one window; the next pass resumes at the boundary');

  // a truncated scan drops its final window (it may be half a conversation)
  const db5 = fakeDb(turns);
  const p5 = co.pass({ deps: { db: db5, land: goodLand }, scanLimit: 4, nowMs: now });
  ok(p5.landed === 1 && db5.meta.get(co.WATERMARK_KEY) === '2', 'scan-limit cut → the last window is held whole for the next pass');

  // a not-worth window between real ones is skipped but consumed
  const mixed = [
    turn(1, T0, 'user', 'morning — can you check the calendar for the Teams call?'),
    turn(2, T0 + MIN, 'ai_said', 'Thursday 2 PM with the Rainey folks.'),
    turn(3, T0 + 120 * MIN, 'ai_said', 'unprompted note, no reply came'),
    turn(4, T0 + 240 * MIN, 'user', 'ok new topic: the paper outline please, with the sections we discussed'),
    turn(5, T0 + 241 * MIN, 'ai_said', 'Outline: thesis, harness evidence, hardware curve, conclusion.'),
  ];
  const db6 = fakeDb(mixed);
  const p6 = co.pass({ deps: { db: db6, land: goodLand }, nowMs: T0 + 400 * MIN });
  ok(p6.landed === 2 && p6.skipped === 1 && db6.meta.get(co.WATERMARK_KEY) === '5', 'unworthy window is skipped, not landed — and the pass moves on');

  // --- promotion recipe routes the new source ---
  ok(promote.recipeFor({ source: 'conversation' }).kind === 'conversation', "source 'conversation' → the save_conversation recipe");
  ok(promote.recipeFor({ source: 'research' }).kind === 'deliverable' && promote.recipeFor({ source: 'canvas_drop' }).kind === 'document',
    'existing sources keep their recipes (no regression)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
