/* Smoke: the `unprompted` column round-trips and the chat.js routing predicates split
 * prompted dialogue from autonomous utterances. Isolated temp DB via SQ_DB_PATH — never
 * touches data/sq.db. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_unprompted.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_unprompted_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
process.env.SQ_DB_PATH = tmp;   // MUST be set before requiring db (DB_PATH is read at require time)
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

try {
  db.init();
  const s = db.startSession();
  db.insertTurn({ sessionId: s, speaker: 'user', content: 'hey' });
  const prompted = db.insertTurn({ sessionId: s, speaker: 'ai_said', content: 'a prompted reply' });
  const unprompted = db.insertTurn({ sessionId: s, speaker: 'ai_said', content: 'a heartbeat musing', unprompted: 1 });
  const thought = db.insertTurn({ sessionId: s, speaker: 'ai_thought', content: 'a private thought' });

  const rows = db.getRecentDisplayTurns(50);
  const byId = new Map(rows.map(r => [r.id, r]));

  console.log('column + round-trip:');
  ok(rows.length && ('unprompted' in rows[0]), 'display rows carry an `unprompted` field');
  ok(byId.get(prompted.id) && byId.get(prompted.id).unprompted === 0, 'prompted reply stored unprompted=0 (default)');
  ok(byId.get(unprompted.id) && byId.get(unprompted.id).unprompted === 1, 'autonomous utterance stored unprompted=1');

  console.log('renderer routing predicates (mirrors loadHistory / loadSheep):');
  const inTranscript = rows.filter(r => r.speaker === 'user' || (r.speaker === 'ai_said' && !r.unprompted));
  ok(inTranscript.some(r => r.id === prompted.id) && !inTranscript.some(r => r.id === unprompted.id),
     'transcript keeps the prompted reply, drops the unprompted one');
  const inSheep = rows.filter(r => r.speaker === 'ai_thought' || (r.speaker === 'ai_said' && r.unprompted));
  ok(inSheep.some(r => r.id === thought.id) && inSheep.some(r => r.id === unprompted.id) && !inSheep.some(r => r.id === prompted.id),
     'sheep gets the thought + unprompted utterance, never the prompted reply');

  // LIVE onComplete GUARD (renderer/chat.js) — mirrors the exact predicate that decides whether a
  // completion is diverted to the sheep panel (returning early WITHOUT touching promptedReplyPending)
  // vs. falls through to finish the user's reply. The bug: a racing idle completion (even a SILENT one)
  // arriving while a reply was pending fell through and reset the reply state, so the real reply then
  // streamed as "unprompted" into the sheep rail. The fix gates on !currentAiTurnDiv, NOT !promptedReplyPending.
  console.log('onComplete routing guard (the shunt fix):');
  const divertsToSheep = (currentAiTurnDiv, unpromptedActive, info) =>
    !currentAiTurnDiv && (unpromptedActive || (info && (info.unprompted || info.silent)));
  // The shunt scenario: reply pending (promptedReplyPending would be true), reply not yet streaming
  // (currentAiTurnDiv null), a racing idle SILENT completion arrives.
  ok(divertsToSheep(null, false, { unprompted: true, silent: true }) === true,
     'racing idle SILENT complete → diverted to sheep (early return), does NOT reset the pending reply');
  ok(divertsToSheep(null, false, { unprompted: true, say: 'a musing' }) === true,
     'racing idle SPEAKING complete → diverted to sheep, pending reply preserved');
  // The tool-result followup IS the reply — by completion it has streamed into the transcript turn.
  ok(divertsToSheep({}, false, { unprompted: true, say: 'the answer' }) === false,
     'tool-result followup (currentAiTurnDiv set) → falls through to finish, NOT shunted');
  // A normal prompted reply completing.
  ok(divertsToSheep({}, false, { truncated: 0 }) === false,
     'normal prompted reply → falls through to finish');
  // A genuine autonomous utterance while nothing is pending still reaches the sheep panel.
  ok(divertsToSheep(null, true, { unprompted: true }) === true,
     'idle utterance with no reply in flight → sheep, as before');
} catch (e) {
  fail++; console.error('  ✗ threw:', e.message);
} finally {
  try { db.getDb().close(); } catch {}
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
