/* Post-op runtime audit: exercises the integration paths this session's edits touched that the
 * unit smokes DON'T cover — module loads, context assembly, the awareness anchor, and the
 * no-`qv` retrieveScored path the main.js fix now uses in production. Catches load/call-time
 * throws (the TDZ/undefined-ref class). Isolated temp DB.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/audit_postop.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const tmp = path.join(os.tmpdir(), `sq_postop_${process.pid}.db`);
process.env.SQ_DB_PATH = tmp;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  try {
    console.log('module loads (catches load-time throws):');
    const mods = ['db', 'memory', 'ollama', 'email', 'context', 'cloud_curator', 'continuity', 'heartbeat', 'graph_memory'];
    for (const m of mods) { try { require('C:/Users/azrae/Desktop/Side Quest/lib/' + m); ok(true, `lib/${m} loads`); } catch (e) { ok(false, `lib/${m} THREW: ${e.message}`); } }

    const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
    const memory = require('C:/Users/azrae/Desktop/Side Quest/lib/memory');
    const context = require('C:/Users/azrae/Desktop/Side Quest/lib/context');
    db.init();

    console.log('\nretrieveScored WITHOUT qv (the production path after the TDZ fix — embeds internally):');
    db.insertKnowledge({ kind: 'note', content: 'Sea otters wrap themselves in kelp while they sleep.', source: 'reflection_knowledge', embedding: JSON.stringify(await memory.embed('Sea otters wrap themselves in kelp while they sleep.')) });
    db.insertKnowledge({ kind: 'note', content: 'The Maastricht Treaty set EU convergence criteria in 1992.', source: 'reflection_knowledge', embedding: JSON.stringify(await memory.embed('The Maastricht Treaty set EU convergence criteria in 1992.')) });
    let threw = false, res = null;
    try { res = await memory.retrieveScored('tell me about sea otters and kelp', { k: 6, minRelevance: 0.35 }); } catch (e) { threw = true; console.log('   threw:', e.message); }
    ok(!threw, 'no-qv retrieveScored does not throw (embeds the query itself)');
    ok(Array.isArray(res), 'returns an array');
    ok(res && res.length >= 1 && /otter/i.test(res[0].content), 'floor keeps the relevant note as top hit');

    console.log('\nawareness block carries the temporal anchor:');
    const aware = context.buildAwarenessBlock({ chosenName: 'Zoe' });
    ok(/FROZEN[\s\S]*out of date/i.test(aware), 'stale-knowledge anchor present');
    ok(/never assert a current officeholder/i.test(aware), 'officeholder clause present');

    console.log('\nbuildChatPrompt assembles without throwing (with empty/minimal blocks):');
    let cpThrew = false, msgs = null;
    try {
      msgs = context.buildChatPrompt({
        userName: 'Lucas', recentReflections: [], recentTurns: [], recentMonologue: [], recentReadings: [],
        heldCommitments: [], openThreads: [], awareness: aware, protocols: [], browserBlock: null,
        pendingInbounds: [], retrievedKnowledgeBlock: null, capabilityProposalBlock: null, selfModelBlock: null,
        personalBlock: null, relevantPastTurns: [], openQuestionBlock: null, socialTurn: false,
        convoStateBlock: null, varietyNudge: null, echoSuitBlock: null, newUserMessage: 'hey'
      });
    } catch (e) { cpThrew = true; console.log('   threw:', e.message); }
    ok(!cpThrew, 'buildChatPrompt did not throw');
    ok(Array.isArray(msgs) && msgs.length >= 1, 'returns a messages array');
    ok(msgs && JSON.stringify(msgs).includes('hey'), 'the user message made it into the prompt');
  } catch (e) {
    fail++; console.error('  ✗ audit threw:', e.stack || e.message);
  } finally {
    try { require('C:/Users/azrae/Desktop/Side Quest/lib/db').getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
