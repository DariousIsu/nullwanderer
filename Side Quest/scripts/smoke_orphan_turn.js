/* smoke_orphan_turn.js — THE ORPHANED TURN (cut 24, 2026-09-04): a message of his that the previous
 * generation died on is found at boot and served through the one chat door. Hermetic temp sq.db.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_orphan_turn.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
process.env.SQ_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-smoke-')), 'sq.db');
const db = require('../lib/db'); db.init();
const ot = require('../lib/orphan_turn');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const NOW = Date.now();
const d = db.getDb();
const sid1 = db.startSession();

ok(ot.findOrphanedTurn(db, { now: NOW }) === null, 'an empty store has no orphan');
const u1 = db.insertTurn({ sessionId: sid1, speaker: 'user', content: "I'll review the florida list in the morning, if you want to double check it" });
const o1 = ot.findOrphanedTurn(db, { now: NOW + 40000 });
ok(!!o1 && o1.id === u1.id && o1.session_id === sid1, '⭐ his newest turn with no reply after it in its session is the orphan (the 02:30 shape)');
ok(/40s old/.test(ot.describe(o1, NOW + 40000)) && /florida list/.test(ot.describe(o1, NOW + 40000)), 'describe() names the age, the session and his words');
// a reply in ANOTHER session (the new generation's) does not answer it — the check is per session, like the test port's
const sid2 = db.startSession();
db.insertTurn({ sessionId: sid2, speaker: 'ai_said', content: 'an unprompted line in the new session', unprompted: 1 });
ok(!!ot.findOrphanedTurn(db, { now: NOW + 60000 }), "a reply in a DIFFERENT session does not answer his turn (the check is per session, the test port's rule)");
// her reply in ITS session answers it
db.insertTurn({ sessionId: sid1, speaker: 'ai_said', content: 'Will do — I will double-check the roster before you wake.' });
ok(ot.findOrphanedTurn(db, { now: NOW + 90000 }) === null, 'a reply after it in its own session → no orphan');
// too old: not re-answered as if new. Only the NEWEST user turn can be an orphan, so the whole store is
// aged seven hours: his newest (unanswered, sid2) is then 7 h old.
const u2 = db.insertTurn({ sessionId: sid2, speaker: 'user', content: 'a message from yesterday' });
d.prepare('UPDATE turns SET ts = ts - ?').run(7 * 3600 * 1000);
ok(ot.findOrphanedTurn(db, { now: NOW + 5000 }) === null, 'an unanswered turn older than 6 h is not an orphan (he has moved on)');
ok((ot.findOrphanedTurn(db, { now: NOW + 5000, maxAgeMs: 8 * 3600 * 1000 }) || {}).id === u2.id, '…the window is a parameter (8 h finds it)');
// an ai_thought does not answer (only ai_said does)
const u3 = db.insertTurn({ sessionId: sid2, speaker: 'user', content: 'are you there?' });
d.prepare('UPDATE turns SET ts = ts - 2000 WHERE id = ?').run(u3.id);   // two seconds before the rows below (same-millisecond inserts would share a window)
db.insertTurn({ sessionId: sid2, speaker: 'ai_thought', content: 'thinking about it' });
ok(ot.findOrphanedTurn(db, { now: NOW + 1000 }).id === u3.id, "an ai_thought after his turn is not an answer — only ai_said is");
// an injected test-port turn is never his
const u4 = db.insertTurn({ sessionId: sid2, speaker: 'user', content: 'injected by the harness' });
const win = { a: u4.ts - 1, b: u4.ts + 1 };
ok(ot.findOrphanedTurn(db, { now: NOW + 2000, injectedWindows: [win] }).id === u3.id, "an injected (test-port) turn is skipped — the orphan is his real newest turn");
// a blank turn is not an orphan
db.insertTurn({ sessionId: sid2, speaker: 'user', content: '   ' });
ok(ot.findOrphanedTurn(db, { now: NOW + 3000 }) === null, 'a blank newest turn is nothing to answer');
// the wiring in main.js
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/async function serveChatTurn\(sender, userMessage, attachments = \[\], extra = \{\}\)/.test(src) && /ipcMain\.handle\('chat:send', async \(event, userMessage, attachments = \[\]\) => serveChatTurn\(event\.sender, userMessage, attachments\)\);/.test(src), 'the renderer\'s chat:send and the re-drive share ONE chat door (serveChatTurn)');
ok(/serveChatTurn\(mainWindow\.webContents, String\(t\.content \|\| ''\), \[\], \{ reuseTurnId: t\.id, sessionIdOverride: t\.session_id \}\)/.test(src), '⭐ the re-drive serves the SAME row under ITS session — never a duplicate of his words');
ok(/const sessionId = \(io && io\.sessionIdOverride\) \|\| currentSessionId;/.test(src) && /io\.reuseTurnId\)\s*\n\s*\? \(db\.getDb\(\)\.prepare\('SELECT \* FROM turns WHERE id = \?'\)\.get\(io\.reuseTurnId\)/.test(src), 'runChatTurn honors reuseTurnId and sessionIdOverride');
ok(/setTimeout\(\(\) => _answerOrphanedTurn\('boot\+20s'\)/.test(src) && /setTimeout\(\(\) => _answerOrphanedTurn\('boot\+90s'\)/.test(src), 'the re-drive is scheduled at boot+20 s and boot+90 s (the second catches a window that was not up yet)');
ok(!/event\.sender\.send\('chat:say-token'/.test(src), 'no stray event.sender left in the chat door');

console.log(`\nsmoke_orphan_turn: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
