/** Prove Piece 3: (a) the running summary folds recursively + buildBlock surfaces it, and
 *  (b) buildChatPrompt caps <think> replay to the most-recent KEEP_FULL_THINK assistant
 *  turns so older interior stops evicting real dialogue under 8k ctx. Temp DB, no real model
 *  (the summary call is stubbed via the injectable generate fn). */
const os = require('os'), path = require('path'), fs = require('fs');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_cs_${Date.now()}.db`);
const db = require('../lib/db'); db.init();
const cs = require('../lib/convo_state');
const ctx = require('../lib/context');
let pass = 0, fail = 0;
const ok = (n, c) => { (c ? pass++ : fail++); console.log(`  ${c ? '✓' : '✗'} ${n}`); };

(async () => {
  const sid = db.startSession();

  console.log('recursive summary update + buildBlock:');
  ok('no block before any summary', cs.buildBlock(sid, 'Lucas') === null);
  // stub the model: echo that it received the prior summary + the new exchange (proves recursion)
  let sawOld = '';
  const gen = async (messages) => { const u = messages[1].content; sawOld = u; return 'Lucas builds AI personas; we discussed his EVE tools and his daughter.'; };
  await cs.update(sid, 'I build AI personas for a living.', 'That is fascinating, tell me more.', { generate: gen });
  let row = db.getConversationState(sid);
  ok('summary stored after first update', !!(row && /personas/.test(row.summary)));
  ok('turn_count = 0 on first insert', row.turn_count === 0);
  const block = cs.buildBlock(sid, 'Lucas');
  ok('buildBlock surfaces the summary', /WHERE THIS CONVERSATION IS/.test(block) && /personas/.test(block));

  await cs.update(sid, 'My daughter likes the EVE tools too.', 'How sweet.', { generate: gen });
  ok('second update fed the PRIOR summary back in (recursive)', /CURRENT SUMMARY:[\s\S]*personas/.test(sawOld));
  row = db.getConversationState(sid);
  ok('turn_count increments to 1', row.turn_count === 1);

  // --- WATERMARK CATCH-UP (2026-07-20) ------------------------------------------------------
  // The fold used to summarise exactly the (userMsg, aiSay) it was handed, from the ONE main say
  // path — but the chat handler has ~30 early returns that reply and return before reaching it
  // (protocol intercept, preference answer, contacts route, tool followups). Everything they said
  // was never folded: live, session 589 had 247 real turns and turn_count 15, and sessions of
  // 116/88/81 turns had no summary at all. The fold now catches up from a watermark instead.
  console.log('\nwatermark catch-up over turns an early-return path never folded:');
  {
    const sid2 = db.startSession();
    // Simulate exchanges that bypassed the fold entirely — turns land, update() is never called.
    db.insertTurn({ sessionId: sid2, speaker: 'user', content: 'what parishes are left?' });
    db.insertTurn({ sessionId: sid2, speaker: 'ai_said', content: 'nine of sixty-four so far.' });
    db.insertTurn({ sessionId: sid2, speaker: 'user', content: 'disregard the White House as a source' });
    const lastId = db.insertTurn({ sessionId: sid2, speaker: 'ai_said', content: 'noted, dropping it.' }).id;

    let sawExchange = '';
    const gen2 = async (messages) => { sawExchange = messages[1].content; return 'We are on the parish coverage; Lucas dropped the White House as a source.'; };
    await cs.update(sid2, null, null, { generate: gen2 });

    ok('folds turns it was never handed', /parishes are left/.test(sawExchange) && /White House/.test(sawExchange));
    ok('labels a multi-turn catch-up', /EXCHANGES SINCE YOUR LAST NOTE \(4 turns\)/.test(sawExchange));
    const r2 = db.getConversationState(sid2);
    ok('summary written from the catch-up', /parish coverage/.test(r2.summary));
    ok('watermark advanced to the last folded turn', r2.last_turn_id === lastId);

    // second fold with nothing new must be a no-op, not a re-summarise of the same turns
    let called = false;
    await cs.update(sid2, null, null, { generate: async () => { called = true; return 'x'; } });
    ok('nothing unfolded → no model call', called === false);
    ok('summary untouched by the no-op', db.getConversationState(sid2).summary === r2.summary);

    // a new exchange resumes FROM the watermark (does not replay what was already folded)
    db.insertTurn({ sessionId: sid2, speaker: 'user', content: 'BRAND NEW MESSAGE' });
    let sawSecond = '';
    await cs.update(sid2, null, null, { generate: async (m) => { sawSecond = m[1].content; return 'updated notes.'; } });
    ok('resumes from the watermark', /BRAND NEW MESSAGE/.test(sawSecond));
    ok('does NOT replay already-folded turns', !/parishes are left/.test(sawSecond));

    // SAFETY: a failed generate must not advance the watermark, or those turns are lost forever
    const before = db.getConversationState(sid2).last_turn_id;
    db.insertTurn({ sessionId: sid2, speaker: 'user', content: 'this must not be skipped' });
    await cs.update(sid2, null, null, { generate: async () => '' });
    ok('SAFETY: failed fold leaves the watermark alone', db.getConversationState(sid2).last_turn_id === before);
    let retried = '';
    await cs.update(sid2, null, null, { generate: async (m) => { retried = m[1].content; return 'ok now.'; } });
    ok('SAFETY: the skipped turn is retried on the next fold', /must not be skipped/.test(retried));
  }

  console.log('\n<think>-replay cap in buildChatPrompt:');
  // 3 assistant turns (oldest→newest), each with a distinctive thought; KEEP_FULL_THINK=2.
  const recentTurns = [
    { speaker: 'user', content: 'u1' },
    { speaker: 'ai_thought', content: 'THOUGHT_OLDEST' }, { speaker: 'ai_said', content: 'say1' },
    { speaker: 'user', content: 'u2' },
    { speaker: 'ai_thought', content: 'THOUGHT_MIDDLE' }, { speaker: 'ai_said', content: 'say2' },
    { speaker: 'user', content: 'u3' },
    { speaker: 'ai_thought', content: 'THOUGHT_NEWEST' }, { speaker: 'ai_said', content: 'say3' },
  ];
  const msgs = ctx.buildChatPrompt({
    userName: 'Lucas', recentReflections: [], recentTurns, recentMonologue: [], recentReadings: [],
    heldCommitments: [], openThreads: [], awareness: null, protocols: [], browserBlock: null,
    pendingInbounds: [], retrievedKnowledgeBlock: null, capabilityProposalBlock: null,
    selfModelBlock: null, personalBlock: null, relevantPastTurns: [], openQuestionBlock: null,
    socialTurn: false, convoStateBlock: null, echoSuitBlock: null, newUserMessage: 'u4'
  });
  const asst = msgs.filter(m => m.role === 'assistant');
  ok('3 assistant messages rendered', asst.length === 3);
  ok('oldest assistant DROPS its <think>', !/THOUGHT_OLDEST/.test(asst[0].content) && /say1/.test(asst[0].content));
  ok('middle assistant KEEPS its <think>', /THOUGHT_MIDDLE/.test(asst[1].content));
  ok('newest assistant KEEPS its <think>', /THOUGHT_NEWEST/.test(asst[2].content));
  ok('every assistant still carries its <say>', asst.every((m, k) => m.content.includes(`say${k + 1}`)));

  db.getDb().close();
  try { for (const e of ['', '-wal', '-shm']) fs.existsSync(process.env.SQ_DB_PATH + e) && fs.unlinkSync(process.env.SQ_DB_PATH + e); } catch {}
  console.log(`\n${fail === 0 ? 'CONVO-STATE OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
