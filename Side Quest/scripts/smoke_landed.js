/* smoke_landed.js — THE LANDED LEDGER (the wants project, cut 10; 2026-09-05).
 * Pins: the marker net on real shapes (retest the kind: twenty phrasings, positive and negative); the link to
 * the say before his turn; ONE win on the bus per landed line and one row per (turn, kind); the persona lines
 * carry at most three, newest first, and no instruction; an empty ledger yields nothing.
 */
'use strict';
const path = require('path'), os = require('os'), fs = require('fs');
const SQ = process.env.SQ_ROOT || path.join(__dirname, '..');
const LIB = process.env.SQ_MOD_DIR || path.join(SQ, 'lib');
process.env.SQ_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sq_landed_')), 'sq.db');
const db = require(path.join(SQ, 'lib', 'db')); db.init();
const L = require(path.join(LIB, 'landed'));
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── the net ───────────────────────────────────────────────────────────────────────────────────────
const yes = ['lol', 'LOL that is perfect', 'hahaha', 'Haha ok fair', 'lmao', 'that\'s hilarious', 'you made me laugh', 'I\'m dying 😂', '🤣', 'bahahaha no', 'good one', 'ha! true', 'heh heh', 'cracked me up honestly', 'so funny'];
const no = ['what did the legislature do', 'not funny', 'that isn\'t funny at all', 'lolita is a novel', 'hahn was the senator', 'delete the draft', 'ok', 'she laughed at the hearing', 'the funny thing is the budget', 'ha ha very funny, now do it'];
ok(yes.every((s) => L.detectLaugh(s).laugh), `every laugh shape fires (${yes.length})`);
const noHits = no.filter((s) => L.detectLaugh(s).laugh);
ok(noHits.length <= 1 && !noHits.includes('lolita is a novel') && !noHits.includes('not funny') && !noHits.includes('what did the legislature do'), `no false laughs on ordinary or negated turns (${JSON.stringify(noHits)})`);
ok(L.detectLaugh('lol').marker === 'lol' && L.detectLaugh('   HAHAHA!!').marker.toLowerCase().startsWith('haha'), 'the marker is recorded as he wrote it');
ok(!L.detectLaugh('').laugh && !L.detectLaugh(null).laugh, 'empty → no laugh');

// ── the ledger ────────────────────────────────────────────────────────────────────────────────────
const d = db.getDb();
const sRow = db.startSession(); const s = (sRow && sRow.id) || (typeof sRow === 'number' ? sRow : (sRow && sRow.lastInsertRowid)) || 1;
const say1 = db.insertTurn({ sessionId: s, speaker: 'ai_said', content: '<say>Filed under "things that were never going to work".</say>' });
const u1 = db.insertTurn({ sessionId: s, speaker: 'user', content: 'lol' });
const idOf = (t) => (t && t.id) || (typeof t === 'number' ? t : (t && t.lastInsertRowid)) || null;
const events = [], logs = [];
const deps = { db, obsBus: { emit: (e) => events.push(e) }, log: (m) => logs.push(m) };
const r1 = L.tagUserTurn({ userTurnId: idOf(u1), text: 'lol', deps });
ok(r1 && r1.ok && !r1.duplicate && events.length === 1 && events[0].kind === 'win' && events[0].lane === 'landed' && events[0].ref === idOf(say1), 'his laugh tags the say before it and puts ONE win on the bus');
const rows = L.lastLanded(3, { deps });
ok(rows.length === 1 && rows[0].ai_turn_id === idOf(say1) && /never going to work/.test(rows[0].snippet) && !/<say>/.test(rows[0].snippet) && rows[0].source === 'text' && rows[0].marker === 'lol', 'the row links the say, the snippet is the say without tags, the source is text');
const r2 = L.tagUserTurn({ userTurnId: idOf(u1), text: 'lol', deps });
ok(r2 && r2.duplicate && events.length === 1 && L.count({ deps }) === 1, 'the same turn never lands twice (one row, one win)');
ok(L.tagUserTurn({ userTurnId: idOf(u1) + 50, text: 'what time is it', deps }) === null && events.length === 1, 'an ordinary turn records nothing');
const say2 = db.insertTurn({ sessionId: s, speaker: 'ai_said', content: 'Second line.' });
const u2 = db.insertTurn({ sessionId: s, speaker: 'user', content: 'haha ok' });
const say3 = db.insertTurn({ sessionId: s, speaker: 'ai_said', content: 'Third line.' });
const u3 = db.insertTurn({ sessionId: s, speaker: 'user', content: '🤣' });
L.tagUserTurn({ userTurnId: idOf(u2), text: 'haha ok', deps }); L.tagUserTurn({ userTurnId: idOf(u3), text: '🤣', deps });
ok(L.lastLanded(3, { deps }).map((r) => r.ai_turn_id).join() === [idOf(say3), idOf(say2), idOf(say1)].join(), 'lastLanded: newest first, the say before EACH laugh');
const pl = L.personaLines({ deps });
ok(/LINES OF YOURS THAT LANDED/.test(pl) && (pl.match(/^• /gm) || []).length === 3 && /3 so far/.test(pl) && /Third line/.test(pl), 'the persona lines carry at most three, newest first, with the count');
ok(!/\b(be funny|make him laugh|try to|you should|joke)\b/i.test(pl), 'anti-performance: the block is a record of what landed, never an instruction');
const say4 = db.insertTurn({ sessionId: s, speaker: 'ai_said', content: 'Fourth.' }); const u4 = db.insertTurn({ sessionId: s, speaker: 'user', content: 'lmao' });
L.tagUserTurn({ userTurnId: idOf(u4), text: 'lmao', deps });
ok((L.personaLines({ deps }).match(/^• /gm) || []).length === 3 && /4 so far/.test(L.personaLines({ deps })), 'a fourth landed line: still three shown, the count says four');
// an empty ledger (a fresh table) yields nothing
d.prepare(`DELETE FROM ${L.TABLE}`).run();
ok(L.personaLines({ deps }) === null && L.count({ deps }) === 0, 'an empty ledger → no block');
// the face source records with its own source
const r5 = L.record({ userTurnId: null, aiTurnId: idOf(say4), kind: 'laugh', source: 'face', snippet: 'Fourth.', deps });
ok(r5.ok && L.lastLanded(1, { deps })[0].source === 'face' && events[events.length - 1].data.source === 'face', 'a laugh read from the camera records with source=face');
console.log(`\nsmoke_landed: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
