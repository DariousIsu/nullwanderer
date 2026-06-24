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
